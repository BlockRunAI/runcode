/**
 * List prices for the gateway's flat-rate service endpoints.
 *
 * Wallet mode learns what a call costs from the 402 handshake — the amount is
 * in the payment requirements, so the recorded spend is exact. API-key mode
 * has no handshake: the gateway settles against a prepaid balance and answers
 * 200 with no charge amount anywhere in the response. Without a price source,
 * every paid call in key mode would record $0, which silently disables the
 * --max-spend ceiling, the PreSpend hooks and every budget in the product.
 *
 * BlockRun publishes machine-readable prices at `/.well-known/x402`, so that
 * is the source of truth here rather than constants scattered across tools
 * (which had already drifted — surf.ts documented tiered $0.001/$0.005/$0.02
 * against a catalog that says a flat $0.0085).
 *
 * Scope is deliberately narrow: **flat-rate service endpoints only**.
 * Model-priced endpoints — chat, images, video, speech — are already costed by
 * `gateway-models.ts` from the live model catalog, and that path works
 * identically in both modes.
 *
 * Prices from this module are estimates. Callers must tag what they record so
 * the audit trail never claims more precision than it has.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BLOCKRUN_DIR, USER_AGENT } from '../config.js';
import { logger } from '../logger.js';
import { GATEWAY_TRANSACTION_FEE_USD } from '../gateway-models.js';

/**
 * Always the Base origin — because it is the only host serving the SHAPE this
 * module parses, not because it is the only one that publishes prices.
 *
 * Measured 2026-09-05:
 *   blockrun.ai/.well-known/x402      68KB, `services[]` with per-endpoint prices
 *   sol.blockrun.ai/.well-known/x402   4KB, x402scan v1 fallback shape:
 *                                      {version: 1, resources: [114 strings]},
 *                                      no `services`, no prices
 *   sol.blockrun.ai/openapi.json      34 paths priced under `x-payment-info`
 *   api.blockrun.ai/.well-known/x402  404
 *
 * So sol does publish prices, just in a different document and schema that
 * parsePricing does not read. Do not "fix" this to fetch /.well-known per host:
 * fetchCatalog bails on a missing `services[]`, so the sol origin would freeze
 * every price at the static floor below with nothing reporting it.
 *
 * Do not switch to sol's openapi prices either, which is the tempting move once
 * you know they exist. They currently disagree with what sol itself quotes and
 * settles. For /v1/surf/market/fear-greed on 2026-09-05:
 *
 *   sol openapi.json publishes   $0.001
 *   sol 402 quotes and settles   $0.0075   (measured against a funded wallet)
 *   this Base card publishes     $0.0085
 *
 * The payment layer charges one flat rate across Surf while sol's sheet still
 * lists three tiers, so nine Surf endpoints publish 7.5x under what they
 * charge. Until that is reconciled the Base card is the closer predictor of a
 * real sol Surf charge, which is the opposite of what you would assume.
 *
 * The remaining Base-vs-Solana gap is the service fee: Solana charges none
 * (SERVICE_FEE_USD = 0 in the sol gateway), so a settled Solana call runs
 * $0.001 under this card. None of this touches the amount recorded for a
 * settled wallet call, which uses the exact 402 figure and never reaches this
 * module — it only bounds how precise a catalog-priced estimate can be.
 */
const CATALOG_URL = 'https://blockrun.ai/.well-known/x402';
const CACHE_FILE = path.join(BLOCKRUN_DIR, 'price-catalog.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // prices move rarely; a stale read is cheap
const FETCH_TIMEOUT_MS = 8_000;

interface CatalogEntry {
  /** Endpoint pattern as published, e.g. `/api/v1/surf/*`. */
  endpoint: string;
  /** USD per request, or 0 for a free endpoint. */
  usd: number;
}

/**
 * Offline floor, current as of 2026-09-05. Used before the first successful
 * fetch and whenever the network is unavailable, so key mode never falls back
 * to recording zero. Refreshed automatically from the live catalog.
 */
const STATIC_CATALOG: CatalogEntry[] = [
  { endpoint: '/api/v1/surf/*', usd: 0.0085 },
  { endpoint: '/api/v1/exa/contents', usd: 0.003 },
  { endpoint: '/api/v1/exa/*', usd: 0.011 },
  { endpoint: '/api/v1/rpc/{network}', usd: 0.003 },
  { endpoint: '/api/v1/pm/*', usd: 0.0085 },
  { endpoint: '/api/v1/defillama/*', usd: 0.006 },
  { endpoint: '/api/v1/phone/*', usd: 0.011 },
  { endpoint: '/api/v1/voice/call', usd: 0.541 },
  { endpoint: '/api/v1/modal/sandbox/create', usd: 0.011 },
  { endpoint: '/api/v1/modal/*', usd: 0.002 },
  { endpoint: '/api/v1/realface/*', usd: 0.011 },
  { endpoint: '/api/v1/portrait/*', usd: 0.011 },
  { endpoint: '/api/v1/polymarket/fund', usd: 0.011 },
  { endpoint: '/api/v1/usstock/price/{ticker}', usd: 0.002 },
  { endpoint: '/api/v1/search', usd: 0.025 },
  // Explicitly free — listed so a lookup returns 0 rather than "unknown",
  // which would make callers fall back to a non-zero guess.
  { endpoint: '/api/v1/zerox/*', usd: 0 },
  { endpoint: '/api/v1/crypto/price/{pair}', usd: 0 },
  { endpoint: '/api/v1/fx/price/{pair}', usd: 0 },
  { endpoint: '/api/v1/commodity/price/{symbol}', usd: 0 },
  { endpoint: '/api/v1/onramp/token', usd: 0 },
  { endpoint: '/api/v1/models', usd: 0 },
];

let catalog: CatalogEntry[] = STATIC_CATALOG;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;

// ─── Price parsing ──────────────────────────────────────────────────────

/** `"$0.0085"` / `"0.006"` / `0.003` → 0.0085 / 0.006 / 0.003. Null if unparseable. */
function toUsd(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/^\$/, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce one service's `pricing` object to a single per-request USD figure,
 * plus any nested endpoint-specific overrides it declares.
 *
 * The catalog uses several shapes for the same idea — `perRequest`, `perCall`,
 * `flat`, `tierN.perRequest`, and grouped `{ endpoints: [...] }` lists. Only
 * flat-rate shapes are handled; per-model maps (chat, images, video, speech)
 * return null because `gateway-models.ts` prices those from the model catalog.
 */
function parsePricing(
  endpoint: string,
  pricing: unknown,
): CatalogEntry[] {
  if (!pricing || typeof pricing !== 'object') return [];
  const p = pricing as Record<string, unknown>;
  const out: CatalogEntry[] = [];

  if (p.free === true) return [{ endpoint, usd: 0 }];

  const direct = toUsd(p.perRequest) ?? toUsd(p.perCall) ?? toUsd(p.flat) ?? toUsd(p.perUrl);
  if (direct !== null) out.push({ endpoint, usd: direct });

  // Live search is billed per source queried. Franklin's Search tool sends one
  // source unless the caller widens it, so the single-source price is the
  // floor. A multi-source call is under-counted rather than guessed at — the
  // dashboard remains the authority on the exact figure.
  const perSource = toUsd(p.pricePerSource);
  if (perSource !== null) out.push({ endpoint, usd: perSource });

  // Nested groups: { tier1: {...}, tier2: {...} } and
  // { create: { perRequest, endpoint }, operations: { perRequest, endpoints: [] } }.
  for (const [key, value] of Object.entries(p)) {
    if (!value || typeof value !== 'object' || key === 'payment') continue;
    const group = value as Record<string, unknown>;
    const usd = toUsd(group.perRequest) ?? toUsd(group.perCall) ?? toUsd(group.perUrl);
    if (usd === null) continue;

    const own = typeof group.endpoint === 'string' ? [group.endpoint] : [];
    const many = Array.isArray(group.endpoints)
      ? group.endpoints.filter((e): e is string => typeof e === 'string')
      : [];
    const targets = [...own, ...many];

    if (targets.length > 0) for (const t of targets) out.push({ endpoint: t, usd });
    // A bare tier with no endpoint list prices the whole service. Take the
    // dearest tier so an estimate errs toward over-counting, which is the safe
    // direction for a spend ceiling.
    else if (!out.some((e) => e.endpoint === endpoint && e.usd >= usd)) {
      out.push({ endpoint, usd });
    }
  }

  // A service listing per-endpoint prices as a flat array.
  if (Array.isArray(p.endpoints)) {
    for (const item of p.endpoints) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const usd = toUsd(row.perRequest) ?? toUsd(row.perCall);
      if (typeof row.endpoint === 'string' && usd !== null) {
        out.push({ endpoint: row.endpoint, usd });
      }
    }
  }

  return out;
}

// ─── Pattern matching ───────────────────────────────────────────────────

/**
 * Turn a published endpoint pattern into a matcher.
 *
 *   `/api/v1/surf/*`                          → any path under /surf/
 *   `/api/v1/rpc/{network}`                   → one path segment
 *   `/api/v1/pm/{limitless,opinion}/*`        → one of the listed segments
 */
function patternToRegExp(pattern: string): RegExp {
  let src = '';
  for (const part of pattern.split('/')) {
    if (part === '') continue;
    src += '/';
    if (part === '*') {
      src += '.*';
    } else if (part.startsWith('{') && part.endsWith('}')) {
      const inner = part.slice(1, -1);
      // A brace group may itself contain slashes and nested braces, e.g.
      // `{identity/{wallet},identities}` — too irregular to model exactly, so
      // treat any such group as "one or more segments".
      src += inner.includes(',') || inner.includes('/') ? '[^?]+' : '[^/?]+';
    } else {
      src += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${src}/?$`);
}

/** Specificity: more literal segments and no wildcard wins. */
function specificity(pattern: string): number {
  const segments = pattern.split('/').filter(Boolean);
  const literal = segments.filter((s) => s !== '*' && !s.startsWith('{')).length;
  return literal * 10 - (pattern.includes('*') ? 1 : 0);
}

// ─── Cache ──────────────────────────────────────────────────────────────

function readDiskCache(): void {
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as CatalogEntry[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      catalog = parsed;
      loadedAt = stat.mtimeMs;
    }
  } catch { /* no cache, or unreadable — the static floor covers it */ }
}

function writeDiskCache(entries: CatalogEntry[]): void {
  try {
    fs.mkdirSync(BLOCKRUN_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entries), { mode: 0o600 });
  } catch { /* best-effort — an in-memory catalog still works */ }
}

async function fetchCatalog(): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { services?: unknown };
    if (!Array.isArray(body.services)) {
      // The one failure that would otherwise be invisible: a 200 with no
      // priced catalog leaves every estimate pinned to the static floor
      // forever, and nothing else in the product would ever say so. The sol
      // origin's discovery doc has exactly this shape, so this fires the
      // moment someone repoints CATALOG_URL at it.
      logger.warn(
        `[franklin] price catalog at ${CATALOG_URL} returned no services[] — ` +
        'estimates will stay on the built-in floor'
      );
      return;
    }

    const entries: CatalogEntry[] = [];
    for (const svc of body.services) {
      if (!svc || typeof svc !== 'object') continue;
      const s = svc as Record<string, unknown>;
      if (typeof s.endpoint !== 'string') continue;
      entries.push(...parsePricing(s.endpoint, s.pricing));
    }
    if (entries.length === 0) return;

    // Keep the static floor underneath so an endpoint the catalog stops
    // listing does not silently become free.
    const merged = new Map<string, number>();
    for (const e of STATIC_CATALOG) merged.set(e.endpoint, e.usd);
    for (const e of entries) merged.set(e.endpoint, e.usd);
    catalog = [...merged].map(([endpoint, usd]) => ({ endpoint, usd }));
    loadedAt = Date.now();
    writeDiskCache(catalog);
  } catch { /* offline — the static floor covers it */ } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the catalog in the background. Safe to call repeatedly; only one
 * fetch is ever in flight and it is skipped while the cache is fresh.
 */
export function warmPriceCatalog(): void {
  if (loadedAt === 0) readDiskCache();
  if (Date.now() - loadedAt < CACHE_TTL_MS) return;
  if (inFlight) return;
  inFlight = fetchCatalog().finally(() => { inFlight = null; });
}

/** Test seam — drop the loaded catalog and fall back to the static floor. */
export function __resetPriceCatalog(): void {
  catalog = STATIC_CATALOG;
  loadedAt = 0;
  inFlight = null;
}

/** Test seam — install a catalog without touching the network or disk. */
export function __primePriceCatalog(entries: CatalogEntry[]): void {
  catalog = entries;
  loadedAt = Date.now();
}

// ─── Lookup ─────────────────────────────────────────────────────────────

/**
 * List price in USD for one gateway path, or null when the path is not a
 * flat-rate service endpoint (chat and the other model-priced endpoints land
 * here, and are costed from the model catalog instead).
 *
 * `apiPath` may be a bare path or a full URL, with or without the `/api`
 * prefix and with or without a query string — the two payment hosts differ on
 * the prefix and callers should not have to care.
 *
 * Synchronous by design: it is called on the response path of every paid tool,
 * where an await would serialise the accounting behind a network fetch. The
 * catalog refreshes in the background via `warmPriceCatalog()`.
 */
export function priceForPath(apiPath: string): number | null {
  warmPriceCatalog();

  // Accept a bare path or a full gateway URL — call sites already hold the
  // absolute endpoint they fetched, and making them slice it would just
  // duplicate this logic 8 times.
  let normalized = apiPath;
  if (/^https?:\/\//.test(normalized)) {
    try { normalized = new URL(normalized).pathname; } catch { /* fall through */ }
  }
  normalized = normalized.split('?')[0];
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  // The x402 hosts serve these routes under /api, the key host at the root.
  // Catalog patterns use the /api form, so normalise onto that.
  if (!normalized.startsWith('/api/')) normalized = '/api' + normalized;

  let best: { usd: number; score: number } | null = null;
  for (const entry of catalog) {
    if (!patternToRegExp(entry.endpoint).test(normalized)) continue;
    const score = specificity(entry.endpoint);
    if (!best || score > best.score) best = { usd: entry.usd, score };
  }
  return best ? best.usd : null;
}


/**
 * The base price for an endpoint — what the API-key rail charges — or null
 * when the endpoint is not catalogued.
 *
 * There are two real prices per endpoint and one literal cannot serve both.
 * The catalog and the 402 challenge both state the WALLET price, which is the
 * base plus a settlement fee. The key rail charges the base and no fee, which
 * is why it issues no 402 at all.
 *
 * Measured 2026-09-05 via x-blockrun-cost-usd against the unsigned 402:
 *
 *   endpoint    402 / catalog    key rail charges
 *   surf        $0.0085          $0.0075
 *   rpc         $0.0030          $0.0020
 *   exa search  $0.0110          $0.0100
 *   defillama   $0.0060          $0.0050
 *
 * Exactly one fee apart, every time. Quoting the 402 figure to a key-mode user
 * overstates every call by $0.001 — small in absolute terms and 50% on a
 * $0.002 RPC call.
 */
export function basePriceForPath(apiPath: string): number | null {
  const wallet = priceForPath(apiPath);
  if (wallet === null) return null;
  if (wallet <= 0) return wallet; // free stays free on both rails
  const base = wallet - GATEWAY_TRANSACTION_FEE_USD;
  return base > 0 ? +base.toFixed(6) : wallet;
}

/**
 * The exact amount BlockRun charged for this call, from
 * `x-blockrun-cost-usd`, or null when the response does not state one.
 *
 * Live on the pre-priced service families (exa, surf, pm, phone, modal,
 * speech, images, rpc, defillama). Deliberately and permanently ABSENT on
 * chat, which settles after the answer is on the wire (`x-settlement-async`)
 * — at header-writing time the amount does not exist yet, and waiting for it
 * would mean holding the customer's response until the money lands. Chat is
 * reconstructed from tokens x published rate instead.
 *
 * Absent means "no charge settled at response time", NOT "free" — reading it
 * as $0 would zero out chat, the largest spend category. A charge that really
 * did settle at zero is written explicitly as `0.000000`, so 0 is a value and
 * missing is not.
 *
 * Empty, malformed and negative are all treated as absent. `Number('')` is 0
 * in JS, which would book $0 against a billed call.
 */
export function chargeFromResponse(res: HeaderBag): number | null {
  return usdHeader(res, 'x-blockrun-cost-usd');
}

/**
 * The gateway's id for this request, from `x-blockrun-request-id`.
 *
 * Recorded locally so `franklin usage` can join Franklin's journal to the
 * account ledger row by row. Comparing totals is not the same check: two
 * errors of opposite sign produce a total that matches and a ledger that is
 * wrong in two places.
 */
export function requestIdFromResponse(res: HeaderBag): string | null {
  const raw = res.headers?.get?.('x-blockrun-request-id');
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id.length > 0 && id.length <= 128 ? id : null;
}

/**
 * Credit left on the account after this call, from
 * `x-blockrun-credit-remaining-usd`. Absent on ungated accounts, which have no
 * ceiling and so nothing to report — that is correct, not a failure.
 *
 * It can understate and never overstates: the figure is read inside the
 * reservation transaction, already net of concurrent in-flight holds. That is
 * the right error direction for a pre-run low-balance warning (warn early
 * rather than fail to warn), and the wrong one for display — GET /v1/credits
 * is the authority for a number shown to a user.
 */
export function remainingCreditFromResponse(res: HeaderBag): number | null {
  return usdHeader(res, 'x-blockrun-credit-remaining-usd');
}

interface HeaderBag { headers: { get(name: string): string | null } }

/**
 * Shared parse for both money headers. 0 is a value; empty, malformed and
 * negative are all absence. `Number('')` is 0 in JS, which would book $0
 * against a billed call.
 */
function usdHeader(res: HeaderBag, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * The amount to record for a completed paid call.
 *
 * `settledUsd` is the exact figure from an x402 settlement and always wins.
 * `reportedUsd` is a charge the endpoint itself returned (Exa's `costDollars`).
 * Otherwise the call is priced from the catalog — an estimate, flagged as such
 * so `franklin stats` can render it honestly.
 */
export interface ResolvedCharge {
  usd: number;
  estimated: boolean;
}

export function resolveCharge(opts: {
  apiPath: string;
  /** From `x-blockrun-cost-usd` — what BlockRun actually charged. Wins outright. */
  chargedUsd?: number | null;
  settledUsd?: number;
  reportedUsd?: number;
  fallbackUsd?: number;
}): ResolvedCharge {
  const { apiPath, chargedUsd, settledUsd, reportedUsd, fallbackUsd } = opts;
  // The gateway stating its own charge beats every other source, including a
  // settled x402 amount. 0 is a real answer here, so test for null, not truth.
  if (typeof chargedUsd === 'number') {
    return { usd: chargedUsd, estimated: false };
  }
  if (typeof settledUsd === 'number' && settledUsd > 0) {
    return { usd: settledUsd, estimated: false };
  }
  // An upstream provider's self-reported cost is NOT what BlockRun charged.
  // Measured 2026-09-05: Exa reported costDollars $0.007 on a call BlockRun
  // charged $0.010 for. Treating it as exact booked a wrong number with false
  // confidence, which is worse than a hedged one — so it now ranks below the
  // catalog price and is tagged estimated like any other guess.
  if (typeof reportedUsd === 'number' && reportedUsd > 0) {
    const listed = priceForPath(apiPath);
    return { usd: listed !== null && listed > 0 ? listed : reportedUsd, estimated: true };
  }
  const listed = priceForPath(apiPath);
  if (listed !== null) return { usd: listed, estimated: true };
  if (typeof fallbackUsd === 'number' && fallbackUsd > 0) {
    return { usd: fallbackUsd, estimated: true };
  }
  return { usd: 0, estimated: true };
}
