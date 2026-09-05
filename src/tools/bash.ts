/**
 * Bash capability — execute shell commands with timeout and output capture.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';

// ─── Smart Output Compression ─────────────────────────────────────────────
// Learned from RTK (Rust Token Killer): strip noise before sending to LLM.
// Applied after capture, before the 32KB cap — reduces tokens on verbose commands.

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function collapseBlankLines(s: string): string {
  // Collapse 3+ consecutive blank lines → 1 blank line
  return s.replace(/\n{3,}/g, '\n\n');
}

/** Extract the base command word (first non-env token). */
function baseCmd(command: string): string {
  // Strip leading env var assignments (FOO=bar cmd → cmd)
  const stripped = command.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, '').trimStart();
  return stripped.split(/\s+/)[0] ?? '';
}

function compressOutput(command: string, output: string): string {
  // 1. Always strip ANSI escape codes
  let out = stripAnsi(output);

  const cmd = baseCmd(command);
  const fullCmd = command.trimStart();

  // 2. Git command-aware compression
  if (cmd === 'git') {
    const sub = fullCmd.split(/\s+/)[1] ?? '';
    out = compressGit(sub, out);
  }
  // 3. Package manager installs — keep only errors + final summary
  else if (/^(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/.test(fullCmd)) {
    out = compressInstall(out);
  }
  // 4. Test runners — keep only failures + summary line
  else if (/^(npm|pnpm|bun)\s+test\b|^(jest|vitest|mocha)\b/.test(fullCmd)) {
    out = compressTests(out);
  }
  // 5. Build commands — keep errors/warnings, drop verbose compile lines
  else if (/^(npm|pnpm|bun)\s+(run\s+)?(build|compile)\b|^tsc\b/.test(fullCmd)) {
    out = compressBuild(out);
  }
  // 6. cargo
  else if (cmd === 'cargo') {
    const sub = fullCmd.split(/\s+/)[1] ?? '';
    if (sub === 'test' || sub === 'nextest') out = compressTests(out);
    else if (sub === 'build' || sub === 'check' || sub === 'clippy') out = compressBuild(out);
    else if (sub === 'install') out = compressInstall(out);
  }
  // 7. Python — pip install, pytest, python scripts
  else if (/^(pip|pip3)\s+install\b/.test(fullCmd)) {
    out = compressInstall(out);
  }
  else if (/^(pytest|python.*-m\s+pytest)\b/.test(fullCmd)) {
    out = compressTests(out);
  }
  // 8. Docker — strip layer hashes, progress bars, keep errors + summary
  else if (/^docker\s+(build|run|pull|push|compose)\b/.test(fullCmd)) {
    out = compressDocker(out);
  }
  // 9. curl/wget — strip progress bars, keep response
  else if (/^(curl|wget)\b/.test(fullCmd)) {
    out = compressDownload(out);
  }
  // 10. Make — keep errors/warnings, drop recipe lines
  else if (cmd === 'make') {
    out = compressBuild(out);
  }

  // 11. Always collapse excessive blank lines
  out = collapseBlankLines(out);

  return out;
}

function compressGit(sub: string, out: string): string {
  switch (sub) {
    case 'add': {
      // git add is usually silent. Strip any blank output.
      const trimmed = out.trim();
      return trimmed || 'ok';
    }
    case 'commit': {
      // Keep: [branch abc1234] message + stats line. Strip verbose output.
      const lines = out.split('\n');
      const kept = lines.filter(l =>
        /^\[.+\]/.test(l) ||          // [main abc1234] commit msg
        /\d+ file/.test(l) ||          // 2 files changed, 10 insertions
        /^\s*(create|delete) mode/.test(l) ||
        l.trim() === ''
      );
      return kept.join('\n').trim() || out.trim();
    }
    case 'push': {
      // Strip verbose remote "enumerating/counting/compressing" lines
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l) &&
        !/^Counting objects|^Compressing objects|^Writing objects/.test(l) &&
        l.trim() !== ''
      );
      return lines.join('\n').trim() || 'ok';
    }
    case 'pull': {
      // Strip "remote: Counting..." lines, keep summary
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l) &&
        !/^Counting objects|^Compressing objects/.test(l)
      );
      return collapseBlankLines(lines.join('\n')).trim();
    }
    case 'fetch': {
      const lines = out.split('\n').filter(l =>
        !/^remote:\s*(Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l)
      );
      return lines.join('\n').trim();
    }
    case 'log': {
      // Already terse if user uses --oneline; just collapse blanks
      return out.trim();
    }
    default:
      return out;
  }
}

function compressInstall(out: string): string {
  const lines = out.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const l = line.trim();
    // Drop pure progress lines
    if (/^(Downloading|Fetching|Resolving|Progress|Preparing|Caching)/.test(l)) continue;
    if (/^[\s.]*$/.test(l)) continue;
    // Keep errors, warnings, and summary lines
    kept.push(line);
  }
  // If no lines kept, return original trimmed (don't lose error info)
  const result = kept.join('\n').trim();
  return result || out.trim();
}

function compressTests(out: string): string {
  const lines = out.split('\n');
  // Look for failure sections and summary
  const kept: string[] = [];
  let inFailure = false;

  for (const line of lines) {
    const l = line.trim();
    // Detect failure/error blocks
    if (/^(FAIL|FAILED|Error:|●|✕|✗|×|error\[)/.test(l)) {
      inFailure = true;
    }
    // Summary lines (always keep)
    if (/^(Tests?|Test Suites?|Suites?|PASS|FAIL|ok\s|error|warning|\d+ (test|spec|example))/.test(l) ||
        /\d+\s*(passed|failed|skipped|pending|todo)/.test(l)) {
      kept.push(line);
      inFailure = false;
      continue;
    }
    if (inFailure) {
      kept.push(line);
      // End failure block on blank line after content
      if (l === '' && kept[kept.length - 2]?.trim() !== '') inFailure = false;
    }
  }

  // If nothing matched (e.g. all passed with no verbose output), return original
  if (kept.length === 0) return out.trim();
  return collapseBlankLines(kept.join('\n')).trim();
}

function compressBuild(out: string): string {
  const lines = out.split('\n');
  const kept = lines.filter(l => {
    const t = l.trim();
    if (t === '') return false;
    // Drop pure progress/info lines from bundlers/compilers
    if (/^(Compiling|Finished|Checking|warning: unused import)/.test(t) &&
        !/^(Compiling.*error|Finished.*error)/.test(t)) {
      // Keep "Finished" summary
      if (/^Finished/.test(t)) return true;
      return false;
    }
    return true;
  });
  return collapseBlankLines(kept.join('\n')).trim() || out.trim();
}

function compressDocker(out: string): string {
  const lines = out.split('\n');
  const kept = lines.filter(l => {
    const t = l.trim();
    // Drop layer progress: "sha256:abc123: Pulling fs layer" / "Downloading [==>  ]"
    if (/^[a-f0-9]{12}:\s*(Pull|Wait|Download|Extract|Verif|Already)/.test(t)) return false;
    // Drop download/upload progress bars
    if (/^\[[\s=>#]+\]/.test(t) || /\d+(\.\d+)?%/.test(t) && t.length < 80) return false;
    // Drop "Sending build context" progress
    if (/^Sending build context/.test(t)) return false;
    return true;
  });
  return collapseBlankLines(kept.join('\n')).trim() || out.trim();
}

function compressDownload(out: string): string {
  const lines = out.split('\n');
  const kept = lines.filter(l => {
    const t = l.trim();
    // Drop curl progress bars: "  % Total    % Received..."
    if (/^\s*%\s+Total/.test(t)) return false;
    if (/^\s*\d+\s+\d+[kMG]?\s+\d+\s+\d+[kMG]?/.test(t) && t.length < 100) return false;
    // Drop wget progress: "2024-01-01 12:00:00 (1.23 MB/s) - saved"
    if (/^\d{4}-\d{2}-\d{2}.*saved/.test(t)) return false;
    // Drop download percentage lines
    if (/^\s*\d+%\s/.test(t)) return false;
    return true;
  });
  return collapseBlankLines(kept.join('\n')).trim() || out.trim();
}

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

// ─── Background Task Tracker ─────────────────────────────────────────────
// When run_in_background=true, we spawn the command and return immediately.
// The result is stored here and can be queried later.

interface BackgroundTask {
  id: string;
  command: string;
  description: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  result?: CapabilityResult;
}

const backgroundTasks = new Map<string, BackgroundTask>();
let bgTaskCounter = 0;

/** Get a background task's result (called by the agent to check status). */
export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return backgroundTasks.get(id);
}

/** List all background tasks. */
export function listBackgroundTasks(): BackgroundTask[] {
  return [...backgroundTasks.values()];
}

/**
 * Drop completed/failed task records. Running tasks are left in place —
 * we have no safe way to terminate a spawned process from here, and killing
 * one out from under a caller that may still be polling it would silently
 * lose output. Callers starting a fresh session can still query prior
 * running tasks by id if they need to; anything finished is gone.
 */
export function clearSessionState(): void {
  for (const [id, task] of backgroundTasks) {
    if (task.status !== 'running') backgroundTasks.delete(id);
  }
}

const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB capture buffer (prevents OOM)
const MAX_RETURN_CHARS = 32_000;    // 32KB return cap (~8,000 tokens) — prevents context bloat
const DEFAULT_TIMEOUT_MS = 120_000;  // 2 minutes

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { command, timeout, run_in_background: runInBackground } = input as unknown as BashInput;

  if (!command || typeof command !== 'string') {
    return { output: 'Error: command is required', isError: true };
  }

  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, 600_000);

  // Background execution: spawn and return immediately with a task ID
  if (runInBackground) {
    const taskId = `bg-${++bgTaskCounter}`;
    const desc = (input.description as string) || command.slice(0, 60);
    const task: BackgroundTask = {
      id: taskId,
      command,
      description: desc,
      startedAt: Date.now(),
      status: 'running',
    };
    backgroundTasks.set(taskId, task);

    // Run in background — don't await
    executeCommand(command, timeoutMs, ctx).then(result => {
      task.status = result.isError ? 'failed' : 'completed';
      task.result = result;
    });

    return {
      output: `Background task started: ${taskId}\nCommand: ${command.slice(0, 100)}\n\nYou will be notified when it completes. Do not poll or sleep — continue with other work.`,
    };
  }

  return executeCommand(command, timeoutMs, ctx);
}

function executeCommand(command: string, timeoutMs: number, ctx: ExecutionScope): Promise<CapabilityResult> {
  return new Promise<CapabilityResult>((resolve) => {
    // Force /bin/bash (not $SHELL) so the tool's behavior matches its name
    // and its tool description. Pre-3.15.39 used `process.env.SHELL ||
    // '/bin/bash'`, which on macOS defaults to zsh — and zsh has
    // semantically different rules (NOMATCH on unmatched globs is fatal,
    // unlike bash's literal-passthrough). Verified 2026-05-04 from a real
    // session: agent ran `rm -f data/etl_out/shard-*.ndjson` expecting
    // bash's "if no match, -f ignores it"; zsh fatal-erred with `no
    // matches found`. Other zsh-vs-bash divergences (process substitution
    // syntax, `[[` bashisms in scripts, parameter expansion edge cases)
    // would silently bite agents that learned bash. /bin/bash exists on
    // every Linux + macOS install we ship to. Fall back to $SHELL only if
    // /bin/bash is somehow missing (NixOS-style stores, exotic Docker).
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL || '/bin/sh');
    let child: ReturnType<typeof spawn>;
    try {
      // The account bearer key is deliberately withheld from the subprocess.
      // bash-guard auto-approves `printenv` and `echo` as safe, so
      // `printenv BLOCKRUN_API_KEY` ran with no confirmation and returned the
      // key as tool output — into the model prompt and the saved transcript.
      // Wallet private keys are never in the environment at all; this gives
      // the key the same treatment. Franklin's own gateway calls read
      // process.env in-process and are unaffected, and a user who genuinely
      // needs the key in a shell can export it there themselves.
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        FRANKLIN: '1', // Let scripts detect they're running inside Franklin
        FRANKLIN_WORKDIR: ctx.workingDir,
        RUNCODE: '1', // Backwards compat
        RUNCODE_WORKDIR: ctx.workingDir,
      };
      delete childEnv.BLOCKRUN_API_KEY;

      child = spawn(shell, ['-c', command], {
        cwd: ctx.workingDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Put the shell in its own process group (pgid = pid) so a timeout
        // can SIGTERM the entire tree. Without this, signalling only the
        // immediate bash leaves grandchildren (e.g. `gsutil -m cp` and its
        // python helpers) running as orphans — observed in the wild as
        // 18-day-old leaked gsutil processes after a 30-min Bash timeout.
        detached: true,
      });
    } catch (spawnErr) {
      resolve({ output: `Error spawning shell: ${(spawnErr as Error).message}`, isError: true });
      return;
    }

    // Signal the whole process group (negative pid). ESRCH means the group
    // is already gone — fine. Any other failure we swallow because the close
    // handler will still resolve the promise on its own.
    const killTree = (signal: NodeJS.Signals): void => {
      if (typeof child.pid !== 'number') return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* group already dead */
      }
    };

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let truncated = false;
    let killed = false;
    let abortedByUser = false;

    const timer = setTimeout(() => {
      killed = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5000); // 5s grace before SIGKILL
    }, timeoutMs);

    // Handle abort signal
    const onAbort = () => {
      killed = true;
      abortedByUser = true;
      killTree('SIGTERM');
    };
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    // Emit last non-empty line to UI progress (throttled to avoid flooding)
    let lastProgressEmit = 0;
    const emitProgress = (text: string) => {
      if (!ctx.onProgress) return;
      const now = Date.now();
      if (now - lastProgressEmit < 200) return; // max 5 updates/sec
      lastProgressEmit = now;
      const lastLine = text.split('\n').map(l => l.trim()).filter(Boolean).pop();
      if (lastLine) ctx.onProgress(lastLine.slice(0, 120));
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf-8');
      if (chunk.length <= remaining) {
        stdout += text;
        outputBytes += chunk.length;
      } else {
        stdout += text.slice(0, remaining);
        outputBytes = MAX_OUTPUT_BYTES;
        truncated = true;
      }
      emitProgress(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const text = chunk.toString('utf-8');
      if (chunk.length <= remaining) {
        stderr += text;
        outputBytes += chunk.length;
      } else {
        stderr += text.slice(0, remaining);
        outputBytes = MAX_OUTPUT_BYTES;
        truncated = true;
      }
      emitProgress(text);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);

      let result = '';
      if (stdout) result += stdout;
      if (stderr) {
        if (result) result += '\n';
        result += stderr;
      }

      if (truncated) {
        result += '\n\n... (output truncated — command produced >512KB)';
      }

      // Smart compression: strip ANSI, collapse blank lines, command-aware filters
      result = compressOutput(command, result);

      // Cap returned output to prevent context bloat.
      // Keep the LAST part (most relevant for errors/test failures/build output).
      if (result.length > MAX_RETURN_CHARS) {
        const lines = result.split('\n');
        let trimmed = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = lines[i] + '\n' + trimmed;
          if (candidate.length > MAX_RETURN_CHARS) break;
          trimmed = candidate;
        }
        const omitted = result.length - trimmed.length;
        result = `... (${omitted.toLocaleString()} chars omitted from start)\n${trimmed}`;
      }

      if (killed) {
        const reason = abortedByUser
          ? 'aborted by user'
          : `timeout after ${timeoutMs / 1000}s. Set timeout param up to 600000ms for longer.`;
        resolve({
          output: result + `\n\n(command killed — ${reason})`,
          isError: true,
        });
        return;
      }

      if (code !== 0 && code !== null) {
        resolve({
          output: result || `Command exited with code ${code}`,
          isError: true,
        });
        return;
      }

      resolve({ output: result || '(no output)' });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);
      resolve({
        output: `Error spawning command: ${err.message}`,
        isError: true,
      });
    });
  });
}

/**
 * Detect if a bash command is read-only (safe to run concurrently).
 * Analyzes command segments to determine if ALL operations are read-only.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'file', 'stat', 'tree',
  'find', 'grep', 'rg', 'ag', 'ack', 'which', 'whereis', 'type',
  'echo', 'printf', 'date', 'whoami', 'hostname', 'uname', 'env', 'printenv',
  'pwd', 'realpath', 'dirname', 'basename',
  'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', // sed is read-only when used in pipeline (no -i)
  'diff', 'comm', 'less', 'more',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'stash',
  'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files',
  'ls-tree', 'ls-remote', 'config', 'reflog',
]);

function isReadOnlyCommand(command: string): boolean {
  // Split on operators (&&, ||, ;, |) and check each segment
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Extract the base command (first word, ignore env vars and redirects)
    const words = trimmed.split(/\s+/).filter(w => !w.includes('=') && !w.startsWith('>') && !w.startsWith('<'));
    const baseCmd = words[0]?.replace(/^(sudo|time|nice)\s+/, '') || '';

    if (baseCmd === 'git') {
      const subCmd = words[1] || '';
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(subCmd)) return false;
      continue;
    }

    if (baseCmd === 'npm' || baseCmd === 'npx' || baseCmd === 'yarn' || baseCmd === 'pnpm') {
      const subCmd = words[1] || '';
      // npm run/test/list/info are read-only; npm install/build are not
      if (['run', 'test', 'list', 'ls', 'info', 'view', 'show', 'outdated', 'audit'].includes(subCmd)) continue;
      return false;
    }

    // Check if it's a known read-only command
    const baseName = baseCmd.split('/').pop() || baseCmd;
    if (!READ_ONLY_COMMANDS.has(baseName)) return false;

    // sed with -i flag is NOT read-only
    if (baseName === 'sed' && trimmed.includes(' -i')) return false;
  }

  return segments.some(s => s.trim().length > 0); // At least one non-empty segment
}

export const bashCapability: CapabilityHandler = {
  spec: {
    name: 'Bash',
    description: `Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- Communication: Output text directly (NOT echo/printf)

# Instructions
- If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the user explicitly requests it.
- You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
- When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
- For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative. Only use destructive operations when truly the best approach.
  - Never skip hooks (--no-verify) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
  - NEVER use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - Do NOT write \`sleep\` inside a for/while/until loop in a single foreground Bash call to poll an external async job. That blocks the agent for the whole poll duration and looks frozen to the user; they will cancel before it finishes. Pick one:
    1. Use the \`Detach\` tool for polling-style work (waiting for an Apify run, video generation, deploy, or build to complete). It returns a runId immediately and the polling runs persistently; check status later with \`franklin task wait/tail <runId>\`.
    2. Use the upstream sync endpoint when one exists (e.g. Apify's \`run-sync-get-dataset-items\`) with an explicit \`timeout\` up to 600000ms — usually simpler than orchestrating async + poll yourself.
    3. Break the poll into discrete single-call polls — one poll per Bash call, reason about the status between calls, decide whether to poll again. The user can then see progress and course-correct.

Output is capped at 512KB capture / 32KB return.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in active voice. For simple commands (git, npm), keep it brief (5-10 words): "Show working tree status", "Install dependencies". For complex commands (piped, obscure flags), add enough context: "Find and delete all .tmp files recursively"' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 120000, max: 600000)' },
        run_in_background: { type: 'boolean', description: 'Set to true to run this command in the background. Returns immediately with a task ID. Use this for long-running commands (builds, installs, deploys) when you don\'t need the result immediately. You will be notified when it completes — do NOT sleep or poll.' },
      },
      required: ['command'],
    },
  },
  execute,
  concurrent: false, // Default; overridden by isConcurrentSafe for read-only commands
  isConcurrentSafe: (input: Record<string, unknown>) => {
    const cmd = (input.command as string) || '';
    return isReadOnlyCommand(cmd);
  },
};
