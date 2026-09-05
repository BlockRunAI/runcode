/**
 * RealFace — enroll a real person's face as a reusable video avatar.
 *
 * Wraps BlockRun's /v1/realface/* flow so the agent never hand-rolls paths or
 * x402. Enrollment is a three-step, human-in-the-loop flow because the upstream
 * provider (Token360 / BytePlus) requires a live liveness check on a phone:
 *
 *   1. action="init" (FREE)   → creates a REAL_FACE group, returns an `h5_link`.
 *                               Show it to the user as a QR / URL. They scan it
 *                               on their phone and do a ~1-minute liveness check
 *                               (nod + blink). The link expires in 120s; call
 *                               init again with the same group_id to refresh.
 *   2. action="status" (FREE) → poll the group until status === "active" (the
 *                               person finished the phone liveness). Bounded
 *                               poll (~24s) so a quick scan resolves in one call.
 *   3. action="enroll" ($0.01)→ uploads a face photo (public https URL), waits
 *                               for the biometric match, returns the `ta_xxx`
 *                               asset id. Pre-flights group-active (425 if not);
 *                               no charge if the upload/match fails.
 *   action="list" (FREE)      → lists the wallet's enrolled RealFace assets.
 *
 * Use the returned `ta_xxx` as `real_face_asset_id` on a VideoGen call with a
 * Seedance 2.0 model for cross-frame character consistency.
 *
 * x402 signing mirrors src/tools/videogen.ts / blockrun.ts (kept as copy-paste
 * per the same rationale documented there — a shared module is out of scope).
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
import { chargeFromResponse, requestIdFromResponse, resolveCharge } from '../payments/price-catalog.js';
import { gatewayBase, gatewayHeaders } from '../payments/auth-mode.js';
import { recordUsage } from '../stats/tracker.js';
import { logger } from '../logger.js';

const REQUEST_TIMEOUT_MS = 60_000;
// status poll budget — a phone liveness check takes ~1 min, but the upstream
// flip to `active` can lag the user saying "done" by a few seconds. Poll a
// short window so a just-finished scan resolves in one call without hanging
// the agent loop; if still pending, return and let the agent re-check.
const STATUS_POLL_ATTEMPTS = 6;
const STATUS_POLL_INTERVAL_MS = 4_000;

const GROUP_ID_RE = /^legacy_rf_\d+$/;

interface SignedPayment {
  headers: Record<string, string>;
  amountUsd: number;
}

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
): Promise<SignedPayment | null> {
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
    logger.warn(`[franklin] RealFace payment error: ${(err as Error).message}`);
    return null;
  }
}

function walletAddress(chain: 'base' | 'solana'): Promise<string> {
  if (chain === 'solana') return getOrCreateSolanaWallet().then((w) => w.address);
  return Promise.resolve(getOrCreateWallet().address);
}

async function timedFetch(
  url: string,
  init: RequestInit,
  ctx: ExecutionScope,
): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

const fence = (raw: string) => `\n\n\`\`\`json\n${raw}\n\`\`\``;

async function actionInit(base: string, input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { output: 'RealFace init needs a `name` (the real person\'s display name, 1–64 chars).', isError: true };
  const groupId = typeof input.group_id === 'string' ? input.group_id.trim() : undefined;
  if (groupId && !GROUP_ID_RE.test(groupId)) {
    return { output: `RealFace init: group_id must look like "legacy_rf_<digits>". Got: ${groupId}`, isError: true };
  }
  const body = JSON.stringify(groupId ? { name, groupId } : { name });
  const res = await timedFetch(`${base}/v1/realface/init`, {
    method: 'POST',
    headers: { ...gatewayHeaders(), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body,
  }, ctx);
  const raw = await res.text().catch(() => '');
  if (!res.ok) return { output: `RealFace init failed (status ${res.status}).\n${raw.slice(0, 600)}`, isError: true };
  return {
    output:
      'RealFace group created — FREE. Show the `h5_link` to the user as a QR code or tappable URL. ' +
      'They scan it on their phone and complete a ~1-minute liveness check (nod + blink). The link ' +
      'expires in ~120s — re-run action="init" with the same `group_id` to refresh. Then poll ' +
      'action="status" with the `group_id` until status="active", and finish with action="enroll".' +
      fence(raw),
  };
}

async function actionStatus(base: string, input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const groupId = typeof input.group_id === 'string' ? input.group_id.trim() : '';
  if (!GROUP_ID_RE.test(groupId)) {
    return { output: 'RealFace status needs a valid `group_id` (format "legacy_rf_<digits>") from action="init".', isError: true };
  }
  let raw = '';
  let lastStatus = '';
  for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
    if (ctx.abortSignal.aborted) break;
    const res = await timedFetch(`${base}/v1/realface/status?groupId=${encodeURIComponent(groupId)}`, {
      method: 'GET',
      headers: { ...gatewayHeaders(), Accept: 'application/json', 'User-Agent': USER_AGENT },
    }, ctx);
    raw = await res.text().catch(() => '');
    if (!res.ok) return { output: `RealFace status failed (status ${res.status}).\n${raw.slice(0, 600)}`, isError: true };
    try { lastStatus = String((JSON.parse(raw) as Record<string, unknown>).status ?? ''); } catch { /* keep raw */ }
    if (lastStatus === 'active') {
      return { output: `RealFace group is ACTIVE — the person finished the phone liveness check. Proceed with action="enroll".${fence(raw)}` };
    }
    if (attempt < STATUS_POLL_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  return {
    output:
      `RealFace group not yet active (status="${lastStatus || 'unknown'}"). The person hasn't finished the phone ` +
      `liveness check, or the upstream is still processing. Ask them to scan the QR (action="init" to refresh an ` +
      `expired link), then call action="status" again.${fence(raw)}`,
  };
}

async function actionEnroll(
  base: string,
  chain: 'base' | 'solana',
  input: Record<string, unknown>,
  ctx: ExecutionScope,
): Promise<CapabilityResult> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const imageUrl = typeof input.image_url === 'string' ? input.image_url.trim() : '';
  const groupId = typeof input.group_id === 'string' ? input.group_id.trim() : '';
  if (!name) return { output: 'RealFace enroll needs `name`.', isError: true };
  if (!GROUP_ID_RE.test(groupId)) return { output: 'RealFace enroll needs a valid `group_id` (from action="init").', isError: true };
  if (!/^https?:\/\//.test(imageUrl)) {
    return { output: 'RealFace enroll needs `image_url` as a public http(s) URL to the face photo (JPG/PNG/WEBP, ≤10 MB). The gateway fetches it server-side — local paths and data: URIs are not accepted.', isError: true };
  }

  const url = `${base}/v1/realface/enroll`;
  const body = JSON.stringify({ name, image_url: imageUrl, group_id: groupId });
  const headers: Record<string, string> = { ...gatewayHeaders(), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT };
  const start = Date.now();

  let res = await timedFetch(url, { method: 'POST', headers, body }, ctx);
  let paidUsd = 0;
  if (res.status === 402) {
    const signed = await signPayment(res, chain, url, `RealFace enrollment — "${name.slice(0, 32)}"`);
    if (!signed) return { output: 'RealFace enroll: payment signing failed. Check wallet balance with `franklin balance`.', isError: true };
    paidUsd = signed.amountUsd;
    res = await timedFetch(url, { method: 'POST', headers: { ...headers, ...signed.headers }, body }, ctx);
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) paidUsd = 0;
  // 0 whenever no 402 was settled, which is every call in API-key mode.
  const charge = res.ok
    ? resolveCharge({ apiPath: url, chargedUsd: chargeFromResponse(res), settledUsd: paidUsd })
    : { usd: 0, estimated: false };
  try { recordUsage('RealFace:enroll', 0, 0, charge.usd, Date.now() - start, false, charge.estimated, requestIdFromResponse(res)); } catch { /* best-effort */ }

  if (res.status === 425) {
    return { output: `RealFace enroll: the group isn't active yet — the person must finish the phone liveness check first. No payment taken. Poll action="status" until active, then retry.\n${raw.slice(0, 600)}`, isError: true };
  }
  if (res.status === 422) {
    return { output: `RealFace enroll: the uploaded photo didn't match the live face captured on the phone. No payment taken. Use a clearer front-facing photo of the same person and retry.\n${raw.slice(0, 600)}`, isError: true };
  }
  if (!res.ok) {
    return { output: `RealFace enroll failed (status ${res.status}). No charge if 4xx pre-payment.\n${raw.slice(0, 600)}`, isError: true };
  }
  return {
    output:
      `RealFace enrolled → $${charge.usd.toFixed(4)} · ${Date.now() - start}ms. ` +
      `Use the returned \`asset_id\` (ta_xxx) as \`real_face_asset_id\` on a VideoGen call with ` +
      `bytedance/seedance-2.0 or -fast for a real-person clip.${fence(raw)}`,
  };
}

async function actionList(base: string, chain: 'base' | 'solana', ctx: ExecutionScope): Promise<CapabilityResult> {
  const addr = await walletAddress(chain);
  const res = await timedFetch(`${base}/v1/wallet/${addr}/realfaces`, {
    method: 'GET',
    headers: { ...gatewayHeaders(), Accept: 'application/json', 'User-Agent': USER_AGENT },
  }, ctx);
  const raw = await res.text().catch(() => '');
  if (!res.ok) return { output: `RealFace list failed (status ${res.status}).\n${raw.slice(0, 600)}`, isError: true };
  return { output: `RealFace assets for ${addr}:${fence(raw)}` };
}

async function execute(input: Record<string, unknown>, ctx: ExecutionScope): Promise<CapabilityResult> {
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  const chain = loadChain();
  const base = gatewayBase(); // wallet host ends in /api; the key host does not
  switch (action) {
    case 'init': return actionInit(base, input, ctx);
    case 'status': return actionStatus(base, input, ctx);
    case 'enroll': return actionEnroll(base, chain, input, ctx);
    case 'list': return actionList(base, chain, ctx);
    default:
      return { output: `RealFace: unknown action "${action}". Valid: init, status, enroll, list.`, isError: true };
  }
}

export const realFaceCapability: CapabilityHandler = {
  spec: {
    name: 'RealFace',
    description:
      'Enroll a real person\'s face as a reusable video avatar (ta_xxx asset), then use it in VideoGen ' +
      'for cross-frame character consistency on Seedance 2.0. Human-in-the-loop, four actions:\n' +
      '• action="init" (FREE) — create a group, get an `h5_link`; show it to the user as a QR. They scan it ' +
      'on their phone and do a ~1-minute liveness check (nod + blink). Link expires in 120s — re-init with the ' +
      'same `group_id` to refresh.\n' +
      '• action="status" (FREE) — poll the `group_id` until status="active" (person finished the phone check).\n' +
      '• action="enroll" ($0.01 USDC) — upload the face photo (`image_url`, public https) + `group_id`; returns ' +
      'the `ta_xxx` asset id. No charge if the group isn\'t active (425) or the face doesn\'t match (422).\n' +
      '• action="list" (FREE) — list this wallet\'s enrolled RealFace assets.\n' +
      'Typical sequence: init → (user scans) → status → enroll → VideoGen with real_face_asset_id.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'status', 'enroll', 'list'],
          description: 'Which step of the RealFace flow to run.',
        },
        name: { type: 'string', description: 'Display name of the real person (1–64 chars). Required for init and enroll.' },
        group_id: { type: 'string', description: 'The group id ("legacy_rf_<digits>") returned by action="init". Required for status and enroll; optional on init to refresh an expired h5_link.' },
        image_url: { type: 'string', description: 'Public http(s) URL to the face photo (JPG/PNG/WEBP, ≤10 MB). Required for enroll. Fetched server-side — local paths / data: URIs are rejected.' },
      },
      required: ['action'],
    },
  },
  concurrent: false,
  execute,
};
