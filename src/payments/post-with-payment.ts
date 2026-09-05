/**
 * Shared x402 POST helper.
 *
 * Posts JSON to a BlockRun gateway endpoint and transparently completes the
 * x402 payment handshake: the first POST may return 402 with payment
 * requirements, we sign with the local wallet (Base or Solana, per active
 * chain) and retry once with the signature header.
 *
 * Extracted from src/phone/client.ts so phone, onramp, and any future
 * gateway clients share one implementation instead of copy-pasting the
 * 402 dance. Endpoints that are free simply return 200 on the first POST,
 * in which case no signing happens.
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
import { loadChain, USER_AGENT, type Chain } from '../config.js';
import {
  gatewayHeaders,
  resolvePayMode,
} from './auth-mode.js';

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

async function signPayment(
  response: Response,
  chain: Chain,
  endpoint: string,
  resourceDescription: string,
): Promise<Record<string, string> | null> {
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
    return { 'PAYMENT-SIGNATURE': payload };
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
    return { 'PAYMENT-SIGNATURE': payload };
  }
}

export interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  raw: string;
  /**
   * True only when this call completed an x402 handshake, i.e. a wallet
   * signature actually moved USDC. False in key mode and on free endpoints —
   * callers must price those locally rather than recording zero spend.
   */
  settled: boolean;
}

/**
 * POST JSON to a gateway endpoint, completing the x402 handshake if the
 * endpoint demands payment. `resourceDescription` is surfaced to the user
 * in the wallet signature for free-text context.
 */
export async function postWithPayment(
  endpoint: string,
  body: Record<string, unknown>,
  resourceDescription: string,
  timeoutMs = 30_000,
): Promise<PostResult> {
  const chain = loadChain();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const payload = JSON.stringify(body);
    const mode = resolvePayMode();

    // Key mode: one authenticated POST, no 402 dance. The gateway settles
    // against the prepaid balance and answers 200 directly.
    if (mode.kind === 'key') {
      const keyHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...gatewayHeaders(mode),
      };
      const keyResponse = await fetch(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: keyHeaders,
        body: payload,
      });
      const keyRaw = await keyResponse.text().catch(() => '');
      // An account failure is never permission to spend from a wallet.
      // The user can explicitly select --wallet and retry the command.
      let parsedKey: Record<string, unknown> = {};
      try { parsedKey = keyRaw ? JSON.parse(keyRaw) : {}; } catch { /* leave as {} */ }
      return { ok: keyResponse.ok, status: keyResponse.status, body: parsedKey, raw: keyRaw, settled: false };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: payload,
    });

    let settled = false;
    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint, resourceDescription);
      if (!paymentHeaders) {
        return { ok: false, status: 402, body: { error: 'payment signing failed' }, raw: '', settled: false };
      }
      response = await fetch(endpoint, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { ...headers, ...paymentHeaders },
        body: payload,
      });
      settled = response.ok;
    }

    const raw = await response.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave as {} */ }
    return { ok: response.ok, status: response.status, body: parsed, raw, settled };
  } finally {
    clearTimeout(timer);
  }
}
