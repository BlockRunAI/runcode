/**
 * Surf — function-call tools for BlockRun's crypto data API.
 *
 * Three category tools (SurfMarket / SurfChain / SurfSocial) that mirror the
 * /surf-market, /surf-chain, /surf-social skills. Unlike the generic BlockRun
 * primitive (free-form `path` string), these expose the valid endpoints as an
 * `endpoint` enum so the model picks instead of guessing, and they sign the
 * x402 payment internally — the model never touches paths or payment, same UX
 * as VideoGen / ImageGen.
 *
 * The endpoint tables below are derived from the gateway's SURF_ENDPOINTS
 * registry (blockrun/src/lib/surf.ts). They are hand-maintained for now; a
 * follow-up will generate them so the gateway stays the single source of truth.
 *
 * x402 signing mirrors src/tools/blockrun.ts (kept as copy-paste per the same
 * rationale documented there — refactoring into a shared module is out of scope).
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
import { loadChain, USER_AGENT} from '../config.js';
import { basePriceForPath, chargeFromResponse, requestIdFromResponse, resolveCharge } from '../payments/price-catalog.js';
import { GATEWAY_TRANSACTION_FEE_USD } from '../gateway-models.js';
import { gatewayBase, gatewayHeaders } from '../payments/auth-mode.js';
import { frameUntrusted } from './untrusted.js';
import { recordUsage } from '../stats/tracker.js';
import { logger } from '../logger.js';

const TIMEOUT_MS = 30_000;

interface SurfEndpoint {
  /** Path under /v1/surf/, e.g. "market/ranking". */
  path: string;
  method: 'GET' | 'POST';
  /** Query params (GET) the endpoint needs — surfaced in the tool description. */
  required: string[];
  desc: string;
}

// ── Endpoint tables (derived from gateway SURF_ENDPOINTS) ───────────────────

const MARKET_ENDPOINTS: SurfEndpoint[] = [
  { path: 'market/ranking', method: 'GET', required: [], desc: 'Token rankings (market cap, volume, 24h change).' },
  { path: 'market/fear-greed', method: 'GET', required: [], desc: 'Fear & Greed index history.' },
  { path: 'market/futures', method: 'GET', required: [], desc: 'Futures market overview.' },
  { path: 'market/price', method: 'GET', required: ['symbol'], desc: 'Token price history.' },
  { path: 'market/etf', method: 'GET', required: ['symbol'], desc: 'Spot ETF flow history (BTC/ETH).' },
  { path: 'market/options', method: 'GET', required: ['symbol'], desc: 'Options skew / IV / volume.' },
  { path: 'market/liquidation/exchange-list', method: 'GET', required: [], desc: 'Liquidations by exchange.' },
  { path: 'market/liquidation/order', method: 'GET', required: [], desc: 'Large (whale) liquidation orders.' },
  { path: 'market/liquidation/chart', method: 'GET', required: ['symbol'], desc: 'Liquidation chart over time.' },
  { path: 'market/onchain-indicator', method: 'GET', required: ['symbol', 'metric'], desc: 'On-chain indicators (NUPL/SOPR/MVRV/Puell/NVT).' },
  { path: 'market/price-indicator', method: 'GET', required: ['indicator', 'symbol'], desc: 'Technical indicators (RSI/MACD/BBANDS/EMA).' },
  { path: 'exchange/markets', method: 'GET', required: [], desc: 'CEX trading pairs catalog.' },
  { path: 'exchange/price', method: 'GET', required: ['pair'], desc: 'CEX ticker price for a pair.' },
  { path: 'exchange/perp', method: 'GET', required: ['pair'], desc: 'Perpetual contract snapshot.' },
  { path: 'exchange/depth', method: 'GET', required: ['pair'], desc: 'Order book depth.' },
  { path: 'exchange/klines', method: 'GET', required: ['pair'], desc: 'OHLCV candles.' },
  { path: 'exchange/funding-history', method: 'GET', required: ['pair'], desc: 'Funding rate history.' },
  { path: 'exchange/long-short-ratio', method: 'GET', required: ['pair'], desc: 'Long/short account ratio.' },
  { path: 'fund/detail', method: 'GET', required: [], desc: 'VC fund profile detail.' },
  { path: 'fund/portfolio', method: 'GET', required: [], desc: 'VC fund portfolio holdings.' },
  { path: 'fund/ranking', method: 'GET', required: ['metric'], desc: 'Top VC funds ranking.' },
  { path: 'news/feed', method: 'GET', required: [], desc: 'AI-curated crypto news feed.' },
  { path: 'news/detail', method: 'GET', required: ['id'], desc: 'Full article detail by id.' },
  { path: 'project/detail', method: 'GET', required: [], desc: 'Project profile.' },
  { path: 'project/defi/metrics', method: 'GET', required: ['metric'], desc: 'DeFi protocol metrics.' },
  { path: 'project/defi/ranking', method: 'GET', required: ['metric'], desc: 'DeFi protocol ranking.' },
];

const CHAIN_ENDPOINTS: SurfEndpoint[] = [
  { path: 'onchain/bridge/ranking', method: 'GET', required: [], desc: 'Bridge protocol ranking by volume.' },
  { path: 'onchain/yield/ranking', method: 'GET', required: [], desc: 'Yield pool ranking (lending/LP/staking).' },
  { path: 'onchain/gas-price', method: 'GET', required: ['chain'], desc: 'Current gas price for a chain.' },
  { path: 'onchain/tx', method: 'GET', required: ['hash', 'chain'], desc: 'Transaction details by hash.' },
  { path: 'onchain/schema', method: 'GET', required: [], desc: 'Schema introspection for the SQL tables.' },
  { path: 'onchain/query', method: 'POST', required: [], desc: 'Structured chain query (POST body).' },
  { path: 'onchain/sql', method: 'POST', required: [], desc: 'Raw SQL against 80+ indexed chain tables (POST body).' },
  { path: 'token/tokenomics', method: 'GET', required: [], desc: 'Token supply / unlock / distribution.' },
  { path: 'token/dex-trades', method: 'GET', required: ['address'], desc: 'Recent DEX trades for a token.' },
  { path: 'token/holders', method: 'GET', required: ['address', 'chain'], desc: 'Top holders / concentration.' },
  { path: 'token/transfers', method: 'GET', required: ['address', 'chain'], desc: 'Token transfer history.' },
  { path: 'wallet/detail', method: 'GET', required: ['address'], desc: 'Wallet overview.' },
  { path: 'wallet/history', method: 'GET', required: ['address'], desc: 'Wallet activity history.' },
  { path: 'wallet/net-worth', method: 'GET', required: ['address'], desc: 'Wallet net worth.' },
  { path: 'wallet/transfers', method: 'GET', required: ['address'], desc: 'Wallet transfers.' },
  { path: 'wallet/protocols', method: 'GET', required: ['address'], desc: 'Protocols the wallet interacts with.' },
  { path: 'wallet/labels/batch', method: 'GET', required: ['addresses'], desc: 'Batch wallet labels (CEX/Whale/Bridge/MEV).' },
];

const SOCIAL_ENDPOINTS: SurfEndpoint[] = [
  { path: 'social/detail', method: 'GET', required: [], desc: 'Social signal detail.' },
  { path: 'social/ranking', method: 'GET', required: [], desc: 'KOL / account influence ranking.' },
  { path: 'social/smart-followers/history', method: 'GET', required: [], desc: 'Smart-follower growth history.' },
  { path: 'social/mindshare', method: 'GET', required: ['q', 'interval'], desc: 'Topic/token mindshare over an interval.' },
  { path: 'social/tweets', method: 'GET', required: ['ids'], desc: 'Tweets by ids.' },
  { path: 'social/tweet/replies', method: 'GET', required: ['tweet_id'], desc: 'Replies to a tweet.' },
  { path: 'social/user', method: 'GET', required: ['handle'], desc: 'User profile.' },
  { path: 'social/user/followers', method: 'GET', required: ['handle'], desc: 'User followers.' },
  { path: 'social/user/following', method: 'GET', required: ['handle'], desc: 'User followings.' },
  { path: 'social/user/posts', method: 'GET', required: ['handle'], desc: 'User posts.' },
  { path: 'social/user/replies', method: 'GET', required: ['handle'], desc: 'User replies.' },
];

// ── x402 signing (mirrors blockrun.ts) ──────────────────────────────────────

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* not JSON */ }
  }
  return header;
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
  resourceDescription: string,
): Promise<{ headers: Record<string, string>; amountUsd: number } | null> {
  try {
    const paymentHeader = await extractPaymentReq(response);
    if (!paymentHeader) return null;
    const paymentRequired = parsePaymentRequired(paymentHeader);
    if (chain === 'solana') {
      const wallet = await getOrCreateSolanaWallet();
      const details = extractPaymentDetails(paymentRequired, SOLANA_NETWORK);
      const secretBytes = await solanaKeyToBytes(wallet.privateKey);
      const feePayer = details.extra?.feePayer || details.recipient;
      const payload = await createSolanaPaymentPayload(
        secretBytes, wallet.address, details.recipient, details.amount, feePayer as string,
        {
          resourceUrl: details.resource?.url || endpoint,
          resourceDescription: details.resource?.description || resourceDescription,
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { headers: { 'PAYMENT-SIGNATURE': payload }, amountUsd: Number(details.amount) / 1_000_000 };
    }
    const wallet = getOrCreateWallet();
    const details = extractPaymentDetails(paymentRequired);
    const payload = await createPaymentPayload(
      wallet.privateKey as `0x${string}`, wallet.address, details.recipient, details.amount,
      details.network || 'eip155:8453',
      {
        resourceUrl: details.resource?.url || endpoint,
        resourceDescription: details.resource?.description || resourceDescription,
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { headers: { 'PAYMENT-SIGNATURE': payload }, amountUsd: Number(details.amount) / 1_000_000 };
  } catch (err) {
    logger.warn(`[franklin] Surf payment error: ${(err as Error).message}`);
    return null;
  }
}

// ── Shared call: resolve endpoint → sign x402 → return data ──────────────────

async function callSurf(
  toolName: string,
  table: SurfEndpoint[],
  input: Record<string, unknown>,
  ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim().replace(/^\/+|\/+$/g, '') : '';
  let entry = table.find((e) => e.path === endpoint);
  if (!entry) {
    // Tolerate a weak model dropping the category prefix ("fear-greed" instead
    // of "market/fear-greed") — accept a suffix match when it's unambiguous.
    const matches = table.filter((e) => e.path === endpoint || e.path.endsWith(`/${endpoint}`));
    if (matches.length === 1) {
      entry = matches[0];
    } else if (matches.length > 1) {
      return { output: `Ambiguous ${toolName} endpoint "${endpoint}". Did you mean: ${matches.map((m) => m.path).join(', ')}?`, isError: true };
    } else {
      return { output: `Unknown ${toolName} endpoint: "${endpoint}". Valid: ${table.map((e) => e.path).join(', ')}`, isError: true };
    }
  }

  // Collect query params: the named fields the caller provided (everything
  // except `endpoint`/`body`), plus an explicit `params` object if given.
  const query: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'endpoint' || k === 'body' || k === 'params') continue;
    if (v !== undefined && v !== null && v !== '') query[k] = v;
  }
  if (input.params && typeof input.params === 'object') Object.assign(query, input.params);

  const missing = entry.required.filter((p) => query[p] === undefined);
  if (missing.length > 0) {
    return {
      output: `${toolName} ${endpoint} needs: ${entry.required.join(', ')}. Missing: ${missing.join(', ')}.`,
      isError: true,
    };
  }

  const chain = loadChain();
  const base = gatewayBase(); // wallet host ends in /api; the key host does not
  let url = `${base}/v1/surf/${entry.path}`;
  const body = entry.method === 'POST'
    ? (input.body && typeof input.body === 'object' ? input.body as Record<string, unknown> : query)
    : undefined;
  if (entry.method === 'GET' && Object.keys(query).length > 0) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const x of v) usp.append(k, String(x));
      else usp.append(k, String(v));
    }
    url += `?${usp.toString()}`;
  }

  const start = Date.now();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { ...gatewayHeaders(), Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (entry.method === 'POST') headers['Content-Type'] = 'application/json';
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const resourceDescription = `Surf ${entry.method} /v1/surf/${entry.path}`;

  try {
    let response = await fetch(url, { method: entry.method, signal: ctrl.signal, headers, body: payload });
    let paidUsd = 0;
    if (response.status === 402) {
      const signed = await signPayment(response, chain, url, resourceDescription);
      if (!signed) return { output: `${toolName} ${endpoint}: payment signing failed`, isError: true };
      paidUsd = signed.amountUsd;
      response = await fetch(url, {
        method: entry.method, signal: ctrl.signal,
        headers: { ...headers, ...signed.headers }, body: payload,
      });
    }
    if (!response.ok) paidUsd = 0;
    const raw = await response.text().catch(() => '');
    // `paidUsd` is 0 unless a 402 was settled — i.e. always 0 in API-key mode.
    // Fall back to the catalog price so Surf spend still counts against
    // --max-spend and shows in stats.
    const charge = response.ok
      ? resolveCharge({ apiPath: url, chargedUsd: chargeFromResponse(response), settledUsd: paidUsd })
      : { usd: 0, estimated: false };
    try { recordUsage(`${toolName}:${entry.path}`, 0, 0, charge.usd, Date.now() - start, false, charge.estimated, requestIdFromResponse(response)); } catch { /* best-effort */ }

    if (!response.ok) {
      return {
        output: `${toolName} ${endpoint} failed (status ${response.status}). No charge if 4xx pre-payment.\n${raw.slice(0, 800)}`,
        isError: true,
      };
    }
    const head = `Surf /v1/surf/${entry.path} → $${paidUsd.toFixed(4)} · ${Date.now() - start}ms`;
    return { output: frameUntrusted('Surf web/API result', `${head}\n\n\`\`\`json\n${raw}\n\`\`\``) };
  } catch (err) {
    return { output: `${toolName} ${endpoint} error: ${(err as Error).message}`, isError: true };
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

// ── Tool specs ───────────────────────────────────────────────────────────────

/**
 * Price sentence for the tool description, read from the catalog rather than
 * typed in.
 *
 * This used to read "Tier-1 $0.001, Tier-2 $0.005, Tier-3 $0.02", which the
 * payment layer had long since replaced with one flat rate. Measured against
 * the authoritative 402 on 2026-09-05: every Surf endpoint quotes $0.0085, so
 * the description understated tier-1 by 8.5x and overstated tier-3 by 2.4x.
 *
 * That matters more than an inaccurate comment, because the agent reads this
 * string to decide whether a call is worth making — it was being told the
 * cheapest Surf call costs about a tenth of what it does. A hand-typed price
 * is a published number with no owner; sourcing it from the catalog gives it
 * one, and the guard test keeps literals from creeping back in.
 *
 * It states the BASE price and names the fee separately because there are two
 * real prices per endpoint: the key rail charges the base, the wallet rail adds
 * a settlement fee. One number cannot be right for both, and this phrasing is
 * true on either.
 */
function surfPriceBlurb(): string {
  const base = basePriceForPath('/v1/surf/market/ranking');
  return base === null || base <= 0
    ? 'Each call is charged per request; the 402 quote states the exact price.'
    : `Flat $${base.toFixed(4)} per call, plus a $${GATEWAY_TRANSACTION_FEE_USD.toFixed(3)} `
      + 'settlement fee when paying from a wallet.';
}

function makeSurfTool(
  name: string,
  blurb: string,
  table: SurfEndpoint[],
  extraParams: Record<string, { type: string; description: string }>,
): CapabilityHandler {
  const endpointList = table.map((e) => `\`${e.path}\`${e.required.length ? ` (needs ${e.required.join('+')})` : ''} — ${e.desc}`).join('\n');
  return {
    spec: {
      name,
      description:
        `${blurb} Picks an endpoint from a fixed list and signs the x402 USDC payment from the wallet automatically — ` +
        `you do not build paths or handle payment. ${surfPriceBlurb()}\n\nEndpoints:\n${endpointList}`,
      input_schema: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            enum: table.map((e) => e.path),
            description: 'Which Surf endpoint to call (see list in the tool description).',
          },
          ...extraParams,
          body: { type: 'object', description: 'Request body for POST endpoints (onchain/query, onchain/sql).' },
        },
        required: ['endpoint'],
      },
    },
    concurrent: true,
    execute: (input: Record<string, unknown>, ctx: ExecutionScope) => callSurf(name, table, input, ctx),
  };
}

export const surfMarketCapability = makeSurfTool(
  'SurfMarket',
  'Crypto market data: token rankings, fear/greed, futures, ETF flows, options, liquidations, technical & on-chain indicators, CEX pairs, VC funds, news, DeFi projects.',
  MARKET_ENDPOINTS,
  {
    symbol: { type: 'string', description: 'Token symbol, e.g. "BTC". Required by price/etf/options/liquidation-chart/indicators.' },
    pair: { type: 'string', description: 'Exchange pair, e.g. "BTC-USDT". Required by exchange/* endpoints.' },
    metric: { type: 'string', description: 'Metric name (e.g. "NUPL" for onchain-indicator, ranking metric for fund/project).' },
    indicator: { type: 'string', description: 'Technical indicator, e.g. "RSI", "MACD", "BBANDS".' },
    id: { type: 'string', description: 'Article id for news/detail.' },
  },
);

export const surfChainCapability = makeSurfTool(
  'SurfChain',
  'On-chain data: bridge/yield rankings, gas, transactions, token analytics (holders, transfers, DEX trades), wallet intelligence, and raw SQL over 80+ indexed chain tables.',
  CHAIN_ENDPOINTS,
  {
    chain: { type: 'string', description: 'Chain name, e.g. "ethereum", "base". Required by gas-price/tx/holders/transfers.' },
    hash: { type: 'string', description: 'Transaction hash for onchain/tx.' },
    address: { type: 'string', description: 'Token or wallet address.' },
    addresses: { type: 'string', description: 'Comma-separated addresses for wallet/labels/batch.' },
  },
);

export const surfSocialCapability = makeSurfTool(
  'SurfSocial',
  'Crypto-Twitter / KOL signal: influence rankings, mindshare, smart-follower history, tweets, and user profiles. The canonical source for CT sentiment.',
  SOCIAL_ENDPOINTS,
  {
    q: { type: 'string', description: 'Query/topic for mindshare.' },
    interval: { type: 'string', description: 'Time interval for mindshare, e.g. "24h", "7d".' },
    handle: { type: 'string', description: 'Twitter/X handle for social/user* endpoints.' },
    ids: { type: 'string', description: 'Comma-separated tweet ids for social/tweets.' },
    tweet_id: { type: 'string', description: 'Tweet id for social/tweet/replies.' },
  },
);

export const surfCapabilities: CapabilityHandler[] = [
  surfMarketCapability,
  surfChainCapability,
  surfSocialCapability,
];
