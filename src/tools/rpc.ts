/**
 * Multi-chain RPC — read-only JSON-RPC across 40+ chains via the BlockRun
 * `/v1/rpc/{network}` endpoint (Tatum gateway). x402-paid against the user's
 * USDC wallet, flat $0.0020 base + $0.001 settlement fee (measured 2026-09-05).
 *
 * For a trading agent this covers the on-chain reads the dedicated tools don't:
 * native + ERC-20 balances on any chain, contract reads (eth_call), gas price,
 * nonce, block height, and "did my tx land?" receipt checks — without needing
 * a per-chain RPC key.
 *
 * READ-ONLY by design (per product decision): state-changing / signing methods
 * are rejected. Sending transactions goes through the wallet / Jupiter / 0x
 * tools, which handle signing + confirmation. This tool never signs a chain tx
 * (the only signature it produces is the x402 micropayment for the API call).
 *
 * Direct gateway fetch (same pattern as the DefiLlama / Surf tools) — does not
 * depend on the SDK's RpcClient, so it works on the pinned @blockrun/llm 2.x.
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

const TIMEOUT_MS = 30_000;

// Curated chains the gateway exposes (for the agent + validation). Unknown but
// well-formed slugs still pass through — the gateway resolves them — so this is
// guidance, not a hard allowlist. Mirrors backend src/lib/tatum.ts.
const KNOWN_NETWORKS = [
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche',
  'fantom', 'cronos', 'celo', 'gnosis', 'zksync', 'berachain', 'unichain',
  'monad', 'sonic', 'xdc', 'abstract', 'hyperevm', 'plume', 'ronin', 'rootstock',
  'solana', 'bitcoin', 'litecoin', 'dogecoin', 'bitcoin-cash', 'near', 'sui',
  'ripple', 'polkadot', 'zcash',
];

// State-changing / signing methods — rejected (read-only tool). Matched
// case-insensitively against the method name.
const WRITE_METHODS = new Set(
  [
    // EVM
    'eth_sendrawtransaction', 'eth_sendtransaction', 'eth_sign',
    'eth_signtransaction', 'eth_signtypeddata', 'eth_signtypeddata_v3',
    'eth_signtypeddata_v4', 'personal_sign', 'personal_sendtransaction',
    'personal_unlockaccount', 'personal_importrawkey',
    // Solana
    'sendtransaction', 'requestairdrop',
    // Bitcoin-family
    'sendrawtransaction',
  ].map((m) => m.toLowerCase()),
);

// ─── POST-with-x402 flow (JSON-RPC body) ──────────────────────────────────

interface RpcCallResult {
  body: unknown;
  network: string;
  cacheHit: boolean;
  txHash: string | null;
}

async function postRpcWithPayment(
  network: string,
  jsonRpcBody: unknown,
  ctx: ExecutionScope,
): Promise<RpcCallResult> {
  const chain = loadChain();
  const apiUrl = gatewayBase();
  const endpoint = `${apiUrl}/v1/rpc/${network}`;
  const bodyStr = JSON.stringify(jsonRpcBody);
  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    'Content-Type': 'application/json',
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
      method: 'POST',
      signal: controller.signal,
      headers,
      body: bodyStr,
    });

    if (response.status === 402) {
      const signed = await signPayment(response, chain, endpoint);
      if (!signed) {
        throw new Error('Payment signing failed — check wallet balance');
      }
      paidUsd = signed.amountUsd;
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...signed.headers },
        body: bodyStr,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`RPC ${network} failed (${response.status}): ${errText.slice(0, 200)}`);
    }

    // Record the settled x402 spend so RPC calls show up in franklin stats /
    // audit AND count against the --max-spend ceiling (parity with surf.ts).
    // `paidUsd` is only ever set by the 402 branch, so in API-key mode — where
    // the gateway settles silently and never sends a 402 — it stays 0. Price the
    // call from the published catalog instead of recording a free call.
    const charge = resolveCharge({ apiPath: endpoint, chargedUsd: chargeFromResponse(response), settledUsd: paidUsd });
    try { recordUsage(`MultiChainRPC:${network}`, 0, 0, charge.usd, Date.now() - startedAt, false, charge.estimated, requestIdFromResponse(response)); } catch { /* best-effort */ }
    return {
      body: await response.json(),
      network: response.headers.get('x-network') || network,
      cacheHit: (response.headers.get('x-cache') || '').toUpperCase() === 'HIT',
      txHash: response.headers.get('x-payment-receipt'),
    };
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
          resourceDescription: details.resource?.description || 'Franklin multi-chain RPC',
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
        resourceDescription: details.resource?.description || 'Franklin multi-chain RPC',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { headers: { 'PAYMENT-SIGNATURE': payload }, amountUsd: Number(details.amount) / 1_000_000 };
  } catch (err) {
    logger.warn(`[franklin] RPC payment error: ${(err as Error).message}`);
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

// ─── MultiChainRPC ────────────────────────────────────────────────────────

interface RpcInput {
  network: string;
  method: string;
  params?: unknown[];
}

export const multiChainRpcCapability: CapabilityHandler = {
  spec: {
    name: 'MultiChainRPC',
    description:
      'Read-only JSON-RPC against 40+ chains through the BlockRun gateway (one endpoint, no per-chain key). ' +
      '$0.0020 per call, plus a $0.001 settlement fee when paying from a wallet. Use for on-chain reads the other tools do not cover: native/token balances on any ' +
      'chain, contract reads (eth_call), gas price, nonce, block height, and tx receipt checks ("did my swap land?"). ' +
      'EVM chains speak eth_* (eth_blockNumber, eth_getBalance, eth_call, eth_gasPrice, eth_getTransactionReceipt, ...); ' +
      'Solana speaks getSlot/getBalance/getAccountInfo/getTransaction; Bitcoin-family speaks getblockcount etc. ' +
      'Networks: ethereum, base, arbitrum, optimism, polygon, bsc, avalanche, solana, bitcoin, sui, ripple, and 30+ more ' +
      '(common aliases like eth/arb/op/matic/sol/btc also work). ' +
      'READ-ONLY: signing / send-transaction methods are rejected — use the wallet, Jupiter, or 0x tools to move funds.',
    input_schema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          description: 'Chain name or alias, e.g. "ethereum", "base", "solana", "arbitrum", "bitcoin".',
        },
        method: {
          type: 'string',
          description: 'JSON-RPC method, e.g. "eth_getBalance", "eth_call", "eth_blockNumber", "getSlot".',
        },
        params: {
          type: 'array',
          description: 'Method params array (optional). E.g. ["0xADDR","latest"] for eth_getBalance.',
          items: {},
        },
      },
      required: ['network', 'method'],
    },
  },
  execute: async (input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> => {
    const params = input as unknown as RpcInput;
    const network = (params.network ?? '').trim().toLowerCase();
    const method = (params.method ?? '').trim();

    if (!network) return { output: 'Error: network is required', isError: true };
    if (!method) return { output: 'Error: method is required', isError: true };
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(network)) {
      return { output: `Error: malformed network "${params.network}"`, isError: true };
    }
    if (WRITE_METHODS.has(method.toLowerCase())) {
      return {
        output:
          `Error: "${method}" is a state-changing method and is blocked — MultiChainRPC is read-only. ` +
          `To send funds or sign transactions, use the wallet / JupiterSwap / Base0x* tools.`,
        isError: true,
      };
    }

    const rpcParams = Array.isArray(params.params) ? params.params : [];
    const jsonRpcBody = { jsonrpc: '2.0', id: 1, method, params: rpcParams };

    try {
      const res = await postRpcWithPayment(network, jsonRpcBody, ctx);
      const envelope = res.body as { result?: unknown; error?: { code?: number; message?: string } };

      if (envelope && envelope.error) {
        return {
          output:
            `JSON-RPC error from ${res.network} ${method}: ` +
            `${envelope.error.message ?? 'unknown'} (code ${envelope.error.code ?? 'n/a'})`,
          isError: true,
        };
      }

      const result = envelope?.result;
      const pretty =
        typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
      // Guard context size — chain reads (getLogs, large account data) can be big.
      const trimmed = pretty.length > 6000 ? `${pretty.slice(0, 6000)}\n…(truncated)` : pretty;
      const meta = res.cacheHit ? ' · cached' : '';
      return { output: `## ${res.network} · ${method}${meta}\n\n${trimmed}` };
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  },
  concurrent: true,
};

export { KNOWN_NETWORKS };
