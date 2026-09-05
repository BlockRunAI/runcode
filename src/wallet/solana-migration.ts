/**
 * Detect a Solana wallet the upgrade silently stopped using (blockrun#119).
 *
 * Franklin 3.35.6 tightened SDK wallet selection: startup now takes
 * `SOLANA_WALLET_KEY`, then `~/.blockrun/.solana-session`, then creates a new
 * wallet. The legacy `~/.blockrun/solana-wallet.json` is no longer selected.
 * That was a deliberate security fix and it stays.
 *
 * What it left behind is a silent address change. The SDK prints a migration
 * notice, but only when it CREATES a wallet — and the install that hurts has a
 * `.solana-session` already, so nothing is created, nothing is printed, and the
 * user is simply on a different address than the one holding their USDC.
 *
 * This module only looks. It derives public addresses (never trusting the
 * `address` field in a file, and never reading a key it does not derive from),
 * and reports a divergence for `franklin doctor` to show. Adopting one is an
 * explicit, separate act — `franklin wallet-adopt <address>` — because the
 * whole complaint is that the active wallet changed without anyone asking.
 */

import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { BLOCKRUN_DIR } from '../config.js';

export interface SolanaWalletDivergence {
  /** Address Franklin will actually spend from, or null if none is active. */
  active: string | null;
  /** Discovered wallets whose address differs from the active one. */
  alternatives: Array<{ address: string; source: string }>;
}

/**
 * The address the SDK will select, derived from the canonical session file.
 *
 * Deliberately does not call `getOrCreateSolanaWallet()`: that CREATES a wallet
 * as a side effect, which is exactly the wrong thing to do inside a diagnostic
 * that is trying to tell the user which wallet they already have. Same
 * primitives the signing path uses.
 */
export function activeSolanaAddress(): string | null {
  try {
    const key = fs.readFileSync(path.join(BLOCKRUN_DIR, '.solana-session'), 'utf-8').trim();
    if (!key) return null;
    return Keypair.fromSecretKey(bs58.decode(key)).publicKey.toBase58();
  } catch {
    return null; // absent, unreadable, or not a key we can derive from
  }
}

/**
 * Wallets on this machine that Franklin can see but is not using.
 *
 * Returns null when there is nothing to say — no active wallet, or every
 * discovered wallet is the active one. `listDiscoveredSolanaWallets()` derives
 * each address from the secret key rather than trusting the file, and returns
 * no secret material.
 */
export async function detectSolanaWalletDivergence(): Promise<SolanaWalletDivergence | null> {
  const active = activeSolanaAddress();
  if (!active) return null;

  let discovered: Array<{ address: string; source: string }> = [];
  try {
    const { listDiscoveredSolanaWallets } = await import('@blockrun/llm');
    discovered = await listDiscoveredSolanaWallets();
  } catch {
    return null; // SDK unavailable or scan failed — a diagnostic must not throw
  }

  const alternatives = discovered.filter((w) => w.address !== active);
  if (alternatives.length === 0) return null;
  return { active, alternatives };
}

/** One-line-per-wallet report. Public addresses only. */
export function formatDivergence(d: SolanaWalletDivergence): string {
  const lines = [
    `Active Solana wallet: ${d.active}`,
    `Franklin can also see ${d.alternatives.length} other wallet(s) on this machine:`,
    ...d.alternatives.map((w) => `  ${w.address}  (${w.source})`),
    '',
    'If your USDC is on one of those, Franklin is not spending from it. Adopt it with:',
    `  franklin wallet-adopt <address>`,
    'The current session file is backed up before anything is replaced.',
  ];
  return lines.join('\n');
}
