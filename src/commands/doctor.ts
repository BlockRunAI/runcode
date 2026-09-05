/**
 * `franklin doctor` — one-command health check.
 *
 * The single highest-leverage onboarding improvement: most early failures
 * are environmental (Node too old, no wallet, wrong chain, unreachable
 * gateway, malformed MCP config). `franklin doctor` pokes each of those in
 * sequence, prints a verdict per check, and exits non-zero if anything is
 * broken so CI scripts can gate on it.
 *
 * Human-readable by default. Pass `--json` for machine-parseable output
 * (useful for the ink REPL `/doctor` or external monitoring).
 */

import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  setupAgentWallet,
  setupAgentSolanaWallet,
} from '@blockrun/llm';
import { loadChain, VERSION, BLOCKRUN_DIR, DASHBOARD_URL, KEY_API_URL, USER_AGENT } from '../config.js';
import { gatewayBase, isKeyMode, loadApiKey, maskApiKey } from '../payments/auth-mode.js';
import { isTelemetryEnabled, readAllRecords, telemetryPaths } from '../telemetry/store.js';
import { getAvailableUpdateFresh, kickoffVersionCheck } from '../version-check.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  remedy?: string;
}

/** Free, auth-gated probe — proves the key works without spending credit. */
async function verifyKeyReachable(): Promise<{ ok: boolean; detail: string }> {
  const key = loadApiKey();
  if (!key) return { ok: false, detail: 'no key resolved' };
  try {
    const res = await fetch(`${KEY_API_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401) return { ok: false, detail: 'gateway returned 401' };
    if (!res.ok) return { ok: false, detail: `gateway returned HTTP ${res.status}` };
    return { ok: true, detail: 'authenticated' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
  }
}

async function runChecks(): Promise<Check[]> {
  const out: Check[] = [];

  // Kick off the authoritative version fetch FIRST, in parallel with the
  // other checks. Doctor is a diagnostic — the user just asked "am I
  // healthy?" — so a 24h-stale cache is the wrong answer. The fetch is
  // bounded by the same 2s timeout the background check uses, and falls
  // back to the cached value on failure. By the time we render the
  // Franklin-version check below, the fetch has typically settled in
  // <300ms (npm is fast) and we have a current answer.
  const freshUpdatePromise = getAvailableUpdateFresh();

  // ── 1. Runtime ────────────────────────────────────────────────────
  const nodeVer = process.versions.node;
  const nodeMajor = parseInt(nodeVer.split('.')[0], 10);
  out.push({
    name: 'Node.js',
    status: nodeMajor >= 20 ? 'ok' : 'fail',
    detail: `${nodeVer}${nodeMajor >= 20 ? '' : ' — require >= 20'}`,
    remedy: nodeMajor >= 20 ? undefined : 'Upgrade Node.js: https://nodejs.org',
  });

  // ── 2. Franklin version ───────────────────────────────────────────
  // Keep kickoffVersionCheck() so non-doctor entry points (banner etc.)
  // still warm the cache through their normal daily refresh path.
  kickoffVersionCheck();
  const update = await freshUpdatePromise;
  out.push({
    name: 'Franklin Agent',
    status: update ? 'warn' : 'ok',
    detail: update
      ? `v${VERSION} — update available: v${update.latest}`
      : `v${VERSION}`,
    remedy: update ? 'npm install -g @blockrun/franklin@latest' : undefined,
  });

  // ── 3. BLOCKRUN_DIR writable ──────────────────────────────────────
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    const probe = path.join(BLOCKRUN_DIR, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    out.push({
      name: 'Config directory',
      status: 'ok',
      detail: BLOCKRUN_DIR,
    });
  } catch (err) {
    out.push({
      name: 'Config directory',
      status: 'fail',
      detail: `${BLOCKRUN_DIR} — ${(err as Error).message}`,
      remedy: `Check permissions on ${BLOCKRUN_DIR} or unset HOME override`,
    });
  }

  // ── 4. Chain configuration ────────────────────────────────────────
  let chain: 'base' | 'solana' | null = null;
  try {
    chain = loadChain();
    out.push({
      name: 'Chain',
      status: 'ok',
      detail: chain,
    });
  } catch (err) {
    out.push({
      name: 'Chain',
      status: 'fail',
      detail: `failed to load — ${(err as Error).message}`,
      remedy: 'Run: franklin setup base  (or: franklin setup solana)',
    });
  }

  // ── 5. Wallet ─────────────────────────────────────────────────────
  let walletBalance: number | null = null;
  // ── Pay mode ──────────────────────────────────────────────────────
  // Which credential will actually be spent matters more than any single
  // check below — a user with a key set but an unfunded wallet is healthy,
  // and vice versa, so name the mode before reporting on either.
  if (isKeyMode()) {
    const key = loadApiKey();
    const verdict = await verifyKeyReachable();
    out.push({
      name: 'Pay mode',
      status: verdict.ok ? 'ok' : 'fail',
      detail: verdict.ok
        ? `api-key ${key ? maskApiKey(key) : ''} → ${gatewayBase()}`
        : `api-key rejected — ${verdict.detail}`,
      remedy: verdict.ok
        ? undefined
        : `Check the key at ${DASHBOARD_URL}/dashboard, or run \`franklin logout\` to fall back to the wallet`,
    });
  } else {
    out.push({
      name: 'Pay mode',
      status: 'ok',
      detail: `wallet (${chain ?? 'unset'}) → ${gatewayBase()}`,
    });
  }

  let walletAddress = '';
  if (chain) {
    try {
      if (chain === 'solana') {
        const client = await setupAgentSolanaWallet({ silent: true });
        walletAddress = await client.getWalletAddress();
        walletBalance = await client.getBalance();
      } else {
        const client = setupAgentWallet({ silent: true });
        walletAddress = client.getWalletAddress();
        walletBalance = await client.getBalance();
      }
      out.push({
        name: 'Wallet',
        status: 'ok',
        detail: `${walletAddress.slice(0, 10)}…${walletAddress.slice(-6)}`,
      });
      // Tiered balance status. Binary `> 0` was misleading — verified
      // 2026-05-11 from a real run: doctor printed `✓ USDC balance
      // $0.37` (green) on a wallet that couldn't fund a single Opus
      // call ($0.50+ each). Threshold of $1.00 covers ~10 cheap-model
      // calls or ~2 mid-tier calls — anything below that is
      // operationally empty for paid workflows. Free models still work.
      const LOW_BALANCE_THRESHOLD = 1.00;
      const balanceStatus: 'ok' | 'warn' =
        walletBalance >= LOW_BALANCE_THRESHOLD ? 'ok' : 'warn';
      const balanceDetail =
        walletBalance === 0
          ? '$0.00 — free-tier models only (no paid calls possible)'
          : walletBalance < LOW_BALANCE_THRESHOLD
          ? `$${walletBalance.toFixed(2)} — low; paid calls likely to fail mid-stream`
          : `$${walletBalance.toFixed(2)}`;
      const balanceRemedy =
        walletBalance < LOW_BALANCE_THRESHOLD
          ? `Send USDC on ${chain} to ${walletAddress} (or open http://localhost:3100/#wallet)`
          : undefined;
      out.push({
        name: 'USDC balance',
        status: balanceStatus,
        detail: balanceDetail,
        remedy: balanceRemedy,
      });
    } catch (err) {
      const msg = (err as Error).message || '';
      out.push({
        name: 'Wallet',
        status: 'fail',
        detail: `error — ${msg.slice(0, 120)}`,
        remedy:
          msg.includes('ENOENT') || msg.includes('wallet') || msg.includes('key')
            ? 'Run: franklin setup'
            : 'Check network / wallet file permissions',
      });
    }
  }

  // ── 6. Gateway reachability ───────────────────────────────────────
  if (chain) {
    const apiUrl = gatewayBase();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`${apiUrl}/health`, { signal: ctl.signal }).catch(() => null);
      clearTimeout(t);
      if (res && res.ok) {
        out.push({
          name: 'Gateway',
          status: 'ok',
          detail: apiUrl,
        });
      } else {
        // Fall back to a HEAD on the messages endpoint — some deployments
        // don't expose /health but the API is up.
        const ctl2 = new AbortController();
        const t2 = setTimeout(() => ctl2.abort(), 5000);
        const res2 = await fetch(`${apiUrl}/v1/messages`, {
          method: 'HEAD',
          signal: ctl2.signal,
        }).catch(() => null);
        clearTimeout(t2);
        out.push({
          name: 'Gateway',
          status: res2 ? 'ok' : 'fail',
          detail: res2 ? apiUrl : `unreachable: ${apiUrl}`,
          remedy: res2 ? undefined : 'Check network or try the other chain',
        });
      }
    } catch (err) {
      out.push({
        name: 'Gateway',
        status: 'fail',
        detail: `${apiUrl} — ${(err as Error).message}`,
      });
    }
  }

  // ── 7. MCP config ─────────────────────────────────────────────────
  const mcpPath = path.join(BLOCKRUN_DIR, 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    try {
      const raw = fs.readFileSync(mcpPath, 'utf-8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const count = Object.keys(parsed.mcpServers || {}).length;
      out.push({
        name: 'MCP servers',
        status: 'ok',
        detail: `${count} configured in ${mcpPath}`,
      });
    } catch (err) {
      out.push({
        name: 'MCP servers',
        status: 'warn',
        detail: `${mcpPath} has invalid JSON — ${(err as Error).message}`,
        remedy: `Fix or delete ${mcpPath}`,
      });
    }
  } else {
    out.push({
      name: 'MCP servers',
      status: 'ok',
      detail: 'none configured',
    });
  }

  // ── 8. Telemetry ──────────────────────────────────────────────────
  const telEnabled = isTelemetryEnabled();
  if (telEnabled) {
    const records = readAllRecords();
    out.push({
      name: 'Telemetry',
      status: 'ok',
      detail: `enabled — ${records.length} session${records.length === 1 ? '' : 's'} recorded`,
    });
  } else {
    out.push({
      name: 'Telemetry',
      status: 'ok',
      detail: 'disabled (default)',
    });
  }

  // ── 9. Shell / PATH hint ──────────────────────────────────────────
  const which = process.env.PATH || '';
  const hasHomebrew = which.includes('/opt/homebrew/bin') || which.includes('/usr/local/bin');
  if (os.platform() === 'darwin' && !hasHomebrew) {
    out.push({
      name: 'PATH',
      status: 'warn',
      detail: 'Homebrew paths not in PATH',
      remedy: 'Add /opt/homebrew/bin to PATH in ~/.zshrc',
    });
  }

  // ── Solana wallet divergence (blockrun#119) ───────────────────────
  // A tightened SDK selection can leave a user spending from a different
  // address than the one holding their USDC, with nothing printed. Report it
  // where they already look when money seems missing.
  try {
    const { detectSolanaWalletDivergence } = await import('../wallet/solana-migration.js');
    const divergence = await detectSolanaWalletDivergence();
    if (divergence) {
      out.push({
        name: 'Solana wallet',
        status: 'warn',
        detail:
          `active ${divergence.active}; ${divergence.alternatives.length} other wallet(s) found: ` +
          divergence.alternatives.map((w) => w.address).join(', '),
        remedy: 'If your USDC is on one of those: franklin wallet-adopt <address>',
      });
    }
  } catch { /* a diagnostic must never take down `franklin doctor` */ }

  return out;
}

function printHuman(checks: Check[]): void {
  console.log(chalk.bold('\n  franklin doctor\n'));
  for (const c of checks) {
    const icon =
      c.status === 'ok' ? chalk.green('✓') :
      c.status === 'warn' ? chalk.yellow('⚠') :
      chalk.red('✗');
    console.log(`  ${icon}  ${c.name.padEnd(18)} ${chalk.dim(c.detail)}`);
    if (c.remedy) {
      console.log(`     ${chalk.dim('↳')} ${chalk.yellow(c.remedy)}`);
    }
  }

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  console.log();
  if (fails > 0) {
    console.log(chalk.red(`  ${fails} check${fails === 1 ? '' : 's'} failed. See remedies above.`));
  } else if (warns > 0) {
    console.log(chalk.yellow(`  All criticals ok. ${warns} warning${warns === 1 ? '' : 's'} above — safe to ignore for now.`));
  } else {
    console.log(chalk.green('  All clear. Ready to run: franklin'));
  }
  console.log();
}

export async function doctorCommand(
  opts: { json?: boolean; anomaly?: boolean } = {},
): Promise<void> {
  if (opts.anomaly) {
    await anomalyReportCommand(opts);
    return;
  }
  const checks = await runChecks();
  if (opts.json) {
    const fails = checks.filter(c => c.status === 'fail').length;
    process.stdout.write(JSON.stringify({ checks, healthy: fails === 0 }, null, 2) + '\n');
    process.exit(fails > 0 ? 1 : 0);
  }
  printHuman(checks);
  const fails = checks.filter(c => c.status === 'fail').length;
  process.exit(fails > 0 ? 1 : 0);
}

/**
 * `franklin doctor --anomaly` — print failure spikes vs 30-day baseline.
 * Exits non-zero when at least one anomaly is surfaced, so it can be
 * wired into a cron / CI without parsing stdout.
 */
async function anomalyReportCommand(opts: { json?: boolean }): Promise<void> {
  const { getToolAnomalies } = await import('../stats/failures.js');
  const reports = getToolAnomalies();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ anomalies: reports }, null, 2) + '\n');
    process.exit(reports.length > 0 ? 1 : 0);
  }
  console.log(chalk.bold('\n  franklin doctor --anomaly'));
  console.log(chalk.dim('  Looking for (tool, category) failure spikes in the last 24h vs the 30-day baseline.\n'));
  if (reports.length === 0) {
    console.log(chalk.green('  No anomalies. Tool failure rates match the 30-day baseline.\n'));
    process.exit(0);
  }
  for (const a of reports) {
    const newType = !Number.isFinite(a.spikeRatio);
    const header = `  ${chalk.red('•')} ${chalk.bold(a.toolName)} / ${chalk.yellow(a.category)}`;
    const ratio = newType
      ? chalk.red('NEW failure type (no baseline)')
      : chalk.red(`${a.spikeRatio.toFixed(1)}× baseline`);
    const counts = chalk.dim(`recent=${a.recentCount}, baseline=${a.baselineCount}`);
    console.log(`${header}  ${ratio}  ${counts}`);
    const trimmed = a.sampleMessage.length > 140 ? a.sampleMessage.slice(0, 140) + '…' : a.sampleMessage;
    console.log(chalk.dim(`    sample: ${trimmed}`));
  }
  console.log(chalk.dim(`\n  ${reports.length} anomalies. Investigate before they snowball.\n`));
  process.exit(1);
}
