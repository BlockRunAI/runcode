/**
 * Which gateway pays for this process — the x402 wallet or a prepaid API key.
 *
 * Franklin can reach the BlockRun gateway two ways:
 *
 *   wallet — blockrun.ai/api (Base) or sol.blockrun.ai/api (Solana). Every
 *            paid call answers a 402 by signing USDC from the local wallet.
 *   key    — api.blockrun.ai with `Authorization: Bearer brk_...`, settled
 *            against a prepaid credit balance. No chain involved.
 *
 * The two hosts share no auth: a bearer key on blockrun.ai/api is ignored and
 * still 402s, and api.blockrun.ai 401s when the key is absent or bad rather
 * than falling back to x402. That isolation is the backward-compatibility
 * guarantee — with no key configured this module returns exactly the host and
 * headers Franklin used before key mode existed.
 *
 * Every gateway caller in src/ already funnels through `API_URLS[loadChain()]`
 * + `/v1/...`, so swapping in `resolvePayMode().apiBase` and merging
 * `gatewayHeaders()` is enough; the `/v1/...` concatenation is correct in both
 * modes because the key host serves those paths at its root.
 */

import fs from 'node:fs';
import {
  API_URLS,
  API_KEY_FILE,
  BLOCKRUN_DIR,
  KEY_API_URL,
  USER_AGENT,
  loadChain,
  type Chain,
} from '../config.js';

export type PayMode =
  | { kind: 'key'; apiBase: string; key: string }
  | { kind: 'wallet'; apiBase: string; chain: Chain };

/**
 * Keys are `brk_live_` / `brk_test_` + an opaque alphanumeric tail. Validated
 * on the way in so a truncated paste fails at `franklin login` rather than as
 * a confusing 401 twenty calls later.
 */
export const API_KEY_PATTERN = /^brk_(?:live|test)_[A-Za-z0-9]{20,}$/;

export function isApiKeyShaped(value: string): boolean {
  return API_KEY_PATTERN.test(value.trim());
}

/** Mask for display/logs: `brk_live_H4Oz…QBW5`. Never print a whole key. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 18) return 'brk_***';
  return `${trimmed.slice(0, 13)}…${trimmed.slice(-4)}`;
}

let cached: PayMode | null = null;
let forceWallet = false;

/**
 * Force wallet mode for the rest of the process, regardless of any key that is
 * set. Backs the `--wallet` flag so a user with a key on file can still spend
 * from the wallet for one run.
 */
export function useWalletMode(): void {
  forceWallet = true;
  cached = null;
}

/** Refresh a rejected credential without changing the user's payment method. */
export function invalidateKey(): void {
  cached = null;
}

/** Test seam — drop the memoised mode so env/file changes are re-read. */
export function resetPayModeCache(): void {
  cached = null;
  forceWallet = false;
}

function readKeyFile(): string | null {
  try {
    const raw = fs.readFileSync(API_KEY_FILE, 'utf-8').trim();
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot read the saved API key. Fix its permissions or explicitly use --wallet.');
  }
}

/** The key Franklin would use, from env first then disk. Null when unset. */
export function loadApiKey(): string | null {
  const fromEnv = process.env.BLOCKRUN_API_KEY?.trim();
  if (fromEnv !== undefined) return fromEnv;
  return readKeyFile();
}

export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
  fs.writeFileSync(API_KEY_FILE, trimmed + '\n', { mode: 0o600 });
  cached = null;
}

export function clearApiKey(): boolean {
  try {
    fs.unlinkSync(API_KEY_FILE);
    cached = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active payment mode. Memoised per process — the resolution reads
 * the filesystem and is hit on every gateway call.
 *
 * Precedence: `--wallet` > BLOCKRUN_API_KEY > ~/.blockrun/api-key
 * > wallet on the active chain.
 */
export function resolvePayMode(): PayMode {
  if (cached) return cached;

  if (!forceWallet) {
    const key = loadApiKey();
    if (key !== null) {
      if (!isApiKeyShaped(key)) {
        throw new Error('Invalid API key in BLOCKRUN_API_KEY or the saved key file. Correct it, remove it, or explicitly use --wallet.');
      }
      cached = { kind: 'key', apiBase: KEY_API_URL, key };
      return cached;
    }
  }

  const chain = loadChain();
  cached = { kind: 'wallet', apiBase: API_URLS[chain], chain };
  return cached;
}

/** True when the next gateway call will authenticate with a key. */
export function isKeyMode(): boolean {
  return resolvePayMode().kind === 'key';
}

/**
 * The gateway base URL for the active mode. Drop-in replacement for the
 * `API_URLS[loadChain()]` that call sites used before key mode.
 */
export function gatewayBase(): string {
  return resolvePayMode().apiBase;
}

/** The x402 base for an explicitly selected wallet chain. */
export function walletBase(chain: Chain = loadChain()): string {
  return API_URLS[chain];
}

/**
 * Auth + identity headers for the active mode. Empty of auth in wallet mode,
 * where payment rides on the PAYMENT-SIGNATURE header instead.
 */
export function gatewayHeaders(mode: PayMode = resolvePayMode()): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (mode.kind === 'key') headers['Authorization'] = `Bearer ${mode.key}`;
  return headers;
}

/**
 * A key's credit standing, from GET /v1/credits. The authoritative figure for
 * display — the per-response `x-blockrun-credit-remaining-usd` header can
 * understate under concurrency and is for warnings, not for showing a user.
 */
export interface CreditBalance {
  accountId: string;
  /**
   * `ungated` accounts have NO ceiling, so `remainingUsd` is legitimately null.
   * Never coalesce that to 0 — it would tell a paying customer they are broke.
   * Branch on this field instead.
   */
  billingMode: string;
  currency: string;
  grantedUsd: number;
  spentUsd: number;
  remainingUsd: number | null;
  blocked: boolean;
  /**
   * A stable CODE to map, not a string to show: ACCOUNT_SUSPENDED,
   * CREDIT_LIMIT_REACHED, BALANCE_EXHAUSTED. Treated as append-only, so an
   * unrecognised value must degrade gracefully rather than throw.
   */
  blockedReason: string | null;
}

/**
 * Fetch the key's credit standing. Null when there is no key, the gateway is
 * unreachable, or it answers with something unexpected — callers show what they
 * do know rather than inventing a number.
 *
 * `blocked` describes what the gateway would do with the NEXT call, so it is
 * safe to gate an autonomous run on.
 */
export async function fetchCreditBalance(timeoutMs = 15_000): Promise<CreditBalance | null> {
  const key = loadApiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${KEY_API_URL}/v1/credits`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      accountId: typeof b.account_id === 'string' ? b.account_id : 'unknown',
      billingMode: typeof b.billing_mode === 'string' ? b.billing_mode : 'unknown',
      currency: typeof b.currency === 'string' ? b.currency : 'USD',
      grantedUsd: num(b.granted_usd),
      spentUsd: num(b.spent_usd),
      // Explicitly preserve null — the whole point of this field.
      remainingUsd: typeof b.remaining_usd === 'number' && Number.isFinite(b.remaining_usd)
        ? b.remaining_usd
        : null,
      blocked: b.blocked === true,
      blockedReason: typeof b.blocked_reason === 'string' ? b.blocked_reason : null,
    };
  } catch {
    return null;
  }
}

/**
 * Merge this mode's auth into a header bag that may already carry a client's
 * own credential, in place.
 *
 * Node lowercases inbound header names while `gatewayHeaders()` returns the
 * canonical `Authorization`, so a plain object happily holds both — and
 * `fetch` then sends two Authorization headers. The gateway reads the client's
 * and answers 401. Every case variant is dropped before ours goes in, so
 * exactly one survives.
 *
 * Only used where Franklin forwards someone else's request (the payment
 * proxy). Direct callers build their headers from scratch and can spread
 * `gatewayHeaders()` instead.
 */
export function applyGatewayAuth(
  headers: Record<string, string>,
  mode: PayMode = resolvePayMode(),
): Record<string, string> {
  const auth = gatewayHeaders(mode);
  if (auth.Authorization) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') delete headers[key];
    }
  }
  Object.assign(headers, auth);
  return headers;
}

/** Classify account errors for display; neither error authorizes wallet billing. */
export type KeyFailure = 'invalid-key' | 'unsupported-endpoint' | null;

export function classifyKeyFailure(status: number, body: string): KeyFailure {
  if (status === 401) return 'invalid-key';
  if (status === 404 && body.includes('unsupported_endpoint')) return 'unsupported-endpoint';
  return null;
}

/**
 * Rewrite a key-host URL after the user explicitly selects wallet mode. The two
 * differ by the `/api` segment the wallet hosts carry, so this swaps the
 * origin and re-adds it rather than a plain string replace.
 */
export function toWalletUrl(url: string, chain: Chain = loadChain()): string {
  if (!url.startsWith(KEY_API_URL)) return url;
  return API_URLS[chain] + url.slice(KEY_API_URL.length);
}
