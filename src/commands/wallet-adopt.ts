/**
 * `franklin wallet-adopt <address>` — switch to a Solana wallet Franklin can
 * see but is not using (blockrun#119).
 *
 * Explicit by design. The complaint behind #119 is that an upgrade changed the
 * active address without asking, so the remedy must not do the same thing in
 * the other direction: the user names the address, and only then does anything
 * move. `importSolanaWallet` matches against the address DERIVED from each
 * discovered key (never the file's own `address` field) and backs up the
 * current `~/.blockrun/.solana-session` before replacing it.
 */

import chalk from 'chalk';
import { detectSolanaWalletDivergence, activeSolanaAddress } from '../wallet/solana-migration.js';

export async function walletAdoptCommand(address: string): Promise<void> {
  const wanted = address.trim();
  const current = activeSolanaAddress();

  if (current === wanted) {
    console.log(`Already active: ${wanted}`);
    return;
  }

  const divergence = await detectSolanaWalletDivergence();
  const candidates = divergence?.alternatives ?? [];
  const match = candidates.find((w) => w.address === wanted);

  if (!match) {
    console.log(chalk.red(`No discovered wallet derives to ${wanted}.`));
    if (candidates.length > 0) {
      console.log('\nFound on this machine:');
      for (const w of candidates) console.log(`  ${w.address}  (${w.source})`);
    } else {
      console.log('Franklin found no other Solana wallets on this machine.');
    }
    process.exitCode = 1;
    return;
  }

  try {
    const { importSolanaWallet } = await import('@blockrun/llm');
    const adopted = await importSolanaWallet(wanted);
    console.log(chalk.green(`Active Solana wallet is now ${adopted}`));
    console.log(chalk.dim(`  was: ${current ?? 'none'}`));
    console.log(chalk.dim(`  source: ${match.source}`));
    console.log(chalk.dim('  the previous session file was backed up before it was replaced'));
  } catch (err) {
    console.log(chalk.red(`Could not adopt ${wanted}: ${(err as Error).message}`));
    process.exitCode = 1;
  }
}
