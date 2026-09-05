/**
 * BlockRun primitive — the generic x402-paid gateway capability.
 *
 * One tool, every BlockRun endpoint. Replaces the per-API hardcoded pattern
 * (ImageGen, VideoGen, Phone tools, etc) for new integrations. Skills in
 * src/skills-bundled/<name>/SKILL.md describe which paths to call for which
 * user intents; this tool just signs the x402 payment and forwards.
 *
 * Why the indirection: BlockRun keeps shipping new partner APIs (Surf,
 * Phone & Voice, future ML/data partners). Hardcoding each as a fresh
 * CapabilityHandler means a Franklin npm release per partner and a bigger
 * tool list for the LLM to reason about. This primitive plus markdown
 * skill files decouples API expansion from agent releases — new partners
 * ship as a new SKILL.md, no code change.
 *
 * Signing pattern mirrors src/tools/modal.ts and src/phone/client.ts; we
 * deliberately keep the copy-paste rather than refactor those into a
 * shared module (out of scope; would touch unrelated tools).
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
import { resolveCharge } from '../payments/price-catalog.js';
import { gatewayBase, gatewayHeaders } from '../payments/auth-mode.js';
import { recordUsage } from '../stats/tracker.js';
import { logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// ─── x402 payment signing (same shape as modal.ts / phone/client.ts) ──────

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* not JSON, no header */ }
  }
  return header;
}

interface SignedPayment {
  headers: Record<string, string>;
  amountUsd: number; // what we just authorized — USDC is 6 decimals
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
  resourceDescription: string,
): Promise<SignedPayment | null> {
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
          resourceDescription: details.resource?.description || resourceDescription,
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return {
        headers: { 'PAYMENT-SIGNATURE': payload },
        amountUsd: Number(details.amount) / 1_000_000,
      };
    } else {
      const wallet = getOrCreateWallet();
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
          resourceDescription: details.resource?.description || resourceDescription,
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return {
        headers: { 'PAYMENT-SIGNATURE': payload },
        amountUsd: Number(details.amount) / 1_000_000,
      };
    }
  } catch (err) {
    logger.warn(`[franklin] BlockRun payment error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Pull the settlement tx hash from the gateway's X-Payment-Receipt
 * header. The X-Payment-Response header doesn't carry the amount (only
 * { success, transaction, network, payer }), so we don't parse it here
 * — the amount comes from what signPayment authorized in the 402 retry.
 */
function extractTxHash(response: Response): string | null {
  return response.headers.get('x-payment-receipt');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

interface CallResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | unknown[];
  raw: string;
  paidUsd: number;
  txHash: string | null;
  latencyMs: number;
}

async function callGateway(
  url: string,
  method: 'GET' | 'POST',
  body: Record<string, unknown> | undefined,
  resourceDescription: string,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<CallResult> {
  const start = Date.now();
  const chain = loadChain();
  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    'Accept': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (method === 'POST') headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  abortSignal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const payload = method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined;
    let response = await fetch(url, { method, signal: ctrl.signal, headers, body: payload });

    let paidUsd = 0;
    if (response.status === 402) {
      const signed = await signPayment(response, chain, url, resourceDescription);
      if (!signed) {
        return {
          ok: false, status: 402,
          body: { error: 'payment signing failed' }, raw: '',
          paidUsd: 0, txHash: null, latencyMs: Date.now() - start,
        };
      }
      paidUsd = signed.amountUsd;
      response = await fetch(url, {
        method, signal: ctrl.signal,
        headers: { ...headers, ...signed.headers },
        body: payload,
      });
    }

    const txHash = extractTxHash(response);
    // If the gateway returned 4xx after we signed, settlement was skipped
    // server-side (per the route's "Payment was NOT charged" pattern). Don't
    // claim a paid amount the wallet didn't actually spend.
    if (!response.ok) paidUsd = 0;

    const raw = await response.text().catch(() => '');
    let parsed: Record<string, unknown> | unknown[] = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave as {} */ }
    return {
      ok: response.ok, status: response.status, body: parsed, raw,
      paidUsd, txHash, latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    abortSignal.removeEventListener('abort', onParentAbort);
  }
}

function buildUrl(path: string, params: Record<string, unknown> | undefined): string {
  const chain = loadChain();
  const base = gatewayBase(); // wallet host ends in /api; the key host does not
  const clean = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${clean}`;
  if (!params || Object.keys(params).length === 0) return url;
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v));
    } else {
      usp.append(key, String(value));
    }
  }
  const qs = usp.toString();
  return qs ? `${url}?${qs}` : url;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ─── Capability ───────────────────────────────────────────────────────────

interface BlockRunInput {
  path?: string;
  method?: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export const blockrunCapability: CapabilityHandler = {
  spec: {
    name: 'BlockRun',
    description:
      'Call any BlockRun gateway endpoint. Billed to account credits or, in wallet mode, by signing an x402 USDC payment and retrying on HTTP 402. ' +
      'Use this for crypto data (Surf — markets, on-chain, social), AI inference (chat / image / video / music), prediction markets, DeFi data, and any other API exposed under https://blockrun.ai/marketplace. ' +
      'For phone and voice, prefer the typed tools (ListPhoneNumbers, BuyPhoneNumber, RenewPhoneNumber, ReleasePhoneNumber, PhoneLookup, PhoneFraudCheck, VoiceCall, VoiceStatus) — they spell out cost, required fields, and the buy-number-first requirement. ' +
      'The path must start with "/v1/" or "/.well-known/". ' +
      'Bundled skills like /surf-market, /surf-chain, /surf-social document which endpoints to call for common workflows — read those when you are unsure which path serves the user\'s question. ' +
      'Cost is wallet-charged automatically; the response includes the actual USD paid.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'API path under /api, starting with "/v1/" or "/.well-known/". E.g. "/v1/surf/market/fear-greed", "/v1/phone/numbers/list", "/v1/chat/completions".',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method. Default: POST if `body` is provided, otherwise GET.',
        },
        params: {
          type: 'object',
          description: 'Query-string parameters. Use for GETs. E.g. { symbol: "BTC" }.',
        },
        body: {
          type: 'object',
          description: 'JSON body. Use for POSTs. E.g. { model: "surf-1.5", messages: [...] }.',
        },
        timeoutMs: {
          type: 'number',
          description: `Optional client-side timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
        },
      },
      required: ['path'],
    },
  },
  concurrent: true,
  async execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
    const raw = input as BlockRunInput;

    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!path) {
      return { output: 'Error: `path` is required (e.g. "/v1/surf/market/fear-greed").', isError: true };
    }
    if (!/^\/(v1|\.well-known)\//.test(path)) {
      return {
        output: `Error: path must start with "/v1/" or "/.well-known/". Got: ${path}`,
        isError: true,
      };
    }

    const params = (raw.params && typeof raw.params === 'object') ? raw.params : undefined;
    const body = (raw.body && typeof raw.body === 'object') ? raw.body : undefined;

    // Method resolution: explicit > inferred from body > default GET
    const explicitMethod = typeof raw.method === 'string' ? raw.method.toUpperCase() : '';
    const method: 'GET' | 'POST' = explicitMethod === 'POST' || explicitMethod === 'GET'
      ? explicitMethod
      : (body ? 'POST' : 'GET');

    const timeoutMs = Math.min(
      Math.max(1_000, typeof raw.timeoutMs === 'number' ? raw.timeoutMs : DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );

    const url = buildUrl(path, method === 'GET' ? params : undefined);
    const resourceDescription = `BlockRun ${method} ${path}`;

    const result = await callGateway(
      url, method,
      method === 'POST' ? body : undefined,
      resourceDescription,
      ctx.abortSignal,
      timeoutMs,
    );

    // Telemetry — show in the panel Audit tab regardless of success
    try {
      // `paidUsd` comes from the 402 settlement and is 0 in API-key mode,
      // where the gateway charges without a handshake. Price from the catalog
      // so raw gateway calls still count against --max-spend.
      const charge = resolveCharge({ apiPath: path, settledUsd: result.paidUsd });
      recordUsage(`BlockRun:${path}`, 0, 0, charge.usd, result.latencyMs, false, charge.estimated);
    } catch { /* best-effort */ }

    if (!result.ok) {
      const b = result.body as Record<string, unknown>;
      const detail = typeof b?.error === 'string' ? b.error : `HTTP ${result.status}`;
      const fullOutput = result.raw || JSON.stringify(result.body, null, 2);
      // Surface the gateway's self-correction hints into the model-visible
      // output. On a wrong path the Surf route returns `available: [...all
      // valid paths]` (and often a `message`); without this the model only
      // saw "Not Found" and kept guessing until the tool-failure circuit
      // breaker tripped. The list comes straight from the live registry, so
      // it's always complete and in sync — no drift.
      const hint = typeof b?.message === 'string' ? `\n${b.message}` : '';
      const avail = Array.isArray(b?.available)
        ? `\nValid endpoints: ${(b.available as unknown[]).filter((x) => typeof x === 'string').join(', ')}`
        : '';
      return {
        output: `BlockRun ${method} ${path} failed: ${detail} (status ${result.status}). No charge if status is 4xx pre-payment.${hint}${avail}`,
        fullOutput,
        isError: true,
      };
    }

    const head = `BlockRun ${method} ${path} → ${fmtUsd(result.paidUsd)}${result.txHash ? ` · tx ${result.txHash.slice(0, 10)}…` : ''} · ${result.latencyMs}ms`;
    const payload = typeof result.body === 'object' ? JSON.stringify(result.body, null, 2) : String(result.body);
    return {
      output: `${head}\n${payload}`,
      fullOutput: `${head}\n${payload}`,
    };
  },
};
