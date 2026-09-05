/**
 * Streaming Tool Executor for Franklin.
 * Starts executing concurrent-safe tools while the model is still streaming.
 * Non-concurrent tools wait until the full response is received.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilityHandler,
  CapabilityInvocation,
  CapabilityResult,
  ExecutionScope,
} from './types.js';
import type { PermissionManager } from './permissions.js';
import { recordFailure } from '../stats/failures.js';
import type { SessionToolGuard } from './tool-guard.js';
import type { HookEngine } from '../hooks/runner.js';
import type { HookInput } from '../hooks/types.js';
import { estimateSpendUsd, isSpendTool } from '../tools/spend-tools.js';
import { BLOCKRUN_DIR } from '../config.js';
import { redactSecretsInOutput } from './secret-redact.js';
import { resolvePayMode } from '../payments/auth-mode.js';
import { logger } from '../logger.js';

interface PendingTool {
  invocation: CapabilityInvocation;
  promise: Promise<CapabilityResult>;
}

/** Persist a large tool result to disk and return a preview string. */
const PERSIST_THRESHOLD = 50_000;
const PREVIEW_SIZE = 2_000;

function persistLargeResult(sessionId: string, toolUseId: string, output: string): string {
  const dir = join(BLOCKRUN_DIR, 'tool-results', sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${toolUseId}.txt`);
    writeFileSync(filePath, output, { flag: 'wx' }); // write-once (skip if exists)

    // Generate preview — truncate at line boundary for clean output
    let preview = output.slice(0, PREVIEW_SIZE);
    const lastNl = preview.lastIndexOf('\n');
    if (lastNl > PREVIEW_SIZE * 0.5) {
      preview = preview.slice(0, lastNl);
    }

    return `<persisted-output>\nOutput too large (${(output.length / 1024).toFixed(1)}KB). Full output saved to: ${filePath}\n\nPreview (first ${PREVIEW_SIZE / 1000}KB):\n${preview}\n...\n</persisted-output>`;
  } catch {
    // Fallback: simple truncation if disk write fails
    return output.slice(0, PERSIST_THRESHOLD) +
      `\n\n[Truncated: original was ${output.length.toLocaleString()} chars]`;
  }
}

export class StreamingExecutor {
  private handlers: Map<string, CapabilityHandler>;
  private scope: ExecutionScope;
  private permissions?: PermissionManager;
  private guard?: SessionToolGuard;
  private hooks?: HookEngine;
  private onStart: (id: string, name: string, preview?: string) => void;
  private onProgress?: (id: string, text: string) => void;
  private pending: PendingTool[] = [];
  private sessionId: string;

  constructor(opts: {
    handlers: Map<string, CapabilityHandler>;
    scope: ExecutionScope;
    permissions?: PermissionManager;
    guard?: SessionToolGuard;
    hooks?: HookEngine;
    onStart: (id: string, name: string, preview?: string) => void;
    onProgress?: (id: string, text: string) => void;
    sessionId?: string;
  }) {
    this.handlers = opts.handlers;
    this.scope = opts.scope;
    this.permissions = opts.permissions;
    this.guard = opts.guard;
    this.hooks = opts.hooks;
    this.onStart = opts.onStart;
    this.onProgress = opts.onProgress;
    this.sessionId = opts.sessionId || 'default';
  }

  private hookInput(invocation: CapabilityInvocation, event: HookInput['hookEventName']): HookInput {
    const base: HookInput = {
      hookEventName: event,
      sessionId: this.sessionId,
      cwd: this.scope.workingDir,
      timestamp: new Date().toISOString(),
      toolName: invocation.name,
      toolInput: invocation.input,
    };
    if (event === 'PreSpend' || event === 'PostSpend') {
      base.spend = {
        estimatedUsd: estimateSpendUsd(invocation.name, invocation.input),
        tool: invocation.name,
        params: invocation.input,
      };
    }
    return base;
  }

  /**
   * Called when a tool_use block is fully received from the stream.
   * If the tool is concurrent-safe, start executing immediately.
   * Otherwise, queue it for later.
   */
  onToolReceived(invocation: CapabilityInvocation): void {
    const handler = this.handlers.get(invocation.name);
    // Dynamic concurrency check (e.g., Bash is concurrent only for read-only commands)
    const isConcurrent = handler?.isConcurrentSafe
      ? handler.isConcurrentSafe(invocation.input)
      : (handler?.concurrent ?? false);

    if (isConcurrent) {
      // Concurrent tools are auto-allowed — start immediately and time from here
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
      const promise = this.executeWithPermissions(invocation, 1, false);
      this.pending.push({ invocation, promise });
    }
    // Non-concurrent tools are NOT started here — executed via collectResults
  }

  /**
   * After the model finishes streaming, execute any non-concurrent tools
   * and collect all results (including concurrent ones that may already be done).
   */
  async collectResults(
    allInvocations: CapabilityInvocation[]
  ): Promise<[CapabilityInvocation, CapabilityResult][]> {
    const results: [CapabilityInvocation, CapabilityResult][] = [];
    const alreadyStarted = new Set(this.pending.map(p => p.invocation.id));
    const pendingSnapshot = [...this.pending];
    this.pending = []; // Clear immediately so errors don't leave stale state

    // Pre-count pending sequential invocations per tool type.
    // Shown in permission dialog: "N pending — press [a] to allow all".
    const pendingCounts: Map<string, number> = new Map();
    for (const inv of allInvocations) {
      if (!alreadyStarted.has(inv.id)) {
        pendingCounts.set(inv.name, (pendingCounts.get(inv.name) || 0) + 1);
      }
    }
    const remainingCounts = new Map(pendingCounts);

    try {
      // Wait for concurrent results that were started during streaming
      for (const p of pendingSnapshot) {
        const result = await p.promise;
        results.push([p.invocation, result]);
      }

      // Execute sequential (non-concurrent) tools now
      for (const inv of allInvocations) {
        if (alreadyStarted.has(inv.id)) continue;

        const remaining = remainingCounts.get(inv.name) ?? 1;
        remainingCounts.set(inv.name, remaining - 1);

        // NOTE: onStart is called INSIDE executeWithPermissions, AFTER permission is granted.
        // This ensures elapsed time reflects actual execution time, not permission wait time.
        const result = await this.executeWithPermissions(inv, remaining, true);
        results.push([inv, result]);
      }
    } catch (err) {
      // Return partial results rather than losing them; caller handles errors
      throw err;
    }

    return results;
  }

  private async executeWithPermissions(
    invocation: CapabilityInvocation,
    pendingCount = 1,
    callStart = true  // false for concurrent tools (already called in onToolReceived)
  ): Promise<CapabilityResult> {
    // Canonicalize the tool name and normalize schema-typed values before any
    // hook, guard, or permission boundary. Otherwise an alias such as
    // `detach` or a boolean-like value such as `confirm: "true"` could be
    // authorized under a different shape than the handler later executes.
    let handler = this.handlers.get(invocation.name);
    if (!handler) {
      const attempted = invocation.name;
      const lower = attempted.toLowerCase();
      for (const [name, candidate] of this.handlers) {
        if (name.toLowerCase() === lower || name.toLowerCase().replace(/[-_ ]/g, '') === lower.replace(/[-_ ]/g, '')) {
          handler = candidate;
          invocation = { ...invocation, name };
          break;
        }
      }
      if (!handler) {
        this.guard?.cancelInvocation(invocation.id);
        const available = [...this.handlers.keys()].join(', ');
        return {
          output: `Unknown tool "${attempted}". Available tools: ${available}. Check spelling and try again.`,
          isError: true,
        };
      }
    }

    const schema = handler.spec.input_schema;
    if (schema?.properties) {
      for (const [key, value] of Object.entries(invocation.input)) {
        if (value == null) continue;
        const prop = schema.properties[key] as { type?: string } | undefined;
        if (!prop?.type) continue;
        if (prop.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
          invocation.input[key] = Number(value);
        } else if (prop.type === 'boolean' && typeof value === 'string') {
          if (value === 'true') invocation.input[key] = true;
          else if (value === 'false') invocation.input[key] = false;
        }
      }
    }
    if (schema?.required) {
      for (const field of schema.required) {
        if (invocation.input[field] === undefined || invocation.input[field] === null) {
          const desc = (schema.properties?.[field] as { description?: string } | undefined)?.description || '';
          return {
            output: `Error: missing required parameter "${field}" for ${handler.spec.name}. ${desc}`,
            isError: true,
          };
        }
      }
    }

    // User hooks fire first — before built-in policy — so an explicit deny
    // is reported with the hook's own reason rather than a generic one.
    if (this.hooks?.hasHooks('PreToolUse')) {
      const decision = await this.hooks.dispatch('PreToolUse', this.hookInput(invocation, 'PreToolUse'));
      if (decision.decision === 'deny') {
        this.guard?.cancelInvocation(invocation.id);
        return {
          output: `Blocked by a user hook: ${decision.reason || 'denied'}. Do not retry the same call — explain to the user what you were trying to do and ask how they'd like to proceed.`,
          isError: true,
        };
      }
    }

    const guardResult = this.guard
      ? await this.guard.beforeExecute(invocation, this.scope)
      : null;
    if (guardResult) {
      return guardResult;
    }

    // Permission check
    if (this.permissions) {
      const decision = await this.permissions.check(invocation.name, invocation.input);
      if (decision.behavior === 'deny') {
        this.guard?.cancelInvocation(invocation.id);
        return {
          output: `Permission denied for ${invocation.name}: ${decision.reason || 'denied by policy'}. Do not retry — explain to the user what you were trying to do and ask how they'd like to proceed.`,
          isError: true,
        };
      }
      if (decision.behavior === 'ask') {
        const allowed = await this.permissions.promptUser(invocation.name, invocation.input, pendingCount);
        if (!allowed) {
          this.guard?.cancelInvocation(invocation.id);
          return {
            output: `User denied permission for ${invocation.name}. Do not retry — ask the user what they'd like to do instead.`,
            isError: true,
          };
        }
      }
    }

    // Start timing AFTER permission is granted (accurate elapsed time)
    if (callStart) {
      const preview = this.inputPreview(invocation);
      this.onStart(invocation.id, invocation.name, preview);
    }

    // Wire per-invocation progress to onProgress callback
    const progressScope: ExecutionScope = this.onProgress
      ? {
          ...this.scope,
          onProgress: (text: string) => this.onProgress!(invocation.id, text),
        }
      : this.scope;

    try {
      // Track elapsed for slow-tool forensics. Verified 2026-05-04
      // from a real session: a 337.6s Bash error left no trace in
      // franklin-debug.log — the user could see the ✗ in the UI but
      // had no post-hoc way to ask "which Bash took 5+ minutes
      // yesterday and what did it run". 30s threshold is conservative
      // (Read/Glob/Grep finish in <1s; only network or shell work
      // crosses).
      // Spend gate: fires only for tools that move real money. Blocking, so a
      // user hook (spend cap, asset blacklist) can veto before funds move.
      if (isSpendTool(invocation.name) && this.hooks?.hasHooks('PreSpend')) {
        const decision = await this.hooks.dispatch('PreSpend', this.hookInput(invocation, 'PreSpend'));
        if (decision.decision === 'deny') {
          this.guard?.cancelInvocation(invocation.id);
          return {
            output: `Spend blocked by a user hook: ${decision.reason || 'denied'}. Do not retry the same call — explain what you were trying to spend and ask the user how to proceed.`,
            isError: true,
          };
        }
      }

      const execStart = Date.now();
      let result = await handler.execute(invocation.input, progressScope);
      this.guard?.afterExecute(invocation, result);

      // Notify-only hooks — never block, never delay the result.
      if (this.hooks?.hasHooks('PostToolUse')) {
        void this.hooks.dispatch('PostToolUse', this.hookInput(invocation, 'PostToolUse')).catch(() => {});
      }
      if (!result.isError && isSpendTool(invocation.name) && this.hooks?.hasHooks('PostSpend')) {
        void this.hooks.dispatch('PostSpend', this.hookInput(invocation, 'PostSpend')).catch(() => {});
      }

      const execElapsed = Date.now() - execStart;
      if (execElapsed >= 30_000) {
        const status = result.isError ? 'error' : 'ok';
        // Single-line the preview before logging. Bash invocations like
        // `python3 -c "<heredoc>"` carry embedded newlines that, sliced
        // raw, break the one-line-per-entry contract of
        // franklin-debug.log and shred any parser that splits on
        // `^\[timestamp\]`. Verified 2026-05-04 (and reviewed again
        // 2026-05-12): a real entry produced
        //   `Slow tool: Bash ok after 438.4s — cd ... python3 -c "`
        //   `import subprocess`
        //   `[2026-05-04T19:25:10] [ERROR] Signature-loop hard stop ...`
        // where "import subprocess" sat on its own line, untimestamped,
        // because the preview's first 80 chars contained the heredoc
        // opener.
        const preview = (this.inputPreview(invocation) || '').replace(/[\r\n]+/g, ' ');
        logger.info(`[franklin] Slow tool: ${invocation.name} ${status} after ${(execElapsed / 1000).toFixed(1)}s${preview ? ` — ${preview.slice(0, 80)}` : ''}`);
      }

      // Scrub credentials before the output goes anywhere. This is the one
      // funnel every tool result passes through, and it runs BEFORE the
      // persist-to-disk branch below so a redacted body is what reaches the
      // model, the transcript, and the on-disk overflow file alike.
      //
      // resolvePayMode() is memoised per process, so reading the configured
      // key here costs nothing per tool call.
      const payMode = resolvePayMode();
      const redacted = redactSecretsInOutput(
        result.output,
        payMode.kind === 'key' ? [payMode.key] : [],
      );
      if (redacted.labels.length > 0) {
        logger.warn(`[franklin] Redacted ${redacted.labels.join(', ')} from ${invocation.name} output`);
        result = { ...result, output: redacted.text };
      }

      // Persist large results to disk with preview.
      // Instead of just truncating, save the full result to disk so it can be re-read later.
      if (result.output.length > PERSIST_THRESHOLD) {
        result = {
          output: persistLargeResult(this.sessionId, invocation.id, result.output),
          isError: result.isError,
        };
      }

      return result;
    } catch (err) {
      this.guard?.cancelInvocation(invocation.id);
      const errMsg = (err as Error).message;
      recordFailure({
        timestamp: Date.now(),
        model: '', // not available at tool level
        failureType: 'tool_error',
        toolName: invocation.name,
        errorMessage: errMsg,
      });
      // Always log thrown tool errors. Pre-3.15.32 these went only to
      // failures.jsonl (which the user rarely opens) and were absent
      // from franklin-debug.log entirely. Now `franklin logs` shows
      // them alongside everything else.
      const preview = this.inputPreview(invocation) || '';
      logger.warn(`[franklin] Tool error: ${invocation.name} threw "${errMsg.slice(0, 120)}"${preview ? ` — ${preview.slice(0, 80)}` : ''}`);
      return {
        output: `Error executing ${invocation.name}: ${errMsg}`,
        isError: true,
      };
      }
  }

  /** Extract a short preview string from a tool invocation's input. */
  private inputPreview(invocation: CapabilityInvocation): string | undefined {
    const input = invocation.input;
    switch (invocation.name) {
      case 'Bash': {
        const cmd = (input.command as string) || '';
        return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
      }
      case 'Write':
      case 'Read':
      case 'Edit':
        return (input.file_path as string) || undefined;
      case 'Grep':
        return (input.pattern as string) || undefined;
      case 'Glob':
        return (input.pattern as string) || undefined;
      case 'WebFetch':
      case 'WebSearch':
        return ((input.url ?? input.query) as string) || undefined;
      default: {
        // Generic fallback so EVERY tool shows what it's doing. For enum/router
        // tools (e.g. Surf*) the `endpoint` is the real action — show it, paired
        // with the most relevant param, e.g. "market/etf · BTC". Otherwise pick
        // the single most meaningful argument.
        const PARAM_KEYS = [
          'query', 'q', 'search', 'prompt', 'question', 'text',
          'symbol', 'pair', 'metric', 'indicator', 'ticker', 'coin', 'asset', 'market',
          'protocol', 'handle', 'chain', 'address', 'addresses', 'hash', 'conditionId',
          'url', 'id', 'slug', 'name', 'path', 'pattern', 'to', 'number',
        ];
        const firstParam = (): string => {
          for (const k of PARAM_KEYS) {
            const v = input[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
          return '';
        };
        // The "action" field (endpoint / action) is the real verb — show it even
        // when there's no param (e.g. PredictionMarket `leaderboard`).
        const action =
          (typeof input.endpoint === 'string' && input.endpoint.trim()) ||
          (typeof input.action === 'string' && input.action.trim()) || '';
        const combined = [action, firstParam()].filter(Boolean).join(' · ');
        if (!combined) return undefined;
        return combined.length > 80 ? combined.slice(0, 80) + '…' : combined;
      }
    }
  }
}
