/**
 * PredictionMarket — unified access to Polymarket / Kalshi / Limitless /
 * Opinion / Predict.Fun / cross-platform / smart-money / wallet endpoints
 * via the BlockRun gateway. Each call settles via x402 against the user's
 * USDC wallet.
 *
 * Powered server-side by Predexon; surfaced to the agent as a single
 * action-dispatched tool so the inventory stays small. Keep one cohesive
 * tool — the way TradingMarket bundles 6 actions — instead of forty
 * one-shot capabilities, otherwise weak models start hallucinating tool
 * names.
 *
 *   searchAll          $0.005  search markets across Polymarket+Kalshi+
 *                              Limitless+Opinion+Predict.Fun in one call
 *   searchPolymarket   $0.001  query Polymarket markets (event filter, sort)
 *   searchKalshi       $0.001  query Kalshi markets
 *   crossPlatform      SUNSET  Predexon discontinued market matching
 *                              2026-07-20 (upstream 410; gateway de-registered
 *                              it 2026-08-03). Kept as a zero-cost tombstone
 *                              that steers callers to searchAll, whose
 *                              canonical containers already span venues.
 *   leaderboard        $0.001  global Polymarket leaderboard — top wallets by P&L
 *   walletProfile      $0.005  full Polymarket wallet profile (single wallet)
 *                              or batch profiles (comma-separated wallets)
 *   walletPnl          $0.005  P&L summary + realized P&L time series for one
 *                              Polymarket wallet
 *   walletPositions    $0.005  open + historical positions for one Polymarket
 *                              wallet
 *   smartActivity      $0.005  discover markets where high-performing wallets
 *                              are active right now
 *   smartMoney         $0.005  smart-money positioning on one Polymarket
 *                              condition_id (per-market drill-down)
 *
 * Output is filtered + truncated on the way back so a single call never
 * dumps 100 markets into the agent's context. Default 20 rows; agents that
 * need more should narrow the search.
 */

import {
  getOrCreateWallet,
  getOrCreateSolanaWallet,
  createPaymentPayload,
  createSolanaPaymentPayload,
  parsePaymentRequired,
  extractPaymentDetails,
  solanaKeyToBytes,
  SOLANA_NETWORK,
} from '@blockrun/llm';
import type { CapabilityHandler, CapabilityResult, ExecutionScope } from '../agent/types.js';
import { loadChain, VERSION} from '../config.js';
import { chargeFromResponse, requestIdFromResponse, resolveCharge } from '../payments/price-catalog.js';
import { gatewayBase, gatewayHeaders } from '../payments/auth-mode.js';
import { logger } from '../logger.js';
import { recordFetch } from '../trading/providers/telemetry.js';
import { recordUsage } from '../stats/tracker.js';
import { frameUntrusted } from './untrusted.js';
import { receiptLine } from '../payments/billing-copy.js';

const TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Per-action price table — mirrors the Predexon openapi.json. Used to feed
// the Markets-tab telemetry ring buffer so prediction-market spend appears
// in "Calls today / Spend today / Recent paid calls" alongside trading calls.
// If a path isn't here we don't record cost — we still record the fetch
// (success/latency) so panel health stays accurate.
const PATH_PRICES: Array<{ pattern: RegExp; usd: number }> = [
  { pattern: /\/v1\/pm\/markets\/search$/, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/wallets\//, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/wallet\//, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/market\/[^/]+\/smart-money$/, usd: 0.005 },
  { pattern: /\/v1\/pm\/polymarket\/markets\/smart-activity$/, usd: 0.005 },
  { pattern: /\/v1\/pm\/.+/, usd: 0.001 },
];

function priceForPath(path: string): number {
  for (const { pattern, usd } of PATH_PRICES) {
    if (pattern.test(path)) return usd;
  }
  return 0;
}

// ─── Shared GET-with-x402 flow ────────────────────────────────────────────

async function getWithPayment<T>(path: string, query: Record<string, string | number | undefined>, ctx: ExecutionScope): Promise<T> {
  const chain = loadChain();
  const apiUrl = gatewayBase();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    qs.set(k, String(v));
  }
  const queryStr = qs.toString();
  const endpoint = `${apiUrl}${path}${queryStr ? `?${queryStr}` : ''}`;
  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    Accept: 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  const startedAt = Date.now();
  let costRecorded = 0;
  try {
    let response = await fetch(endpoint, { method: 'GET', signal: controller.signal, headers });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
      });
      // Only record cost on the post-402 settlement; the initial 402
      // response is free and counting it would double-charge the panel.
      costRecorded = priceForPath(path);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // Surface failed paid calls in the Markets-tab health summary.
      recordFetch({ provider: 'blockrun', endpoint: path, ok: false, latencyMs: Date.now() - startedAt });
      throw new Error(`PredictionMarket ${path} failed (${response.status}): ${errText.slice(0, 600)}`);
    }

    // `costRecorded` is only set on the post-402 settlement, so it is 0 for
    // every call in API-key mode, where the gateway charges silently. Fall back
    // to this module's own price table, then to the published catalog.
    const charge = resolveCharge({
      apiPath: endpoint,
      chargedUsd: chargeFromResponse(response),
      settledUsd: costRecorded,
      fallbackUsd: priceForPath(path),
    });

    recordFetch({
      provider: 'blockrun',
      endpoint: path,
      ok: true,
      latencyMs: Date.now() - startedAt,
      costUsd: charge.usd > 0 ? charge.usd : undefined,
    });
    // ALSO persist to franklin-stats (recordFetch is in-memory only, lost on
    // restart). Without this, Predexon spend is absent from `franklin stats`
    // and invisible to the --max-spend ceiling (parity with surf.ts).
    try { recordUsage(`PredictionMarket:${path}`, 0, 0, charge.usd, Date.now() - startedAt, false, charge.estimated, requestIdFromResponse(response)); } catch { /* best-effort */ }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
): Promise<Record<string, string> | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;

    if (chain === 'solana') {
      const wallet = await getOrCreateSolanaWallet();
      const paymentRequired = parsePaymentRequired(paymentHeader);
      const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
      const secretBytes = await solanaKeyToBytes(wallet.privateKey);
      const feePayer = details.extra?.feePayer || details.recipient;
      const payload = await createSolanaPaymentPayload(
        secretBytes,
        wallet.address,
        details.recipient,
        details.amount,
        feePayer as string,
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
    const wallet = await getOrCreateWallet();
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`,
      wallet.address,
      details.recipient,
      details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || 'Franklin PredictionMarket call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] PredictionMarket payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch {
      /* ignore */
    }
  }
  return header;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatUsd(value: unknown): string {
  const n = asNumber(value);
  if (n == null) return 'n/a';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatQuantity(value: unknown): string {
  const n = asNumber(value);
  if (n == null) return String(value ?? 'n/a');
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPct(value: unknown, digits = 1): string {
  const n = asNumber(value);
  if (n == null) return 'n/a';
  const pct = Math.abs(n) > 1 ? n : n * 100;
  return `${pct.toFixed(digits)}%`;
}

// Both gateways return slightly different shapes; we intentionally use
// loose typing here because we re-shape into our own markdown anyway.
// Predexon v2 PolymarketMarket shape (verified against openapi-v2.json):
// titles live in `title`, money in `total_volume_usd` / `liquidity_usd`, and
// each outcome is a {label, price} object inside `outcomes` — NOT the old
// flat `volume` / `liquidity` / parallel `outcomes[]`+`outcome_prices[]` this
// tool originally assumed. Those wrong names rendered every metric as `n/a`,
// which pushed the agent to bash-curl the Polymarket Gamma API instead.
// Old names kept as optional fallbacks.
type PolymarketOutcome = { label?: string; price?: number | null; token_id?: string | null };
type PolyMarket = {
  title?: string;
  question?: string;
  market_slug?: string;
  condition_id?: string;
  total_volume_usd?: number;
  liquidity_usd?: number;
  end_time?: string | null;
  close_time?: string | null;
  outcomes?: PolymarketOutcome[] | string[];
  status?: string;
  // Legacy/flat fallbacks.
  volume?: number;
  liquidity?: number;
  end_date?: string;
  outcome_prices?: number[];
};
// Predexon v2 KalshiMarket: price is `last_price` (0–1 probability), not the
// `yes_bid`/`yes_ask` cents this tool assumed (those fields don't exist →
// rendered `n/a`). volume / open_interest names are correct.
type KalshiMarket = {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  yes_subtitle?: string;
  last_price?: number | null;
  volume?: number;
  open_interest?: number;
  status?: string;
  close_time?: string | null;
  // Legacy fallbacks.
  yes_bid?: number;
  yes_ask?: number;
};
// Predexon v2 smart-money response (verified live 2026-05-20): a single
// `positioning` aggregate, NOT buyers/sellers arrays. Reports net buyer/seller
// counts, smart buy/sell volume, and avg prices for wallets meeting the
// criteria. The old buyers/sellers/net_yes_size shape never existed on v2.
type SmartMoneyPositioning = {
  condition_id?: string;
  title?: string;
  smart_wallet_count?: number;
  net_buyers?: number;
  net_sellers?: number;
  neutral?: number;
  net_buyers_pct?: number;
  total_smart_volume?: number;
  total_smart_buy_volume?: number;
  total_smart_sell_volume?: number;
  avg_smart_buy_price?: number;
  avg_smart_sell_price?: number;
  total_smart_realized_pnl?: number;
  avg_smart_roi?: number;
  avg_smart_win_rate?: number;
};
type SmartMoneyResp = {
  smart_wallet_criteria?: Record<string, unknown>;
  window?: string;
  positioning?: SmartMoneyPositioning;
};
// API responses sometimes come wrapped as `{data: [...], pagination: ...}`,
// other times as a bare array. Normalise to an array.
function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.markets)) return obj.markets as T[];
    if (Array.isArray(obj.pairs)) return obj.pairs as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
    if (Array.isArray(obj.positions)) return obj.positions as T[];
    if (Array.isArray(obj.entries)) return obj.entries as T[]; // leaderboard
  }
  return [];
}

function parseWalletsInput(value: string): string[] {
  return value
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);
}

// Predexon's market-list endpoints (polymarket/markets, kalshi/markets,
// markets/search) all validate `status` against StatusOption = {open, closed}
// — verified against openapi-v2.json. Earlier code defaulted Polymarket to
// `active` (the Polymarket Gamma-API convention), which 422s on Predexon.
// Normalize the common synonyms so an explicit `active` / `archived` coming
// from the agent or the user still resolves to a valid value.
// Polymarket leaderboard `sort_by` enum (openapi-v2.json:
// realized_pnl | total_pnl | volume | roi | profit_factor | win_rate | trades).
// Maps the ergonomic values the tool advertises ("pnl | volume | win_rate")
// — and a few obvious synonyms — onto the real enum. Unknown keys resolve to
// undefined so the param is omitted and the gateway uses its own default.
const LEADERBOARD_SORT_ALIASES: Record<string, string> = {
  pnl: 'total_pnl',
  total_pnl: 'total_pnl',
  realized_pnl: 'realized_pnl',
  realized: 'realized_pnl',
  volume: 'volume',
  roi: 'roi',
  profit_factor: 'profit_factor',
  win_rate: 'win_rate',
  winrate: 'win_rate',
  trades: 'trades',
};

// smartActivity and smart-money both REQUIRE at least one smart-wallet
// criterion (min_realized_pnl / min_total_pnl / min_roi / …) or Predexon 400s
// with "At least one smart wallet criterion must be specified" — verified live
// 2026-05-20. The old code sent none, so both endpoints failed every call.
// Default to a sensible "smart = profitable" floor; the agent can still pass
// its own threshold via the `minTotalPnl` input.
const DEFAULT_SMART_MIN_TOTAL_PNL = 10000;

function normalizeMarketStatus(status: string | undefined): string | undefined {
  if (!status) return status;
  const s = status.trim().toLowerCase();
  if (s === 'active' || s === 'open' || s === 'live') return 'open';
  if (s === 'closed' || s === 'archived' || s === 'resolved' || s === 'inactive') return 'closed';
  return s;
}

/**
 * Pick the first usable string from a list of candidate values.
 *
 * Predexon responses sometimes wrap titles/labels inside nested objects
 * (e.g. `position.market = { slug, question, title }` instead of a flat
 * `position.title`). Pre-3.15.75 the formatter `as string` cast these
 * objects and ended up rendering `[object Object]` for every position
 * row — verified 2026-05-06 in a real session.
 *
 * Strategy:
 *   - string → return as-is (after trim)
 *   - object → walk a small set of common name-bearing keys
 *     (title, question, slug, name, label, market_slug) and return the
 *     first one that yields a string
 *   - anything else (number / array / null) → skip
 *   - all candidates exhausted → undefined
 */
function pickString(...candidates: unknown[]): string | undefined {
  const NAME_KEYS = ['title', 'question', 'slug', 'name', 'label', 'market_slug', 'event_title'];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (trimmed) return trimmed;
    } else if (c && typeof c === 'object' && !Array.isArray(c)) {
      const obj = c as Record<string, unknown>;
      for (const k of NAME_KEYS) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

// ─── PredictionMarket capability ──────────────────────────────────────────

interface PredictionInput {
  action:
    | 'searchAll'
    | 'searchPolymarket'
    | 'searchKalshi'
    | 'crossPlatform'
    | 'leaderboard'
    | 'walletProfile'
    | 'walletPnl'
    | 'walletPositions'
    | 'smartActivity'
    | 'smartMoney';
  search?: string;
  status?: string;
  sort?: string;
  limit?: number;
  conditionId?: string;
  /** Wallet address — used by walletProfile (single or comma-list), walletPnl, walletPositions. */
  wallets?: string;
  /** Time bucket for walletPnl time series — day | week | month | year | all. Default day. */
  granularity?: string;
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const { action, search, status, sort, limit, conditionId, wallets, granularity } = input as unknown as PredictionInput;
  const cappedLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  if (!action) {
    return {
      output: 'Error: action is required (searchAll | searchPolymarket | searchKalshi | leaderboard | walletProfile | walletPnl | walletPositions | smartActivity | smartMoney)',
      isError: true,
    };
  }

  try {
    switch (action) {
      case 'searchAll': {
        // One $0.005 call across 5 platforms — Polymarket, Kalshi, Limitless,
        // Opinion, Predict.Fun. The right entry point for "is there a market
        // on X anywhere?" — beats firing per-platform searches in parallel.
        // Predexon expects `q` for the search term — verified 2026-05-06 from
        // a live 422: {"detail":[{"type":"missing","loc":["query","q"]}]}.
        // Public input field stays `search` for ergonomic consistency with
        // searchPolymarket / searchKalshi; rename on the wire.
        const raw = await getWithPayment<unknown>('/v1/pm/markets/search', {
          q: search,
          status: normalizeMarketStatus(status),
          sort,
          limit: cappedLimit,
        }, ctx);
        // Predexon returns either a flat list or per-platform buckets.
        // Try the bucket shape first; fall back to a flat list.
        const lines: string[] = [
          `## Cross-platform market search` + (search ? ` · "${search}"` : ''),
          '_Searched Polymarket, Kalshi, Limitless, Opinion, Predict.Fun in one call._',
          '',
        ];
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const obj = raw as Record<string, unknown>;
          const platforms = ['polymarket', 'kalshi', 'limitless', 'opinion', 'predictfun', 'predict_fun'];
          let totalShown = 0;
          for (const p of platforms) {
            const list = unwrapList<Record<string, unknown>>(obj[p]);
            if (list.length === 0) continue;
            const remaining = cappedLimit - totalShown;
            if (remaining <= 0) break;
            const shown = list.slice(0, Math.min(5, remaining));
            lines.push(`### ${p}`);
            shown.forEach((m, i) => {
              const title = pickString(m.title, m.question, m.market, m.event, m.market_slug, m.slug, m.ticker) ?? 'untitled';
              const id = pickString(m.condition_id, m.ticker, m.id);
              const idTag = id ? ` · \`${String(id)}\`` : '';
              const vol = m.volume != null ? ` · vol ${formatUsd(m.volume as number)}` : '';
              lines.push(`${i + 1}. ${title}${idTag}${vol}`);
              totalShown++;
            });
            lines.push('');
          }
          if (totalShown === 0) {
            // Bucket shape but empty — fall back to flat-list interpretation.
            const flat = unwrapList<Record<string, unknown>>(raw);
            if (flat.length === 0) {
              return { output: 'No markets matched across any platform.' };
            }
            flat.slice(0, cappedLimit).forEach((m, i) => {
              const title = pickString(m.title, m.question, m.market, m.event, m.market_slug, m.slug, m.ticker) ?? 'untitled';
              const platform = pickString(m.platform, m.source) ?? 'unknown';
              lines.push(`${i + 1}. **[${platform}]** ${title}`);
            });
          }
        } else {
          const flat = unwrapList<Record<string, unknown>>(raw);
          if (flat.length === 0) {
            return { output: 'No markets matched across any platform.' };
          }
          flat.slice(0, cappedLimit).forEach((m, i) => {
            const title = (m.title || m.question || m.market_slug || m.ticker || 'untitled') as string;
            const platform = (m.platform || m.source || 'unknown') as string;
            lines.push(`${i + 1}. **[${platform}]** ${title}`);
          });
        }
        lines.push(receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'leaderboard': {
        // Global top-wallet ranking. Cheap ($0.001) — the right answer to
        // "who's making money on Polymarket" / "who should I follow".
        // Predexon's param is `sort_by` (enum), NOT `sort` — sending `sort`
        // is silently ignored, so the ranking never honored the agent's
        // intent. Map the ergonomic aliases to the real enum values
        // (verified against openapi-v2.json), drop anything unrecognized so
        // the gateway falls back to its own default rather than 422-ing.
        const sortBy = sort ? LEADERBOARD_SORT_ALIASES[sort.trim().toLowerCase()] : undefined;
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/leaderboard', {
          limit: cappedLimit,
          sort_by: sortBy,
        }, ctx);
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (rows.length === 0) {
          return { output: 'No leaderboard data returned.' };
        }
        const lines: string[] = [
          `## Polymarket leaderboard — top ${rows.length} wallet${rows.length === 1 ? '' : 's'}`,
          '',
        ];
        rows.forEach((r, i) => {
          // Predexon v2 entry: { rank, user, metrics:{ total_pnl, volume,
          // win_rate, ... }, ... } — verified live 2026-05-20. P&L/volume/win
          // live under `metrics`, the address is `user`; the old flat
          // r.pnl / r.wallet reads returned undefined for every row.
          const metrics = (r.metrics && typeof r.metrics === 'object' ? r.metrics : {}) as Record<string, unknown>;
          const wallet = pickString(r.user, r.wallet, r.address, r.proxy_wallet, r.proxyWallet) ?? 'unknown';
          const w = wallet.length > 12
            ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}`
            : wallet;
          const pnl = metrics.total_pnl ?? metrics.realized_pnl ?? r.pnl ?? r.realized_pnl ?? r.total_pnl;
          const volume = metrics.volume ?? r.volume ?? r.total_volume;
          const winRate = metrics.win_rate ?? r.win_rate ?? r.winRate;
          const name = pickString(r.name, r.handle, r.username);
          const handle = name ? ` (${name})` : '';
          const parts: string[] = [];
          if (pnl != null) parts.push(`P&L ${formatUsd(pnl as number)}`);
          if (volume != null) parts.push(`vol ${formatUsd(volume as number)}`);
          if (winRate != null) parts.push(`win ${formatPct(winRate as number, 0)}`);
          lines.push(`${i + 1}. \`${w}\`${handle}` + (parts.length > 0 ? ` — ${parts.join(' · ')}` : ''));
        });
        lines.push('', receiptLine(0.001));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'walletProfile': {
        if (!wallets || !wallets.trim()) {
          return {
            output: 'Error: `wallets` is required for walletProfile (single address or comma-separated list of Polymarket wallet addresses)',
            isError: true,
          };
        }
        // Smart dispatch: a single wallet → /wallet/{addr} (full profile,
        // labels, scores, stats); a comma-list → /wallets/profiles (batch).
        // The 3.15.70 ship hit the BATCH endpoint for everything and got 422
        // for the single-wallet case; the gateway team confirmed 2026-05-06
        // the right surface for "analyze this trader" is the path-parameter
        // single-wallet endpoint, not the batch query-param one.
        const parsedWallets = parseWalletsInput(wallets);
        if (parsedWallets.length === 0) {
          return {
            output: 'Error: `wallets` must include at least one Polymarket wallet address',
            isError: true,
          };
        }
        const list = parsedWallets.join(',');
        const isBatch = parsedWallets.length > 1;
        const raw = isBatch
          ? await getWithPayment<unknown>('/v1/pm/polymarket/wallets/profiles', {
              addresses: list,
            }, ctx)
          : await getWithPayment<unknown>(
              `/v1/pm/polymarket/wallet/${encodeURIComponent(list)}`,
              {},
              ctx,
            );
        // Single-wallet path returns a single profile object; batch returns
        // an array (or {data:[]}). unwrapList handles the batch shape but
        // returns [] for a bare object — wrap explicitly so the formatter
        // below sees the single profile.
        const profiles = isBatch
          ? unwrapList<Record<string, unknown>>(raw)
          : (raw && typeof raw === 'object' ? [raw as Record<string, unknown>] : []);
        if (profiles.length === 0) {
          return { output: `No profile data returned for: ${wallets}` };
        }
        const lines: string[] = [
          `## Polymarket wallet profile${profiles.length === 1 ? '' : 's'} — ${profiles.length}`,
          '',
        ];
        // Real Predexon shape (single-wallet, verified 2026-05-06):
        //   { user, metrics: { one_day, seven_day, thirty_day, all_time } }
        // Each metric block has: realized_pnl, total_pnl, volume, roi,
        //   trades, wins, losses, win_rate, profit_factor, positions_closed,
        //   plus all_time-only: avg_buy_price, avg_sell_price,
        //   avg_hold_time_seconds, wallet_age_days, total_positions,
        //   active_positions, max_win_streak, max_loss_streak,
        //   best_position_realized_pnl, worst_position_realized_pnl
        // Batch endpoint (multiple wallets) likely returns an array of these
        // same blocks. We surface all_time as the headline stats and a
        // compact one_day / seven_day / thirty_day delta line so the agent
        // can see momentum.
        profiles.forEach((p, i) => {
          const metrics = (p.metrics && typeof p.metrics === 'object' ? p.metrics : {}) as Record<string, unknown>;
          const allTime = (metrics.all_time && typeof metrics.all_time === 'object' ? metrics.all_time : {}) as Record<string, unknown>;
          const oneDay = (metrics.one_day && typeof metrics.one_day === 'object' ? metrics.one_day : {}) as Record<string, unknown>;
          const sevenDay = (metrics.seven_day && typeof metrics.seven_day === 'object' ? metrics.seven_day : {}) as Record<string, unknown>;
          const thirtyDay = (metrics.thirty_day && typeof metrics.thirty_day === 'object' ? metrics.thirty_day : {}) as Record<string, unknown>;

          const wallet = pickString(p.user, p.wallet, p.address, p.proxy_wallet, p.proxyWallet) ?? 'unknown';
          const w = wallet.length > 12
            ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}`
            : wallet;
          const name = pickString(p.name, p.handle, p.username);
          // Headline stats from all_time (fall back to flat fields if the
          // shape is ever flatter than today's nested format).
          const pnl = allTime.total_pnl ?? allTime.realized_pnl ?? p.pnl ?? p.realized_pnl;
          const realized = allTime.realized_pnl ?? p.realized_pnl;
          const volume = allTime.volume ?? p.volume ?? p.total_volume;
          const trades = allTime.trades ?? p.trades;
          const winRate = allTime.win_rate ?? p.win_rate ?? p.winRate;
          const roi = allTime.roi ?? p.roi;
          const activePositions = allTime.active_positions ?? p.active_positions ?? p.positions_count;
          const ageDays = allTime.wallet_age_days ?? p.wallet_age_days;

          lines.push(`${i + 1}. \`${w}\`` + (name ? ` (${name})` : ''));
          const stats: string[] = [];
          if (pnl != null) stats.push(`total P&L ${formatUsd(pnl as number)}`);
          if (realized != null && realized !== pnl) stats.push(`realized ${formatUsd(realized as number)}`);
          if (volume != null) stats.push(`vol ${formatUsd(volume as number)}`);
          if (roi != null) stats.push(`ROI ${formatPct(roi as number, 1)}`);
          if (winRate != null) stats.push(`win ${formatPct(winRate as number, 0)}`);
          if (trades != null) stats.push(`${trades} trades`);
          if (activePositions != null) stats.push(`${activePositions} open`);
          if (ageDays != null) stats.push(`${ageDays}d age`);
          if (stats.length > 0) lines.push(`   ${stats.join(' · ')}`);

          // Recent-window deltas help the agent judge momentum without a
          // separate walletPnl call.
          const recent: string[] = [];
          for (const [label, block] of [['1d', oneDay], ['7d', sevenDay], ['30d', thirtyDay]] as Array<[string, Record<string, unknown>]>) {
            const tp = block.total_pnl;
            const tr = block.trades;
            if (tp != null || tr != null) {
              const parts: string[] = [];
              if (tp != null) parts.push(formatUsd(tp as number));
              if (tr != null) parts.push(`${tr} trades`);
              recent.push(`${label}: ${parts.join(' / ')}`);
            }
          }
          if (recent.length > 0) lines.push(`   ${recent.join(' · ')}`);
        });
        lines.push('', receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'walletPnl': {
        // Single-wallet P&L summary + time series.
        // Predexon path: /v1/pm/polymarket/wallet/pnl/{wallet} — Tier 2 ($0.005).
        if (!wallets || !wallets.trim()) {
          return {
            output: 'Error: `wallets` is required for walletPnl (single Polymarket wallet address)',
            isError: true,
          };
        }
        const parsedWallets = parseWalletsInput(wallets);
        if (parsedWallets.length !== 1) {
          return {
            output: 'Error: walletPnl accepts exactly one wallet address. For multiple wallets, call walletPnl once per address in parallel.',
            isError: true,
          };
        }
        const wallet = parsedWallets[0];
        // Predexon requires `granularity` from the enum {day, week, month,
        // year, all} — verified 2026-05-06 in two live 422 turns. Default
        // `day`; agent can override via input field for longer aggregations.
        const raw = await getWithPayment<unknown>(
          `/v1/pm/polymarket/wallet/pnl/${encodeURIComponent(wallet)}`,
          { granularity: granularity ?? 'day' },
          ctx,
        );
        if (!raw || typeof raw !== 'object') {
          return { output: `No P&L data returned for ${wallet}` };
        }
        // Real Predexon shape (verified 2026-05-06):
        //   { granularity, start_time, end_time, wallet_address,
        //     realized_pnl, unrealized_pnl, total_pnl,
        //     fees_paid, fees_refunded,
        //     pnl_over_time: [{timestamp, pnl_to_date}, ...] }
        // start_time/end_time and timestamp are unix seconds.
        const data = raw as Record<string, unknown>;
        const realized = data.realized_pnl ?? data.realizedPnl;
        const unrealized = data.unrealized_pnl ?? data.unrealizedPnl;
        const total = data.total_pnl ?? data.totalPnl;
        const fees = data.fees_paid ?? data.feesPaid;
        const w = wallet.length > 12 ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}` : wallet;
        const gran = (data.granularity as string | undefined) ?? granularity ?? 'day';
        const lines: string[] = [`## Polymarket wallet P&L — \`${w}\` · granularity ${gran}`, ''];
        const summary: string[] = [];
        if (total != null) summary.push(`total ${formatUsd(total as number)}`);
        if (realized != null) summary.push(`realized ${formatUsd(realized as number)}`);
        if (unrealized != null) summary.push(`unrealized ${formatUsd(unrealized as number)}`);
        if (fees != null && Number(fees) > 0) summary.push(`fees ${formatUsd(fees as number)}`);
        if (summary.length > 0) lines.push(summary.join(' · '));
        // Time series: pnl_over_time uses unix seconds. Show last 7 non-zero
        // checkpoints so the agent sees momentum without paginating through
        // hundreds of zero-pnl warmup days.
        const series = (data.pnl_over_time ?? data.pnlOverTime ?? data.series) as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(series) && series.length > 0) {
          const meaningful = series.filter(pt => {
            const v = (pt.pnl_to_date ?? pt.pnlToDate ?? pt.pnl ?? pt.value) as number | undefined;
            return typeof v === 'number' && v !== 0;
          });
          const sample = (meaningful.length > 0 ? meaningful : series).slice(-7);
          if (sample.length > 0) {
            lines.push('', `**Recent points** (latest ${sample.length} of ${series.length}):`);
            sample.forEach(pt => {
              const t = (pt.timestamp ?? pt.ts ?? pt.date) as number | string | undefined;
              const v = (pt.pnl_to_date ?? pt.pnlToDate ?? pt.pnl ?? pt.value) as number | undefined;
              if (t != null && v != null) {
                // Predexon timestamps are unix SECONDS, not millis.
                const ms = typeof t === 'number' ? t * 1000 : Date.parse(String(t));
                const tStr = Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : String(t).slice(0, 10);
                lines.push(`- ${tStr} · ${formatUsd(v)}`);
              }
            });
          }
        }
        lines.push('', receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'walletPositions': {
        // Single-wallet positions (open + historical).
        // Predexon path: /v1/pm/polymarket/wallet/positions/{wallet} — Tier 2 ($0.005).
        if (!wallets || !wallets.trim()) {
          return {
            output: 'Error: `wallets` is required for walletPositions (single Polymarket wallet address)',
            isError: true,
          };
        }
        const parsedWallets = parseWalletsInput(wallets);
        if (parsedWallets.length !== 1) {
          return {
            output: 'Error: walletPositions accepts exactly one wallet address. For multiple wallets, call walletPositions once per address in parallel.',
            isError: true,
          };
        }
        const wallet = parsedWallets[0];
        const raw = await getWithPayment<unknown>(
          `/v1/pm/polymarket/wallet/positions/${encodeURIComponent(wallet)}`,
          { limit: cappedLimit },
          ctx,
        );
        const positions = unwrapList<Record<string, unknown>>(raw);
        if (positions.length === 0) {
          return { output: `No positions returned for ${wallet}` };
        }
        const w = wallet.length > 12 ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}` : wallet;
        const lines: string[] = [
          `## Polymarket positions — \`${w}\` — ${positions.length} position${positions.length === 1 ? '' : 's'}`,
          '',
        ];
        // Predexon returns each position as a nested record:
        //   { market: {title, side_label, ...},
        //     position: {shares, avg_entry_price, total_cost_usd, ...},
        //     current: {price, value_usd},
        //     pnl: {unrealized_usd, unrealized_pct, realized_usd} }
        // Verified 2026-05-06 via FRANKLIN_PM_DEBUG=1 dump. Walk the four
        // sub-objects rather than assuming flat fields. Keep flat-field
        // fallbacks too in case the response shape changes or the user's
        // gateway version returns a flatter format.
        positions.slice(0, cappedLimit).forEach((p, i) => {
          const market = (p.market && typeof p.market === 'object' ? p.market : {}) as Record<string, unknown>;
          const position = (p.position && typeof p.position === 'object' ? p.position : {}) as Record<string, unknown>;
          const current = (p.current && typeof p.current === 'object' ? p.current : {}) as Record<string, unknown>;
          const pnlObj = (p.pnl && typeof p.pnl === 'object' ? p.pnl : {}) as Record<string, unknown>;

          const title = pickString(market.title, market.question, p.title, p.question, market.market_slug, p.market_slug) ?? 'untitled';
          const outcome = pickString(market.side_label, market.side, p.outcome, p.side);
          const shares = position.shares ?? position.total_shares_bought ?? p.size ?? p.shares;
          const avgPrice = position.avg_entry_price ?? p.avg_price ?? p.avgPrice;
          const currentValue = current.value_usd ?? p.current_value ?? p.currentValue ?? p.value;
          const pnl = pnlObj.unrealized_usd ?? pnlObj.realized_usd ?? p.cashPnl ?? p.pnl;
          const pnlPct = pnlObj.unrealized_pct ?? pnlObj.realized_pct ?? p.percentPnl ?? p.percent_pnl;

          const parts: string[] = [];
          if (outcome) parts.push(outcome);
          if (shares != null) parts.push(`${formatQuantity(shares as number)} shares`);
          if (avgPrice != null) parts.push(`avg ${formatPct(avgPrice as number)}`);
          if (currentValue != null) parts.push(`now ${formatUsd(currentValue as number)}`);
          if (pnl != null) {
            const pctStr = pnlPct != null ? ` (${formatPct(pnlPct as number, 1)})` : '';
            parts.push(`P&L ${formatUsd(pnl as number)}${pctStr}`);
          }
          lines.push(`${i + 1}. **${title}** — ${parts.join(' · ')}`);
        });
        lines.push('', receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'smartActivity': {
        // "Discover markets where high-performing wallets are active right now."
        // Complements `smartMoney`: this discovers interesting markets across
        // the venue; smartMoney drills into one condition_id.
        // Requires a smart-wallet criterion (else 400). `search` is not a
        // supported param here, so it was silently dropped — removed.
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/markets/smart-activity', {
          limit: cappedLimit,
          min_total_pnl: DEFAULT_SMART_MIN_TOTAL_PNL,
        }, ctx);
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (rows.length === 0) {
          return { output: 'No smart-money activity recorded right now.' };
        }
        const lines: string[] = [
          `## Smart-money activity — ${rows.length} market${rows.length === 1 ? '' : 's'}`,
          '_Markets where high-P&L Polymarket wallets are positioning right now._',
          '',
        ];
        rows.forEach((r, i) => {
          const title = pickString(r.question, r.title, r.market, r.event, r.market_slug, r.slug) ?? 'untitled';
          const cid = pickString(r.condition_id, r.id);
          // Full condition_id so the agent can chain into smartMoney.
          const cidTag = cid ? ` · \`${String(cid)}\`` : '';
          // Predexon v2 fields (verified live): smart_wallet_count (singular),
          // smart_volume, net_buyers_pct.
          const smartCount = r.smart_wallet_count ?? r.smart_wallets_count ?? r.wallet_count;
          const smartVol = r.smart_volume ?? r.net_size ?? r.net_yes_size;
          const netBuyersPct = r.net_buyers_pct;
          const stats: string[] = [];
          if (smartCount != null) stats.push(`${smartCount} smart wallet${smartCount === 1 ? '' : 's'}`);
          if (smartVol != null) stats.push(`smart vol ${formatUsd(smartVol as number)}`);
          if (netBuyersPct != null) stats.push(`${formatPct(netBuyersPct as number, 0)} net buyers`);
          lines.push(`${i + 1}. **${title}**${cidTag}` + (stats.length > 0 ? `\n   ${stats.join(' · ')}` : ''));
        });
        lines.push('', receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'smartMoney': {
        if (!conditionId) {
          return {
            output: 'Error: conditionId is required for smartMoney (Polymarket condition_id from a prior searchPolymarket or smartActivity call)',
            isError: true,
          };
        }
        // Per-market drill-down. Requires a smart-wallet criterion (else 400).
        // Predexon v2 returns a single `positioning` aggregate (net buyer/
        // seller counts + smart buy/sell volume + avg prices), NOT buyers/
        // sellers arrays — verified live 2026-05-20.
        const path = `/v1/pm/polymarket/market/${encodeURIComponent(conditionId)}/smart-money`;
        const data = await getWithPayment<SmartMoneyResp>(path, {
          min_total_pnl: DEFAULT_SMART_MIN_TOTAL_PNL,
        }, ctx);
        const pos = data.positioning;
        if (!pos || typeof pos !== 'object') {
          return { output: `No smart-money positioning recorded for \`${conditionId.slice(0, 14)}…\` yet.` };
        }
        const lines: string[] = [
          `## Smart money — ${pos.title ?? `\`${conditionId.slice(0, 14)}…\``}`,
        ];
        const head: string[] = [];
        if (pos.smart_wallet_count != null) head.push(`${pos.smart_wallet_count} smart wallets`);
        if (pos.net_buyers != null && pos.net_sellers != null) head.push(`${pos.net_buyers} buyers / ${pos.net_sellers} sellers`);
        if (pos.net_buyers_pct != null) head.push(`${formatPct(pos.net_buyers_pct, 0)} net buyers`);
        if (head.length > 0) lines.push(head.join(' · '));
        const flow: string[] = [];
        if (pos.total_smart_buy_volume != null) flow.push(`buy ${formatUsd(pos.total_smart_buy_volume)}`);
        if (pos.total_smart_sell_volume != null) flow.push(`sell ${formatUsd(pos.total_smart_sell_volume)}`);
        if (pos.avg_smart_buy_price != null) flow.push(`avg buy ${formatPct(pos.avg_smart_buy_price)}`);
        if (pos.avg_smart_sell_price != null) flow.push(`avg sell ${formatPct(pos.avg_smart_sell_price)}`);
        if (flow.length > 0) lines.push('', `**Smart flow:** ${flow.join(' · ')}`);
        if (pos.total_smart_realized_pnl != null || pos.avg_smart_roi != null) {
          const perf: string[] = [];
          if (pos.total_smart_realized_pnl != null) perf.push(`realized P&L ${formatUsd(pos.total_smart_realized_pnl)}`);
          if (pos.avg_smart_roi != null) perf.push(`avg ROI ${formatPct(pos.avg_smart_roi, 1)}`);
          if (pos.avg_smart_win_rate != null) perf.push(`win ${formatPct(pos.avg_smart_win_rate, 0)}`);
          lines.push(`**Smart performance:** ${perf.join(' · ')}`);
        }
        lines.push('', receiptLine(0.005));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'searchPolymarket': {
        const raw = await getWithPayment<unknown>('/v1/pm/polymarket/markets', {
          search,
          status: normalizeMarketStatus(status) ?? 'open',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<PolyMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Polymarket markets matched the filters.' };
        }
        const lines: string[] = [
          `## Polymarket — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            (status ? ` · status=${status}` : '') +
            ` · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          // Prices: Predexon v2 nests each outcome as {label, price} inside
          // `outcomes`. Fall back to the legacy parallel `outcomes[]` (strings)
          // + `outcome_prices[]` shape if a gateway version still returns it.
          let yesPx = 'n/a';
          if (Array.isArray(m.outcomes) && m.outcomes.length > 0 && typeof m.outcomes[0] === 'object') {
            const outs = m.outcomes as PolymarketOutcome[];
            const parts = outs
              .filter(o => o && o.price != null)
              .map(o => `${o.label ?? '?'}=${formatPct(o.price)}`);
            if (parts.length > 0) yesPx = parts.join(' / ');
          } else if (Array.isArray(m.outcomes) && Array.isArray(m.outcome_prices) && m.outcomes.length === m.outcome_prices.length) {
            yesPx = (m.outcomes as string[]).map((o, j) => `${o}=${formatPct(m.outcome_prices![j])}`).join(' / ');
          }
          const vol = m.total_volume_usd ?? m.volume;
          const liq = m.liquidity_usd ?? m.liquidity;
          const end = m.end_time ?? m.close_time ?? m.end_date;
          // Full condition_id (NOT truncated) — the agent chains it into
          // smartMoney; a truncated id 404s. Verified live 2026-05-20.
          const cid = m.condition_id ? ` · condition_id=\`${m.condition_id}\`` : '';
          lines.push(
            `${i + 1}. **${m.title || m.question || m.market_slug || 'untitled'}**${cid}\n` +
            `   prices: ${yesPx} · vol: ${formatUsd(vol)} · liq: ${formatUsd(liq)}` +
            (end ? ` · ends ${String(end).slice(0, 10)}` : '')
          );
        });
        lines.push('', receiptLine(0.001));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'searchKalshi': {
        const raw = await getWithPayment<unknown>('/v1/pm/kalshi/markets', {
          search,
          status: normalizeMarketStatus(status) ?? 'open',
          sort: sort ?? 'volume',
          limit: cappedLimit,
        }, ctx);
        const markets = unwrapList<KalshiMarket>(raw);
        if (markets.length === 0) {
          return { output: 'No Kalshi markets matched the filters.' };
        }
        const lines: string[] = [
          `## Kalshi — ${markets.length} market${markets.length === 1 ? '' : 's'}` +
            (search ? ` · search="${search}"` : '') +
            ` · status=${status ?? 'open'} · sort=${sort ?? 'volume'}`,
          '',
        ];
        markets.forEach((m, i) => {
          // Predexon v2 gives a single `last_price` (0–1 probability), not the
          // yes_bid/yes_ask cents this once assumed. Render it as an implied
          // YES %; fall back to legacy bid/ask if a gateway version sends them.
          let yes = 'n/a';
          if (m.last_price != null) {
            yes = formatPct(m.last_price);
          } else if (m.yes_bid != null || m.yes_ask != null) {
            yes = `${m.yes_bid ?? '?'}¢/${m.yes_ask ?? '?'}¢`;
          }
          const ticker = m.ticker ? ` · ticker=\`${m.ticker}\`` : '';
          lines.push(
            `${i + 1}. **${m.title || m.ticker || 'untitled'}**${ticker}\n` +
            `   yes ${yes} · vol: ${m.volume?.toLocaleString() ?? 'n/a'} · OI: ${m.open_interest?.toLocaleString() ?? 'n/a'}` +
            (m.close_time ? ` · closes ${String(m.close_time).slice(0, 10)}` : '')
          );
        });
        lines.push('', receiptLine(0.001));
        return { output: frameUntrusted('Prediction-market data (untrusted)', lines.join('\n')) };
      }

      case 'crossPlatform': {
        // Tombstone (no charge): Predexon sunset market matching 2026-07-20
        // and the gateway de-registered /v1/pm/matching-markets{,/pairs} on
        // 2026-08-03 — the upstream 410s. Old sessions / prompts may still
        // ask for this action, so steer them instead of burning a paid call
        // on a dead endpoint.
        return {
          output:
            'crossPlatform was retired: Predexon discontinued cross-venue market ' +
            'matching on 2026-07-20 and the gateway removed the endpoint. To compare ' +
            'venues, use `searchAll` — its canonical market containers already span ' +
            'Polymarket+Kalshi+Limitless+Opinion+Predict.Fun — or run `searchPolymarket` ' +
            'and `searchKalshi` in parallel and compare implied probabilities.',
          isError: true,
        };
      }

      default:
        return {
          output: `Error: unknown action "${action}". Use: searchAll, searchPolymarket, searchKalshi, leaderboard, walletProfile, walletPnl, walletPositions, smartActivity, smartMoney`,
          isError: true,
        };
    }
  } catch (err) {
    return { output: `Error: ${(err as Error).message}`, isError: true };
  }
}

export const predictionMarketCapability: CapabilityHandler = {
  spec: {
    name: 'PredictionMarket',
    description:
      'Real prediction market data via the BlockRun gateway (powered by Predexon). Use for any "what are the odds of X" / "Polymarket on Y" / "is there a market on Z" / "follow this trader" question. ' +
      'Actions: ' +
      '`searchAll` (search markets across Polymarket+Kalshi+Limitless+Opinion+Predict.Fun in one call — $0.005), ' +
      '`searchPolymarket` (Polymarket only, supports sort+status — $0.001), ' +
      '`searchKalshi` (Kalshi only, supports sort+status — $0.001), ' +
      '`leaderboard` (global top wallets by P&L on Polymarket — $0.001), ' +
      '`walletProfile` (full Polymarket wallet profile — labels, scores, stats. Single address → /wallet/{addr}; comma-list → batch /wallets/profiles — $0.005), ' +
      '`walletPnl` (single Polymarket wallet P&L summary + time series — $0.005), ' +
      '`walletPositions` (single Polymarket wallet positions — open + historical with P&L per position — $0.005), ' +
      '`smartActivity` (markets where high-P&L wallets are positioning right now — $0.005), ' +
      '`smartMoney` (smart-money positioning on one Polymarket condition_id — $0.005). ' +
      'Default routing: ' +
      '"is there a market on X anywhere" → searchAll. ' +
      '"top wallets / who is profitable / who should I follow on Polymarket" → leaderboard. ' +
      '"analyze this wallet / can I copy this trader / show me their P&L AND positions" → run walletProfile + walletPnl + walletPositions IN PARALLEL with the same address — three $0.005 calls give the full picture for $0.015. Do not Bash-curl Polymarket directly; the agent has paid tools for this. ' +
      '"what are smart traders betting on right now" → smartActivity. ' +
      '"show smart money on this specific Polymarket market" → smartMoney with conditionId. ' +
      '"should I bet on X" → run searchPolymarket + searchKalshi in parallel and compare implied probabilities — divergence is the signal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'searchAll',
            'searchPolymarket',
            'searchKalshi',
            'leaderboard',
            'walletProfile',
            'walletPnl',
            'walletPositions',
            'smartActivity',
            'smartMoney',
          ],
          description: 'Which prediction-market query to run. See tool description for cost per action.',
        },
        search: {
          type: 'string',
          description: 'Search query. Used by searchAll / searchPolymarket / searchKalshi / smartActivity. Optional for leaderboard/walletProfile/walletPnl/walletPositions/smartMoney.',
        },
        status: {
          type: 'string',
          description: 'Market status filter — Predexon accepts `open` or `closed` for Polymarket, Kalshi, and searchAll alike (default `open`). Synonyms like `active`/`archived` are normalized automatically.',
        },
        sort: {
          type: 'string',
          description: 'Polymarket: volume | liquidity | created (default volume). Kalshi: volume | open_interest | price_desc | price_asc | close_time (default volume). leaderboard: pnl | volume | win_rate (gateway-defined).',
        },
        limit: {
          type: 'number',
          description: `Max results (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
        },
        wallets: {
          type: 'string',
          description: 'For walletProfile: a single Polymarket wallet address, or a comma-separated list of addresses for batch lookup.',
        },
        conditionId: {
          type: 'string',
          description: 'For smartMoney: Polymarket condition_id from searchPolymarket or smartActivity.',
        },
        granularity: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'all'],
          description: 'For walletPnl: time bucket for the P&L series. Default day.',
        },
      },
      required: ['action'],
    },
  },
  execute,
  concurrent: true,
};
