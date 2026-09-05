/**
 * Phone number management — buy / list / renew / release / lookup wallet-
 * owned phone numbers via the BlockRun gateway `/v1/phone/*` endpoints.
 *
 * Each lifecycle action is its own typed tool (rather than a single generic
 * "phone manager") so the agent's tool-list pattern-matches naturally on the
 * user's intent — "buy me a number" → BuyPhoneNumber, "list my numbers" →
 * ListPhoneNumbers — without needing to consult the BlockRun primitive or
 * the `.well-known/x402` manifest.
 *
 * x402 payment flow mirrors src/tools/exa.ts: a 402 from the gateway triggers
 * a signed USDC transfer (Base or Solana), retry succeeds.
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
import { gatewayBase, gatewayHeaders } from '../payments/auth-mode.js';
import { logger } from '../logger.js';
import { recordUsage } from '../stats/tracker.js';
import { chargedNote, noChargeNote, cancelHint } from '../payments/billing-copy.js';

const PHONE_TIMEOUT_MS = 30_000;

// ─── Shared payment flow (POST) ───────────────────────────────────────────
//
// Records cost telemetry to franklin-stats.json on success — so the status
// bar's per-turn spend reflects the real $0.001/$0.05/$5 charges from the
// gateway, not just the LLM call that triggered the tool. recordUsage is a
// no-op on failure (no charge → nothing to record).

interface PaidCallMeta {
  /** Tool name shown in the status bar / audit tab (e.g. "BuyPhoneNumber"). */
  tool: string;
  /** USD amount the gateway charges on success. 0 for free routes. */
  priceUsd: number;
}

async function postWithPayment<T>(
  path: string,
  body: unknown,
  ctx: ExecutionScope,
  meta: PaidCallMeta,
): Promise<T> {
  const startMs = Date.now();
  const chain = loadChain();
  const apiUrl = gatewayBase();
  const endpoint = `${apiUrl}${path}`;
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHONE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

  try {
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: bodyStr,
    });

    if (response.status === 402) {
      const paymentHeaders = await signPayment(response, chain, endpoint, 'Franklin phone');
      if (!paymentHeaders) throw new Error('Payment signing failed — check wallet balance');
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
        body: bodyStr,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Phone ${path} failed (${response.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await response.json()) as T;
    try {
      recordUsage(meta.tool, 0, 0, meta.priceUsd, Date.now() - startMs);
    } catch { /* telemetry best-effort */ }
    return data;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string,
  description: string,
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
          resourceDescription: details.resource?.description || description,
          maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
          extra: details.extra as Record<string, unknown> | undefined,
        },
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
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
        resourceDescription: details.resource?.description || description,
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] Phone payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* not JSON */ }
  }
  return header;
}

// ─── Tools ─────────────────────────────────────────────────────────────────

export const listPhoneNumbersCapability: CapabilityHandler = {
  spec: {
    name: 'ListPhoneNumbers',
    description:
      'List the phone numbers your wallet currently owns (US/CA, leased 30 days at a time). ' +
      'Use this before any phone-related action to remind the agent what numbers are available. ' +
      'Costs $0.001 per call. Returns each number with country, area code, expiration timestamp, ' +
      'and current status (active/expiring/expired).',
    input_schema: { type: 'object', properties: {} },
  },
  execute: async (_input, ctx): Promise<CapabilityResult> => {
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/numbers/list', {}, ctx, { tool: 'ListPhoneNumbers', priceUsd: 0.001 },
      );
      return {
        output:
          `## Phone numbers (provisioned to this account)\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Phone list failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const buyPhoneNumberCapability: CapabilityHandler = {
  spec: {
    name: 'BuyPhoneNumber',
    description:
      'Provision a new US or CA phone number for 30 days. Costs $5.00 per number. ' +
      'Optionally pin a 3-digit area code (best effort). The provisioned number is auto-registered ' +
      'as a valid caller ID for outbound VoiceCall. A wallet can hold multiple numbers; this adds ' +
      'one, never replaces. To pick the country: country="US" (default) or country="CA".',
    input_schema: {
      type: 'object',
      properties: {
        country: { type: 'string', enum: ['US', 'CA'], description: 'Country code (default: US)' },
        area_code: { type: 'string', description: 'Preferred 3-digit area code (best effort)' },
      },
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    const body: Record<string, string> = {};
    if (typeof input.country === 'string') body.country = input.country;
    if (typeof input.area_code === 'string') body.areaCode = input.area_code;
    // Confirm the $5 spend before charging — this is the most expensive single
    // autonomous action, so it gets the same gate as a $0.05 ModalCreate. Direct
    // callers (FRANKLIN_MEDIA_AUTO_APPROVE_ALL=1 or no onAskUser bridge) proceed.
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!autoApprove && ctx.onAskUser) {
      const answer = await ctx.onAskUser(
        `Buy a new ${body.country || 'US'} phone number for $5.00? ${cancelHint()}`,
        ['Buy', 'Cancel'],
      );
      if (answer !== 'Buy') {
        return { output: `## Phone number purchase cancelled\n\n${noChargeNote()}` };
      }
    }
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/numbers/buy', body, ctx, { tool: 'BuyPhoneNumber', priceUsd: 5.0 },
      );
      return {
        output:
          `## Number provisioned (${chargedNote(5)})\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Buy failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const renewPhoneNumberCapability: CapabilityHandler = {
  spec: {
    name: 'RenewPhoneNumber',
    description:
      'Extend the 30-day lease on a BlockRun-provisioned phone number. Costs $5.00. Use ListPhoneNumbers ' +
      'first to confirm the number is yours. Released or expired numbers cannot be renewed — buy a ' +
      'new one with BuyPhoneNumber instead.',
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'E.164 format, e.g. +14155552671' },
      },
      required: ['phone_number'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.phone_number !== 'string') {
      return { output: 'phone_number (E.164) required', isError: true };
    }
    // Confirm the $5 spend before charging (parity with BuyPhoneNumber / ModalCreate).
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!autoApprove && ctx.onAskUser) {
      const answer = await ctx.onAskUser(
        `Renew ${input.phone_number} for 30 days at $5.00? ${cancelHint()}`,
        ['Renew', 'Cancel'],
      );
      if (answer !== 'Renew') {
        return { output: `## Renewal cancelled\n\n${noChargeNote()}` };
      }
    }
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/numbers/renew',
        { phoneNumber: input.phone_number },
        ctx,
        { tool: 'RenewPhoneNumber', priceUsd: 5.0 },
      );
      return {
        output:
          `## Lease renewed (+30 days, ${chargedNote(5)})\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Renew failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const releasePhoneNumberCapability: CapabilityHandler = {
  spec: {
    name: 'ReleasePhoneNumber',
    description:
      'Release a BlockRun-provisioned phone number back to the pool before its lease expires. ' +
      'Free. The number is gone after this — it may be picked up by another wallet. Use when you ' +
      "no longer need a test number and want it out of your ListPhoneNumbers result.",
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'E.164 format, e.g. +14155552671' },
      },
      required: ['phone_number'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.phone_number !== 'string') {
      return { output: 'phone_number (E.164) required', isError: true };
    }
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/numbers/release',
        { phoneNumber: input.phone_number },
        ctx,
        { tool: 'ReleasePhoneNumber', priceUsd: 0 },
      );
      return {
        output:
          `## Number released (free)\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Release failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const phoneLookupCapability: CapabilityHandler = {
  spec: {
    name: 'PhoneLookup',
    description:
      'Look up carrier and line type information for ANY phone number (does not need to be ' +
      'BlockRun-provisioned). Returns carrier name, line type (mobile/landline/voip), country, and ' +
      'portability info. Costs $0.01 per lookup. Use to validate a number before texting/calling or ' +
      'to figure out whether a contact number is a real mobile.',
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'E.164 format, e.g. +14155552671' },
      },
      required: ['phone_number'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.phone_number !== 'string') {
      return { output: 'phone_number (E.164) required', isError: true };
    }
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/lookup',
        { phoneNumber: input.phone_number },
        ctx,
        { tool: 'PhoneLookup', priceUsd: 0.01 },
      );
      return {
        output:
          `## Phone lookup (${chargedNote(0.01)})\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Lookup failed: ${(err as Error).message}`, isError: true };
    }
  },
};

export const phoneFraudCheckCapability: CapabilityHandler = {
  spec: {
    name: 'PhoneFraudCheck',
    description:
      'Run a fraud / risk assessment on a phone number — checks SIM swap signals, call forwarding ' +
      'status, and known-spam reputation. Returns a risk score and signal breakdown. Costs $0.05 ' +
      'USDC. Use before sending OTPs or trusting a phone for account recovery.',
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'E.164 format, e.g. +14155552671' },
      },
      required: ['phone_number'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.phone_number !== 'string') {
      return { output: 'phone_number (E.164) required', isError: true };
    }
    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/phone/lookup/fraud',
        { phoneNumber: input.phone_number },
        ctx,
        { tool: 'PhoneFraudCheck', priceUsd: 0.05 },
      );
      return {
        output:
          `## Fraud check (${chargedNote(0.05)})\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Fraud check failed: ${(err as Error).message}`, isError: true };
    }
  },
};
