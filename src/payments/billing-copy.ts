/**
 * How Franklin describes a charge to the user and to the model.
 *
 * Key mode spends prepaid account credits; wallet mode signs USDC over x402.
 * Saying "USDC charged" or "paid via x402" in key mode is not a cosmetic slip:
 * these strings are the receipt the user reads, the approval prompt they say
 * yes to, and the text the model reasons over when it decides whether it can
 * afford the next call. Naming the wrong instrument makes all three wrong.
 *
 * Two rules, and the split matters:
 *
 *   Runtime output — receipts, approval prompts, cancellations — calls these
 *   helpers, which read the mode at call time. `invalidateKey()` can demote a
 *   session to wallet mode mid-run, so the mode must not be captured earlier.
 *
 *   Static `spec.description` text is built once at module load, before any
 *   mode is settled and with no way to re-render afterwards. It must be
 *   phrased so it is true in BOTH modes — state the price, not the rail:
 *   "Costs $0.001 per call", never "Costs $0.001 USDC from the wallet".
 *   These helpers deliberately do not serve that case.
 */

import { isKeyMode } from './auth-mode.js';

function fmt(usd: number): string {
  // Sub-cent prices are real here ($0.001 tiers), so keep enough places to
  // avoid rendering them as $0.00.
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Parenthetical for a completed charge, e.g. `($5.00 USDC charged)` or
 * `(billed to account credits)`. Key mode states no amount: the local figure
 * is an estimate and the account ledger is authoritative.
 */
export function chargedNote(usd: number): string {
  return isKeyMode()
    ? 'billed to account credits — see Activity at user.blockrun.ai'
    : `${fmt(usd)} USDC charged`;
}

/** Sentence for an action that was cancelled or never dispatched. */
export function noChargeNote(): string {
  return isKeyMode() ? 'No account credits were spent.' : 'No USDC was spent.';
}

/** Trailing reassurance on an approval prompt, before the user answers. */
export function cancelHint(): string {
  return isKeyMode()
    ? 'No account credits are spent if you cancel.'
    : 'No USDC is spent if you cancel.';
}

/**
 * Italic receipt line appended to a markdown tool result, e.g.
 * `_$0.005 paid via x402._`. In key mode the rail is wrong AND the amount is
 * unverifiable locally, so it names neither.
 */
export function receiptLine(usd: number): string {
  return isKeyMode()
    ? '_Billed to account credits._'
    : `_${fmt(usd)} paid via x402._`;
}
