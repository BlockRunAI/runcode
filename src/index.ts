#!/usr/bin/env node

// Node version guard — MUST be first so it runs before the Solana stack loads on old Node.
import './preflight.js';

// Global error handlers — catch unhandled rejections/exceptions before they crash silently
process.on('unhandledRejection', (reason) => {
  console.error(`\x1b[31mUnhandled error: ${reason instanceof Error ? reason.message : String(reason)}\x1b[0m`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`);
  process.exit(1);
});

import { Command } from 'commander';
import { flushStats } from './stats/tracker.js';

// Ensure stats are flushed on any exit
process.on('exit', () => flushStats());
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { balanceCommand } from './commands/balance.js';
import { modelsCommand } from './commands/models.js';
import { configCommand } from './commands/config.js';
import { statsCommand } from './commands/stats.js';
import { logsCommand } from './commands/logs.js';
import { daemonCommand } from './commands/daemon.js';
import { slackCommand } from './commands/slack.js';
import { initCommand } from './commands/init.js';
import { uninitCommand } from './commands/uninit.js';
import { proxyCommand } from './commands/proxy.js';
import { buildTaskCommand } from './commands/task.js';
import { buildContentCommand } from './commands/content.js';
import { predictCommand } from './commands/predict.js';
import { loginCommand, logoutCommand } from './commands/login.js';
import { useWalletMode } from './payments/auth-mode.js';

import { VERSION as version } from './config.js';

// `--wallet` is process-global rather than a per-command option: it has to take
// effect before anything resolves a pay mode, and it belongs on `balance`,
// `doctor` and `models` too, not just `start`. Applying it straight from argv
// is the only way to get it in ahead of commander's dispatch; it is then
// removed so per-command parsers do not reject it as unknown. Stripping it also
// leaves a bare `franklin --wallet` with no args, which falls through to the
// default `start` action exactly as a bare `franklin` does.
if (process.argv.includes('--wallet')) {
  useWalletMode();
  process.argv = process.argv.filter((a) => a !== '--wallet');
}

const program = new Command();

program
  .name('franklin')
  .description(
    'Franklin Agent — The AI agent with a wallet.\n\n' +
      'While others chat, Franklin Agent spends — turning your USDC into real work.\n\n' +
      'Pay per action — a USDC wallet on Solana or Base, or a prepaid API key\n' +
      'from user.blockrun.ai. No subscriptions.'
  )
  .option('--wallet', 'Pay from the USDC wallet even when an API key is configured')
  .version(version);

program
  .command('setup [chain]')
  .description('Create a new wallet for payments (solana or base)')
  .action((chain) => setupCommand(chain));

program
  .command('start')
  .argument('[fromSessionId]', 'External agent session id/path for --from')
  .description('Start the franklin agent')
  .option(
    '-m, --model <model>',
    'Model to use (e.g. openai/gpt-5.5, anthropic/claude-sonnet-4.6). Default from config or claude-sonnet-4.6'
  )
  .option('--debug', 'Enable debug logging')
  .option('--trust', 'Trust mode — skip permission prompts for all tools')
  .option('--from <agent>', 'Start a new Franklin session from another agent context (claude or codex)')
  .option('-r, --resume [sessionId]', 'Resume a session by ID (or show picker if omitted)')
  .option('-c, --continue', 'Continue the most recent session in this directory')
  .option('--max-spend <usd>', 'Hard USD cap on total session API spend — session stops when exceeded')
  .option('-p, --prompt <text>', 'Run a single prompt non-interactively (for batch/scripted use)')
  .option('--approve-trades', 'Non-interactive runs: auto-approve trade plans that fit within --max-spend (default: reject all trades)')
  .action((fromSessionId: string | undefined, options) => startCommand({ ...options, fromSessionId, version }));

program
  .command('resume [sessionId]')
  .description('Resume a saved Franklin session (alias for: franklin --resume)')
  .option(
    '-m, --model <model>',
    'Override the model for this session'
  )
  .option('--debug', 'Enable debug logging')
  .option('--trust', 'Trust mode — skip permission prompts for all tools')
  .action((sessionId: string | undefined, options) =>
    startCommand({ ...options, version, resume: sessionId ?? 'picker' })
  );

program
  .command('proxy')
  .description('Run payment proxy for Anthropic-compatible CLI agents')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .option(
    '-m, --model <model>',
    'Default model for proxied requests'
  )
  .option('--no-fallback', 'Disable automatic fallback to backup models')
  .option('--debug', 'Enable debug logging')
  .action((options) => proxyCommand({ ...options, version }));

program
  .command('predict')
  .description('Prediction mode — forecast one real-world event with a research-only toolset (web/markets), headless')
  .requiredOption('-m, --model <model>', 'Model to use (e.g. anthropic/claude-opus-5, openai/gpt-5.5)')
  .requiredOption('-q, --question <text>', 'The event question to forecast (include the allowed options)')
  .option('--max-turns <n>', 'Max agent turns before forcing an answer', '8')
  .option('--max-tool-calls <n>', 'Max tool calls before forcing an answer', '6')
  .option('--max-spend <usd>', 'Hard USD cap on this prediction run')
  .option('--no-json', 'Human-readable streaming instead of a JSON envelope')
  .option('--debug', 'Enable debug logging')
  .action((options) => predictCommand(options));

program
  .command('init')
  .description('Configure franklin auto-start (writes ~/.claude/settings.json + installs LaunchAgent on macOS)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((options) => initCommand(options));

program
  .command('uninit')
  .description('Remove franklin configuration and uninstall LaunchAgent')
  .action(() => uninitCommand());

program
  .command('daemon <action>')
  .description('Manage franklin background proxy (start|stop|status)')
  .option('-p, --port <port>', 'Proxy port', '8402')
  .action((action, options) => daemonCommand(action, options));

program
  .command('slack')
  .description('Run the Slack ingress bot (Socket Mode)')
  .option('--model <model>', 'Model to use')
  .option('--debug', 'Verbose Slack/Bolt logging')
  .action((options) => slackCommand(options));

program
  .command('panel')
  .description('Open the Franklin dashboard (localhost:3100)')
  .option('-p, --port <port>', 'Dashboard port', '3100')
  .action(async (options: { port?: string }) => {
    const { panelCommand } = await import('./commands/panel.js');
    await panelCommand(options);
  });

program
  .command('serve')
  .description('Run the local agent server for the desktop app / browser UI (WebSocket on localhost:3737)')
  .option('-p, --port <port>', 'Agent server port', '3737')
  .option('--work-dir <dir>', 'Working directory for tools (default: cwd)')
  .option('--debug', 'Verbose logging')
  .action(async (options: { port?: string; workDir?: string; debug?: boolean }) => {
    const { serveCommand } = await import('./commands/serve.js');
    await serveCommand(options);
  });

program
  .command('models')
  .description('List available models and pricing')
  .action(modelsCommand);

program
  .command('balance')
  .description('Check wallet USDC balance, or API-key status in key mode')
  .action(balanceCommand);

program
  .command('login [key]')
  .description('Store a BlockRun API key (brk_live_...) — omit the key to show current pay mode')
  .action((key) => loginCommand(key));

program
  .command('logout')
  .description('Remove the stored BlockRun API key and fall back to the wallet')
  .action(logoutCommand);

program
  .command('config <action> [key] [value]')
  .description(
    'Manage franklin config (set, get, unset, list)\n' +
      'Keys: default-model, sonnet-model, opus-model, haiku-model, smart-routing'
  )
  .action(configCommand);

program
  .command('stats')
  .description('Show usage statistics and cost savings')
  .option('--clear', 'Clear all statistics')
  .option('--json', 'Output in JSON format')
  .action(statsCommand);

program
  .command('logs')
  .description('View debug logs (start with --debug to enable logging)')
  .option('-f, --follow', 'Follow log output in real time')
  .option('-n, --lines <count>', 'Number of lines to show (default: 50)')
  .option('--clear', 'Delete log file')
  .action(logsCommand);

program
  .command('insights')
  .description('Show rich usage insights — cost breakdown, trends, projections')
  .option('-d, --days <n>', 'Window size in days (default: 30)', '30')
  .action(async (opts: { days?: string }) => {
    const { generateInsights, formatInsights } = await import('./stats/insights.js');
    const days = parseInt(opts.days ?? '30', 10) || 30;
    const report = generateInsights(days);
    process.stdout.write(formatInsights(report, days));
  });

program
  .command('search <query>')
  .description('Search past sessions by keyword (use quotes for phrases)')
  .option('-l, --limit <n>', 'Max results to show (default: 10)', '10')
  .option('-m, --model <substring>', 'Filter by model name substring')
  .action(async (query: string, opts: { limit?: string; model?: string }) => {
    const { searchSessions, formatSearchResults } = await import('./session/search.js');
    const limit = parseInt(opts.limit ?? '10', 10) || 10;
    const matches = searchSessions(query, { limit, model: opts.model });
    process.stdout.write(formatSearchResults(matches, query));
  });

// ─── franklin skills (file-loaded SKILL.md slash commands) ───────────────
program
  .command('skills [action] [arg]')
  .description('Manage Franklin skills — list | which <name>')
  .option('--json', 'Output the skill list as JSON')
  .option('--all', 'Include hidden (auto-generated) skills in the list')
  .action(async (
    action: string | undefined,
    arg: string | undefined,
    opts: { json?: boolean; all?: boolean }
  ) => {
    const { skillsCommand } = await import('./commands/skills.js');
    await skillsCommand(action, arg, opts);
  });

// ─── franklin social (native X bot) ───────────────────────────────────────
// First-class subcommand. Handles setup / login / run / stats / config
// subactions. No plugin SDK, no MCP — everything lives in src/social/.
program
  .command('social [action] [arg]')
  .description('Native X bot — franklin social setup | login x | run | stats | config')
  .option('--dry-run', 'Generate drafts without posting (default for run)')
  .option('--live', 'Actually post to X (overrides dry-run default)')
  .option('-m, --model <model>', 'Override the model used for reply generation')
  .option('--debug', 'Enable debug logging')
  .action(async (
    action: string | undefined,
    arg: string | undefined,
    opts: { dryRun?: boolean; live?: boolean; model?: string; debug?: boolean }
  ) => {
    const { socialCommand } = await import('./commands/social.js');
    await socialCommand(action, arg, opts);
  });

// Plugin commands — dynamically registered from discovered plugins.
// Core stays plugin-agnostic: this loop adds a command for each installed plugin.
// Note: `social` is now a first-class native command above and NOT loaded as a
// plugin (the bundled social plugin was retired in v3.2.0 in favour of the
// src/social/ subsystem).
{
  const { loadAllPlugins, listWorkflowPlugins } = await import('./plugins/registry.js');
  await loadAllPlugins();
  for (const lp of listWorkflowPlugins()) {
    const { manifest } = lp;
    // Skip any plugin whose id collides with a built-in command (e.g. social)
    if (manifest.id === 'social') continue;
    program
      .command(`${manifest.id} [action]`)
      .description(manifest.description)
      .option('--dry', 'Dry run — preview without side effects')
      .option('--debug', 'Enable debug logging')
      .action(async (action: string, opts: { dry?: boolean; debug?: boolean }) => {
        const { pluginCommand } = await import('./commands/plugin.js');
        await pluginCommand(manifest.id, action, { dryRun: opts.dry, debug: opts.debug });
      });
  }
}

program
  .command('doctor')
  .description('One-command health check (node, wallet, chain, gateway, MCP, telemetry)')
  .option('--json', 'Machine-readable output')
  .option('--anomaly', 'Surface (tool, category) failure spikes vs 30-day baseline')
  .action(async (opts: { json?: boolean; anomaly?: boolean }) => {
    const { doctorCommand } = await import('./commands/doctor.js');
    await doctorCommand(opts);
  });

program
  .command('usage')
  .description('Account ledger from the gateway, reconciled against the local journal')
  .option('--days <n>', 'Days to read (default 30, max 365)')
  .option('--json', 'Machine-readable output')
  .action(async (opts) => {
    const { usageCommand } = await import('./commands/usage.js');
    await usageCommand(opts);
  });

program
  .command('wallet-adopt <address>')
  .description('Make a discovered Solana wallet the active one (backs up the current session)')
  .action(async (address: string) => {
    const { walletAdoptCommand } = await import('./commands/wallet-adopt.js');
    await walletAdoptCommand(address);
  });

program
  .command('telemetry [action]')
  .description('Manage opt-in local telemetry (status|enable|disable|view|summary)')
  .action(async (action?: string) => {
    const { telemetryCommand } = await import('./commands/telemetry.js');
    await telemetryCommand(action);
  });

program
  .command('telegram')
  .description(
    'Drive Franklin from Telegram (requires TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID env vars)',
  )
  .option('-m, --model <model>', 'Model to use (default from config)')
  .option('--debug', 'Enable debug logging')
  .action(async (opts: { model?: string; debug?: boolean }) => {
    const { telegramCommand } = await import('./commands/telegram.js');
    await telegramCommand(opts);
  });

program
  .command('migrate')
  .description('Import preferences and MCP servers from existing AI agent configs')
  .action(async () => {
    const { migrateCommand } = await import('./commands/migrate.js');
    await migrateCommand();
  });

program
  .command('plugins')
  .description('List installed plugins')
  .action(async () => {
    const { listAvailablePlugins } = await import('./commands/plugin.js');
    listAvailablePlugins();
  });

// `franklin task <subcmd>` — human-facing CLI for detached background tasks.
// Defined in src/commands/task.ts; subcommands: list, tail, cancel, wait.
program.addCommand(buildTaskCommand());

// `franklin content <subcmd>` — read access to the Content library
// (~/.blockrun/content.json) so users + agent shell-outs can inspect
// spend without scripting against the JSON file. Subcommands: list, show.
program.addCommand(buildContentCommand());

// Hidden internal subcommand — invoked by startDetachedTask via spawn(detached).
// The underscore prefix signals "not for humans"; we still register it via
// commander so exit codes and arg parsing stay consistent with the rest of
// the CLI.
program
  .command('_task-runner <runId>')
  .description('(internal) execute a detached task by runId')
  .action(async (runId: string) => {
    const { runDetachedTask } = await import('./tasks/runner.js');
    const code = await runDetachedTask(runId);
    process.exit(code);
  });

// Default action: if no subcommand given, run 'start'
const args = process.argv.slice(2);
const firstArg = args[0];
const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-V', '--version']);
const START_ONLY_FLAGS = new Set(['--trust', '--debug', '-m', '--model', '--from', '-r', '--resume', '-c', '--continue', '-p', '--prompt', '--max-spend', '--approve-trades']);

function hasAnyFlag(argv: string[], flags: Set<string>): boolean {
  return argv.some(arg => flags.has(arg));
}

function hasStartOnlyFlag(argv: string[]): boolean {
  return argv.some(arg => START_ONLY_FLAGS.has(arg));
}

function parseStartFlags(argv: string[], startIdx = 0): Record<string, unknown> {
  const opts: Record<string, unknown> = { version };
  for (let i = startIdx; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--trust') opts.trust = true;
    else if (arg === '--debug') opts.debug = true;
    else if ((arg === '-m' || arg === '--model') && argv[i + 1]) {
      opts.model = argv[++i];
    } else if ((arg === '-p' || arg === '--prompt') && argv[i + 1]) {
      opts.prompt = argv[++i];
    } else if (arg === '--max-spend' && argv[i + 1]) {
      opts.maxSpend = argv[++i];
    } else if (arg === '--approve-trades') {
      opts.approveTrades = true;
    } else if (arg === '--from') {
      opts.from = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        opts.fromSessionId = next;
        i++;
      }
    } else if (arg === '-c' || arg === '--continue') {
      opts.continue = true;
    } else if (arg === '-r' || arg === '--resume') {
      // --resume may take an optional session id — look at next arg
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        opts.resume = next;
        i++;
      } else {
        opts.resume = 'picker';
      }
    }
  }
  return opts;
}

// Handle chain shortcuts: `franklin solana` or `franklin base`
if (firstArg === 'solana' || firstArg === 'base') {
  if (hasAnyFlag(args, HELP_FLAGS)) {
    program.parse(['node', 'franklin', 'start', '--help']);
  }
  if (hasAnyFlag(args, VERSION_FLAGS)) {
    console.log(version);
    process.exit(0);
  }
  const { saveChain } = await import('./config.js');
  saveChain(firstArg as 'base' | 'solana');
  const startOpts = parseStartFlags(args, 1);
  await startCommand(startOpts as Parameters<typeof startCommand>[0]);
  process.exit(process.exitCode ?? 0);
} else if (!firstArg || firstArg.startsWith('-')) {
  if (hasAnyFlag(args, HELP_FLAGS) && hasStartOnlyFlag(args)) {
    program.parse(['node', 'franklin', 'start', '--help']);
  }
  if (hasAnyFlag(args, VERSION_FLAGS) && hasStartOnlyFlag(args)) {
    console.log(version);
    process.exit(0);
  }
  if (hasAnyFlag(args, HELP_FLAGS) || hasAnyFlag(args, VERSION_FLAGS)) {
    program.parse();
  }
  // No subcommand or only flags — treat as 'start' with flags
  const startOpts = parseStartFlags(args, 0);
  await startCommand(startOpts as Parameters<typeof startCommand>[0]);
  process.exit(process.exitCode ?? 0);
} else {
  // Force node-style argv slicing. When the CLI is embedded and run via
  // Electron-as-node (ELECTRON_RUN_AS_NODE=1, e.g. the desktop app spawning
  // `franklin serve`), commander otherwise detects `process.versions.electron`
  // + no defaultApp and slices argv as a packaged-electron app — treating the
  // script path as the command. `from: 'node'` keeps [exec, script, ...args].
  program.parse(process.argv, { from: 'node' });
}
