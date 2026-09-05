/**
 * WalletReservation — local accounting layer for concurrent paid tool calls.
 *
 * Problem this solves: when N paid tool calls (today: the Modal sandbox
 * tools) run in parallel, each independently checks balance and dispatches
 * its x402 payment. With balance $0.20 and 6 calls × $0.04 each, all 6 see "$0.20
 * available, $0.04 fits" and start; only 5 can actually settle on-chain,
 * the rest fail mid-flight with insufficient-funds and the user sees
 * partial completion with no preflight warning.
 *
 * The fix is *not* on-chain — x402 is fire-and-forget per-request, there's
 * no real "hold" capability. Instead this is a per-process bookkeeping
 * layer:
 *   1. Tool calls hold(amount) before paying.
 *   2. hold() refuses if (balance - sum(active reservations)) < amount.
 *   3. After payment succeeds OR fails, tool calls release(token).
 *   4. If the outcome is AMBIGUOUS — the signed request was dispatched and
 *      then aborted / timed out before a response came back — the caller
 *      marks the token ambiguous instead. The gateway may have settled the
 *      payment on-chain, so the amount stays counted against headroom for
 *      a grace window and is dropped on the next fresh balance fetch that
 *      STARTED after the window closed (so the read reflects the real
 *      on-chain state). The window is sized by the caller from its own
 *      request timeout: the gateway may still be running the paid work when
 *      we abort, and settlement lands when that work finishes. The cap can
 *      only err tight, never loose.
 *
 * Single-process JS guarantees the check-and-set is atomic (no real race),
 * and balance is cached briefly so we don't hit the RPC for every hold.
 */

import { setupAgentWallet, setupAgentSolanaWallet } from '@blockrun/llm';
import { loadChain } from '../config.js';
import { fetchCreditBalance, isKeyMode } from '../payments/auth-mode.js';

export interface ReservationToken {
  id: string;
  amountUsd: number;
}

const BALANCE_CACHE_MS = 5_000;
/**
 * Settlement margin added on top of the caller-supplied request timeout for
 * an ambiguous-settlement hold. The window starts at OUR abort, not at the
 * gateway's settlement: if the gateway settles after the paid work finishes,
 * that can be up to the request timeout later, plus on-chain confirmation.
 * Callers pass `graceMs = timeoutMs + AMBIGUOUS_GRACE_MS`.
 */
export const AMBIGUOUS_GRACE_MS = 30_000;

async function readSpendableBalance(): Promise<number> {
  // Key mode has no wallet to read. Gating on one made every Modal call fail
  // with "Insufficient USDC — fund the wallet" for a user whose account
  // credits were fine, because an unfunded (or absent) wallet reads $0.
  //
  // The right ceiling in key mode is the prepaid balance, so use it when the
  // gateway reports one. `remainingUsd: null` means an ungated account with
  // no ceiling, and a null balance means the gateway was unreachable — in
  // both cases return Infinity rather than invent a limit. That is not
  // "unbounded": the gateway still 402s when credits run out, and --max-spend
  // still bounds the session. This layer only prevents Franklin from
  // over-committing against a balance it can actually see.
  if (isKeyMode()) {
    const credit = await fetchCreditBalance().catch(() => null);
    return credit?.remainingUsd ?? Number.POSITIVE_INFINITY;
  }
  if (loadChain() === 'solana') {
    const client = await setupAgentSolanaWallet({ silent: true });
    return client.getBalance();
  }
  const client = setupAgentWallet({ silent: true });
  return client.getBalance();
}

class WalletReservationManager {
  private reserved = new Map<string, number>();
  private ambiguous = new Map<string, { amountUsd: number; expiresAt: number }>();
  private cachedBalance: { value: number; fetchedAt: number } | null = null;
  private balanceFetchInflight: Promise<number> | null = null;
  private balanceFetcher: () => Promise<number> = readSpendableBalance;

  private async fetchBalance(): Promise<number> {
    if (this.cachedBalance && Date.now() - this.cachedBalance.fetchedAt < BALANCE_CACHE_MS) {
      return this.cachedBalance.value;
    }
    if (this.balanceFetchInflight) return this.balanceFetchInflight;

    // Sample the clock BEFORE the read goes out: a read that started inside
    // an ambiguous entry's window cannot be trusted to reflect it, however
    // long the RPC took to answer.
    const startedAt = Date.now();
    this.balanceFetchInflight = (async () => {
      try {
        const v = await this.balanceFetcher();
        // A real on-chain read already includes any ambiguous spend that
        // settled; drop entries whose window closed before this read began
        // so a genuinely-absent spend self-heals instead of pinning headroom.
        // Only on a real read: the Infinity fallback below reflects nothing.
        for (const [id, entry] of this.ambiguous) {
          if (entry.expiresAt <= startedAt) this.ambiguous.delete(id);
        }
        return v;
      } catch {
        // If balance fetch fails, return Infinity so reservations don't
        // block — the actual payment will surface the real error. We'd
        // rather under-protect than block all paid tools on RPC flakiness.
        return Number.POSITIVE_INFINITY;
      }
    })()
      .then((v) => {
        this.cachedBalance = { value: v, fetchedAt: Date.now() };
        this.balanceFetchInflight = null;
        return v;
      });

    return this.balanceFetchInflight;
  }

  private totalReserved(): number {
    let sum = 0;
    for (const v of this.reserved.values()) sum += v;
    for (const e of this.ambiguous.values()) sum += e.amountUsd;
    return sum;
  }

  /**
   * Try to reserve `amountUsd`. Returns a token on success, or null if
   * insufficient (balance - already-reserved < amountUsd). Caller MUST
   * release the token after the actual payment resolves, success or fail.
   */
  async hold(amountUsd: number): Promise<ReservationToken | null> {
    if (amountUsd <= 0) {
      // Free / zero-cost calls don't need accounting.
      return { id: `free-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, amountUsd: 0 };
    }
    const balance = await this.fetchBalance();
    const available = balance - this.totalReserved();
    if (available < amountUsd) return null;

    const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.reserved.set(id, amountUsd);
    return { id, amountUsd };
  }

  /**
   * Release a hold. Idempotent — releasing the same token twice is a no-op.
   * Invalidate the balance cache so the next hold sees up-to-date state.
   */
  release(token: ReservationToken | string | null | undefined): void {
    if (!token) return;
    const id = typeof token === 'string' ? token : token.id;
    if (this.reserved.delete(id)) {
      // A real payment may have just settled on-chain; force re-fetch
      // next time so subsequent holds see the post-payment balance.
      this.cachedBalance = null;
    }
  }

  /**
   * Mark a hold as ambiguous: the signed payment was dispatched but the
   * request aborted / timed out before we saw the outcome. The money may be
   * gone, so keep the amount counted against headroom (see header) for
   * `graceMs` (default AMBIGUOUS_GRACE_MS; callers add their request
   * timeout). A later release() of the same token is a no-op — the ambiguous
   * entry outlives it. Idempotent: a second call for the same id is a no-op.
   */
  markAmbiguous(token: ReservationToken | string | null | undefined, graceMs = AMBIGUOUS_GRACE_MS): void {
    if (!token) return;
    const id = typeof token === 'string' ? token : token.id;
    const amountUsd = this.reserved.get(id);
    if (amountUsd === undefined || amountUsd <= 0) return;
    this.reserved.delete(id);
    this.ambiguous.set(id, { amountUsd, expiresAt: Date.now() + Math.max(0, graceMs) });
    this.cachedBalance = null;
  }

  /** Force the next hold() to refetch balance from chain. */
  invalidateBalance(): void {
    this.cachedBalance = null;
  }

  /** Snapshot of current reservation state — diagnostic / testing only. */
  snapshot(): { count: number; totalUsd: number; ambiguousCount: number; ambiguousUsd: number } {
    let ambiguousUsd = 0;
    for (const e of this.ambiguous.values()) ambiguousUsd += e.amountUsd;
    return {
      count: this.reserved.size,
      totalUsd: this.totalReserved(),
      ambiguousCount: this.ambiguous.size,
      ambiguousUsd,
    };
  }

  /** Testing only — reset all bookkeeping and cached balance. */
  _resetForTests(fetcher?: () => Promise<number>): void {
    this.reserved.clear();
    this.ambiguous.clear();
    this.cachedBalance = null;
    this.balanceFetchInflight = null;
    this.balanceFetcher = fetcher ?? readSpendableBalance;
  }

  /** Testing only — seed the balance cache so hold() never touches RPC. */
  _seedBalanceForTests(value: number): void {
    this.cachedBalance = { value, fetchedAt: Date.now() };
  }

  /** Testing only — shift every ambiguous entry's expiry earlier by `ms`. */
  _ageAmbiguousForTests(ms: number): void {
    for (const e of this.ambiguous.values()) e.expiresAt -= ms;
  }
}

export const walletReservation = new WalletReservationManager();
