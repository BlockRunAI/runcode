/**
 * `franklin usage` — what the account actually charged, joined to what
 * Franklin recorded.
 *
 * `franklin stats` reports Franklin's own tally, which in key mode is built
 * from catalog prices because the account gateway settles without returning a
 * charge. This command reports the gateway's ledger, which is authoritative,
 * and lines the two up per request rather than comparing totals — a total that
 * matches can still be two errors cancelling out.
 */

import chalk from 'chalk';
import { isKeyMode } from '../payments/auth-mode.js';
import { fetchUsage, reconcile } from '../payments/usage.js';
import { loadStats } from '../stats/tracker.js';
import { DASHBOARD_URL } from '../config.js';

function usd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
}

export async function usageCommand(opts: { days?: string; json?: boolean } = {}): Promise<void> {
  if (!isKeyMode()) {
    console.log('Account usage is a key-mode ledger. This session pays from a wallet —');
    console.log('its settled amounts are already exact, and `franklin stats` reports them.');
    return;
  }

  const days = Math.max(1, Math.min(Number(opts.days) || 30, 365));
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const ledger = await fetchUsage({ from });
  if (!ledger) {
    console.log(chalk.yellow('Could not read the account ledger.'));
    console.log(`Check your key, or view it at ${DASHBOARD_URL}/dashboard.`);
    process.exitCode = 1;
    return;
  }

  const local = loadStats().history.map((h) => ({ requestId: h.requestId, costUsd: h.costUsd }));
  const r = reconcile(ledger, local);

  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const t = r.totals;
  console.log(chalk.bold(`\nAccount ledger — last ${days} day(s)\n`));
  console.log(`  Charged:   ${chalk.green(usd(t.pricedUsd))} across ${t.pricedCount} request(s)  ${chalk.dim('(BlockRun, authoritative)')}`);
  if (t.pendingCount > 0) {
    // Not settled zeros — these can still be priced.
    console.log(`  Pending:   ${chalk.yellow(String(t.pendingCount))} request(s) with no charge yet ${chalk.dim('— not free, not final')}`);
  }
  if (t.freeCount > 0) console.log(`  Free:      ${t.freeCount} request(s) ${chalk.dim('(explicitly not charged)')}`);
  console.log(chalk.dim(`  Mix:       ${t.chatCount} chat, ${t.serviceCount} service`));

  if (r.unavailableDays.length > 0) {
    // A hidden gap makes two correct ledgers look like they disagree.
    console.log(chalk.yellow(`\n  ${r.unavailableDays.length} day(s) could not be listed: ${r.unavailableDays.join(', ')}`));
    console.log(chalk.dim('  Totals above exclude them — this is a short read, not a quiet period.'));
  }

  console.log(chalk.bold('\nAgainst Franklin\'s own journal\n'));
  if (r.matched.length === 0 && r.missingLocally.length === 0) {
    console.log(chalk.dim('  No ledger row could be joined yet. Request ids are recorded from now on,'));
    console.log(chalk.dim('  so calls made before this version have nothing to match against.'));
  }

  const off = r.matched
    .filter((m) => Math.abs(m.deltaUsd) > 0.000_05)
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));

  if (r.matched.length > 0) {
    console.log(`  Joined:    ${r.matched.length} request(s); ${off.length} where Franklin's estimate differs`);
  }
  for (const m of off.slice(0, 10)) {
    const sign = m.deltaUsd > 0 ? '+' : '';
    // A service charge is a per-call figure only the gateway holds, so a local
    // estimate for one is a guess by construction — say so rather than letting
    // it read as a defect.
    const note = m.row.kind === 'service' ? chalk.dim(' (service — locally an estimate by construction)') : '';
    console.log(`    ${m.row.endpoint.padEnd(30)} gateway ${usd(m.row.costUsd)}  local ${usd(m.localUsd)}  ${sign}${m.deltaUsd.toFixed(4)}${note}`);
  }

  if (r.missingLocally.length > 0) {
    const sum = r.missingLocally.reduce((a, b) => a + b.costUsd, 0);
    console.log(chalk.yellow(`\n  ${r.missingLocally.length} charged request(s) have no local row (${usd(sum)}).`));
    console.log(chalk.dim('  Franklin never counted these, so they never reached --max-spend either.'));
    for (const row of r.missingLocally.slice(0, 5)) {
      console.log(chalk.dim(`    ${row.timestamp}  ${row.endpoint}  ${usd(row.costUsd)}`));
    }
  }

  if (r.unjoinable > 0) {
    console.log(chalk.dim(`\n  ${r.unjoinable} local row(s) carry no request id and were not compared.`));
  }
  console.log(chalk.dim(`\n  Full activity: ${DASHBOARD_URL}/dashboard\n`));
}
