/**
 * DefiLlama capabilities — TVL, yield pools, protocol metadata, and token
 * prices via the BlockRun `/v1/defillama/*` endpoints. Each tool handles
 * x402 payment automatically against the user's USDC wallet.
 *
 * Five tools, each filtered + formatted on the way back so we don't dump
 * 5–10 MB of raw DefiLlama JSON into agent context:
 *  - DeFiLlamaProtocols   $0.0050/call base (plus a $0.001 settlement fee on a wallet) — top-N protocols by TVL
 *  - DeFiLlamaProtocol    $0.0050/call base (plus a $0.001 settlement fee on a wallet) — single protocol detail
 *  - DeFiLlamaChains      $0.0050/call base (plus a $0.001 settlement fee on a wallet) — TVL ranked by chain
 *  - DeFiLlamaYields      $0.0050/call base (plus a $0.001 settlement fee on a wallet) — yield pools, filtered + ranked
 *  - DeFiLlamaPrice       $0.0050/call base (plus a $0.001 settlement fee on a wallet) — token price lookup
 *
 * DefiLlama is Apache 2.0 / "free for public and commercial use" — the
 * BlockRun gateway adds metering + (future) caching/reliability layers,
 * which is what the per-call charge funds.
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
import { recordUsage } from '../stats/tracker.js';
import { frameUntrusted } from './untrusted.js';

const TIMEOUT_MS = 30_000;

// ─── Shared GET-with-x402 flow ────────────────────────────────────────────

async function getWithPayment<T>(path: string, ctx: ExecutionScope): Promise<T> {
  const chain = loadChain();
  const apiUrl = gatewayBase();
  const endpoint = `${apiUrl}${path}`;
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
  let paidUsd = 0;
  try {
    let response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });

    if (response.status === 402) {
      const signed = await signPayment(response, chain, endpoint);
      if (!signed) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      paidUsd = signed.amountUsd;
      response = await fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...headers, ...signed.headers },
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`DefiLlama ${path} failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    // Record the settled x402 spend so DeFiLlama calls show up in franklin
    // stats / audit AND count against the --max-spend ceiling (parity with surf.ts).
    // See rpc.ts — `paidUsd` is 0 whenever no 402 happened, which is every
    // call in API-key mode.
    const charge = resolveCharge({ apiPath: endpoint, chargedUsd: chargeFromResponse(response), settledUsd: paidUsd });
    try { recordUsage(`DeFiLlama:${path}`, 0, 0, charge.usd, Date.now() - startedAt, false, charge.estimated, requestIdFromResponse(response)); } catch { /* best-effort */ }
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
): Promise<{ headers: Record<string, string>; amountUsd: number } | null> {
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
          resourceDescription: details.resource?.description || 'Franklin DefiLlama call',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { headers: { 'PAYMENT-SIGNATURE': payload }, amountUsd: Number(details.amount) / 1_000_000 };
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
        resourceDescription: details.resource?.description || 'Franklin DefiLlama call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { headers: { 'PAYMENT-SIGNATURE': payload }, amountUsd: Number(details.amount) / 1_000_000 };
  } catch (err) {
    logger.warn(`[franklin] DefiLlama payment error: ${(err as Error).message}`);
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

// ─── Formatting helpers ──────────────────────────────────────────────────

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number | null | undefined, digits: number = 2): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

// ─── DeFiLlamaProtocols ─────────────────────────────────────────────────

interface ProtocolEntry {
  id: string;
  name: string;
  slug: string;
  tvl: number;
  category?: string;
  chains?: string[];
  change_1d?: number;
  change_7d?: number;
  url?: string;
}

interface ProtocolsInput {
  top_n?: number;
  category?: string;
  chain?: string;
  min_tvl_usd?: number;
}

export const defiLlamaProtocolsCapability: CapabilityHandler = {
  spec: {
    name: 'DeFiLlamaProtocols',
    description:
      'Rank DeFi protocols by total value locked (TVL) across all chains, optionally filtered by category, chain, or minimum TVL. ' +
      'Returns the top-N protocols (default 20), each with TVL, 24h/7d change, chain breakdown, and slug. ' +
      'Uses BlockRun gateway → DefiLlama. $0.0050 per call base, plus a $0.001 settlement fee when paying from a wallet. ' +
      'Categories include: Lending, Liquid Staking, Bridge, Dexes, CDP, Yield, Yield Aggregator, Derivatives, Stablecoins, Insurance, etc.',
    input_schema: {
      type: 'object',
      properties: {
        top_n: { type: 'number', description: 'Max results (default 20, hard cap 100).' },
        category: { type: 'string', description: 'Category filter, exact match (case-insensitive).' },
        chain: { type: 'string', description: 'Chain name filter (e.g. "Ethereum", "Solana", "Base").' },
        min_tvl_usd: { type: 'number', description: 'Drop protocols with TVL below this floor.' },
      },
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as ProtocolsInput;
    const topN = Math.min(Math.max(1, params.top_n ?? 20), 100);
    try {
      const res = await getWithPayment<ProtocolEntry[]>('/v1/defillama/protocols', ctx);
      let list = res ?? [];
      if (params.category) {
        const want = params.category.toLowerCase();
        list = list.filter((p) => (p.category ?? '').toLowerCase() === want);
      }
      if (params.chain) {
        const want = params.chain.toLowerCase();
        list = list.filter((p) => (p.chains ?? []).some((c) => c.toLowerCase() === want));
      }
      if (params.min_tvl_usd != null) {
        list = list.filter((p) => Number(p.tvl) >= params.min_tvl_usd!);
      }
      list.sort((a, b) => Number(b.tvl) - Number(a.tvl));
      list = list.slice(0, topN);
      if (list.length === 0) return { output: 'No DefiLlama protocols matched the filters.' };

      const lines: string[] = [
        `## DefiLlama protocols — top ${list.length}` +
          (params.category ? ` · category=${params.category}` : '') +
          (params.chain ? ` · chain=${params.chain}` : ''),
      ];
      list.forEach((p, i) => {
        const chains = (p.chains ?? []).slice(0, 4).join(', ');
        const more = (p.chains ?? []).length > 4 ? ` +${(p.chains ?? []).length - 4}` : '';
        const cat = p.category ? ` · ${p.category}` : '';
        const change = p.change_1d != null ? ` · 24h ${formatPct(p.change_1d)}` : '';
        lines.push(
          `${i + 1}. **${p.name}** (${p.slug}) — ${formatUsd(Number(p.tvl))}${cat}${change}\n   chains: ${chains}${more}`,
        );
      });
      return { output: frameUntrusted('DefiLlama data (untrusted)', lines.join('\n')) };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── DeFiLlamaProtocol (single) ─────────────────────────────────────────

interface ProtocolDetail {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  url?: string;
  category?: string;
  chains?: string[];
  tvl?: number | Array<{ totalLiquidityUSD?: number; date?: number }>;
  currentChainTvls?: Record<string, number>;
  change_1d?: number;
  change_7d?: number;
  audits?: string;
  twitter?: string;
}

interface ProtocolInput {
  slug: string;
}

export const defiLlamaProtocolCapability: CapabilityHandler = {
  spec: {
    name: 'DeFiLlamaProtocol',
    description:
      'Detailed TVL + chain breakdown for a single DeFi protocol identified by DefiLlama slug ' +
      '(e.g. "aave", "uniswap", "lido", "jito", "marinade-finance"). ' +
      'Returns TVL across each chain it operates on, recent change, audits, social. ' +
      '$0.0050 per call base, plus a $0.001 settlement fee when paying from a wallet. To find a slug, run DeFiLlamaProtocols first.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'DefiLlama protocol slug, lowercase, dash-separated.' },
      },
      required: ['slug'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as ProtocolInput;
    if (!params.slug) return { output: 'Error: slug is required', isError: true };
    try {
      const safeSlug = encodeURIComponent(params.slug.trim().toLowerCase());
      const p = await getWithPayment<ProtocolDetail>(`/v1/defillama/protocol/${safeSlug}`, ctx);

      const chainBreakdown = p.currentChainTvls
        ? Object.entries(p.currentChainTvls)
            .filter(([k]) => !k.endsWith('-staking') && !k.endsWith('-borrowed') && !k.endsWith('-pool2'))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([chain, tvl]) => `${chain} ${formatUsd(tvl)}`)
            .join(', ')
        : 'n/a';

      const totalTvl = p.currentChainTvls
        ? Object.values(p.currentChainTvls).reduce((a, b) => a + b, 0)
        : Array.isArray(p.tvl)
          ? p.tvl[p.tvl.length - 1]?.totalLiquidityUSD ?? 0
          : (p.tvl as number) ?? 0;

      const lines: string[] = [
        `## ${p.name}${p.category ? ` (${p.category})` : ''}`,
        '',
        `TVL: ${formatUsd(totalTvl)}`,
      ];
      if (p.change_1d != null) lines.push(`24h change: ${formatPct(p.change_1d)}`);
      if (p.change_7d != null) lines.push(`7d change: ${formatPct(p.change_7d)}`);
      lines.push(`Chains: ${chainBreakdown}`);
      if (p.url) lines.push(`URL: ${p.url}`);
      if (p.twitter) lines.push(`Twitter: @${p.twitter}`);
      if (p.audits) lines.push(`Audits: ${p.audits}`);
      if (p.description) lines.push('', p.description);
      return { output: frameUntrusted('DefiLlama data (untrusted)', lines.join('\n')) };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── DeFiLlamaChains ─────────────────────────────────────────────────────

interface ChainEntry {
  name: string;
  tvl: number;
  tokenSymbol?: string | null;
  cmcId?: string | null;
  gecko_id?: string | null;
}

interface ChainsInput {
  top_n?: number;
}

export const defiLlamaChainsCapability: CapabilityHandler = {
  spec: {
    name: 'DeFiLlamaChains',
    description:
      'TVL ranking across every chain DefiLlama tracks. Default returns top 20 by TVL. $0.0050 per call base, plus a $0.001 settlement fee when paying from a wallet.',
    input_schema: {
      type: 'object',
      properties: {
        top_n: { type: 'number', description: 'Max results (default 20, hard cap 200).' },
      },
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as ChainsInput;
    const topN = Math.min(Math.max(1, params.top_n ?? 20), 200);
    try {
      const list = await getWithPayment<ChainEntry[]>('/v1/defillama/chains', ctx);
      const sorted = (list ?? []).slice().sort((a, b) => Number(b.tvl) - Number(a.tvl)).slice(0, topN);
      if (sorted.length === 0) return { output: 'DefiLlama returned no chains.' };
      const lines: string[] = [`## TVL by chain — top ${sorted.length}`];
      sorted.forEach((c, i) => {
        const sym = c.tokenSymbol ? ` (${c.tokenSymbol})` : '';
        lines.push(`${i + 1}. **${c.name}**${sym} — ${formatUsd(Number(c.tvl))}`);
      });
      return { output: frameUntrusted('DefiLlama data (untrusted)', lines.join('\n')) };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── DeFiLlamaYields ─────────────────────────────────────────────────────

interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase?: number | null;
  apyReward?: number | null;
  stablecoin?: boolean;
  ilRisk?: string;
  exposure?: string;
}

interface YieldsResponse {
  status?: string;
  data?: YieldPool[];
}

interface YieldsInput {
  symbol?: string;
  chain?: string;
  project?: string;
  min_tvl_usd?: number;
  min_apy_pct?: number;
  stablecoin_only?: boolean;
  top_n?: number;
}

export const defiLlamaYieldsCapability: CapabilityHandler = {
  spec: {
    name: 'DeFiLlamaYields',
    description:
      'Search DeFi yield pools (lending, LPs, vaults, staking) by symbol/chain/project, ranked by APY. ' +
      'Returns top-N pools (default 10). $0.0050 per call base, plus a $0.001 settlement fee when paying from a wallet. ' +
      'Default filters: TVL > $1M (avoid microcaps), APY > 0. Override via params. ' +
      'Use stablecoin_only=true for "where can my USDC earn?" queries.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Token symbol filter (e.g. "USDC", "ETH"). Matches tokens in the pool.' },
        chain: { type: 'string', description: 'Chain filter (e.g. "Ethereum", "Solana", "Base").' },
        project: { type: 'string', description: 'DefiLlama project slug filter (e.g. "aave-v3", "lido", "kamino").' },
        min_tvl_usd: { type: 'number', description: 'Minimum pool TVL in USD (default 1_000_000).' },
        min_apy_pct: { type: 'number', description: 'Minimum APY in percent (default 0).' },
        stablecoin_only: { type: 'boolean', description: 'If true, only stablecoin pools.' },
        top_n: { type: 'number', description: 'Max results (default 10, hard cap 50).' },
      },
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as YieldsInput;
    const topN = Math.min(Math.max(1, params.top_n ?? 10), 50);
    const minTvl = params.min_tvl_usd ?? 1_000_000;
    const minApy = params.min_apy_pct ?? 0;
    try {
      const res = await getWithPayment<YieldsResponse>('/v1/defillama/yields', ctx);
      const pools = res.data ?? [];
      let filtered = pools.filter(
        (p) => (p.apy ?? -1) >= minApy && (p.tvlUsd ?? 0) >= minTvl,
      );
      if (params.symbol) {
        const want = params.symbol.toUpperCase();
        filtered = filtered.filter((p) => p.symbol?.toUpperCase().includes(want));
      }
      if (params.chain) {
        const want = params.chain.toLowerCase();
        filtered = filtered.filter((p) => p.chain?.toLowerCase() === want);
      }
      if (params.project) {
        const want = params.project.toLowerCase();
        filtered = filtered.filter((p) => p.project?.toLowerCase() === want);
      }
      if (params.stablecoin_only) {
        filtered = filtered.filter((p) => p.stablecoin === true);
      }
      filtered.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));
      const top = filtered.slice(0, topN);
      if (top.length === 0) return { output: 'No yield pools matched the filters.' };

      const filterDesc = [
        params.symbol && `symbol=${params.symbol}`,
        params.chain && `chain=${params.chain}`,
        params.project && `project=${params.project}`,
        params.stablecoin_only && 'stablecoin_only',
        `min_tvl=${formatUsd(minTvl)}`,
        `min_apy=${minApy}%`,
      ]
        .filter(Boolean)
        .join(' · ');
      const lines: string[] = [`## Yield pools — top ${top.length} by APY · ${filterDesc}`];
      top.forEach((p, i) => {
        const breakdown =
          p.apyBase != null && p.apyReward != null
            ? ` (base ${p.apyBase.toFixed(2)}% + reward ${p.apyReward.toFixed(2)}%)`
            : '';
        const il = p.ilRisk ? ` · IL: ${p.ilRisk}` : '';
        lines.push(
          `${i + 1}. **${p.project}** / ${p.chain} / ${p.symbol} — ${(p.apy ?? 0).toFixed(2)}% APY${breakdown}\n   TVL: ${formatUsd(p.tvlUsd)}${il} · pool: ${p.pool}`,
        );
      });
      return { output: frameUntrusted('DefiLlama data (untrusted)', lines.join('\n')) };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

// ─── DeFiLlamaPrice ─────────────────────────────────────────────────────

interface PriceEntry {
  price?: number;
  symbol?: string;
  timestamp?: number;
  confidence?: number;
}

interface PriceResponse {
  coins: Record<string, PriceEntry>;
}

interface PriceInput {
  coins: string[];
}

export const defiLlamaPriceCapability: CapabilityHandler = {
  spec: {
    name: 'DeFiLlamaPrice',
    description:
      'Token price lookup via DefiLlama (covers thousands of tokens — anything DEX-listed). $0.0050 per call base, plus a $0.001 settlement fee when paying from a wallet. ' +
      'Coin identifier syntax: "{platform}:{address}" or "coingecko:{slug}". ' +
      'Examples: "coingecko:bitcoin" (BTC USD), "ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" (WETH), ' +
      '"solana:So11111111111111111111111111111111111111112" (SOL/wSOL), ' +
      '"solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" (BONK). ' +
      'Pass multiple identifiers for batch lookup. ' +
      'Use the existing /v1/crypto/price/{symbol} endpoint via TradingMarket for the major-asset shorthand instead — ' +
      'this tool is for arbitrary on-chain mints / addresses.',
    input_schema: {
      type: 'object',
      properties: {
        coins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Coin identifiers in DefiLlama syntax. Up to 50 per call.',
        },
      },
      required: ['coins'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as PriceInput;
    if (!params.coins || params.coins.length === 0) {
      return { output: 'Error: coins array is required', isError: true };
    }
    if (params.coins.length > 50) {
      return { output: `Error: max 50 coins per call (got ${params.coins.length})`, isError: true };
    }
    try {
      const safeList = params.coins.map((c) => encodeURIComponent(c.trim())).join(',');
      const res = await getWithPayment<PriceResponse>(`/v1/defillama/prices/${safeList}`, ctx);
      const coins = res.coins ?? {};
      const lines: string[] = [`## Token prices — ${Object.keys(coins).length} match(es)`];
      for (const id of params.coins) {
        const entry = coins[id];
        if (!entry || entry.price == null) {
          lines.push(`- ${id}: no price returned`);
          continue;
        }
        const sym = entry.symbol ? ` (${entry.symbol})` : '';
        const conf = entry.confidence != null ? ` · conf ${(entry.confidence * 100).toFixed(0)}%` : '';
        const ts = entry.timestamp ? ` · ${new Date(entry.timestamp * 1000).toISOString().slice(0, 19)}Z` : '';
        lines.push(`- **${id}**${sym}: $${entry.price.toFixed(entry.price < 0.01 ? 8 : 4)}${conf}${ts}`);
      }
      return { output: frameUntrusted('DefiLlama data (untrusted)', lines.join('\n')) };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};
