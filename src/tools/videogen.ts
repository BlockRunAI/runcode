/**
 * Video Generation capability — generate short MP4 videos via the BlockRun
 * /v1/videos/generations endpoint. Uses x402 payment (Base or Solana).
 *
 * Default model `xai/grok-imagine-video` returns an 8-second clip for ~$0.42
 * (480p at $0.05/s; the gateway added an official 720p tier at $0.07/s on
 * 2026-08-12). Seedance (bytedance/seedance-2.0-mini through -2.5) runs
 * longer — up to a few minutes for a 10s clip.
 *
 * Flow (async since blockrun@654cd35):
 *   1. POST /v1/videos/generations with signed x-payment header. The server
 *      verifies payment (does NOT settle), submits the upstream job, and
 *      returns 202 { id, poll_url, status: "queued" }.
 *   2. GET the poll_url with the SAME x-payment header every ~5s until
 *      status=completed. On the first completed poll the server backs up
 *      the MP4 to GCS, settles payment, and returns the video URL.
 *   3. Download the MP4 and write it locally.
 *
 * If the upstream job fails, the server returns status=failed and no USDC
 * is ever transferred. If the client never polls, no charge either.
 */

import fs from 'node:fs';
import path from 'node:path';
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
import type { ContentLibrary } from '../content/library.js';
import { resolveReferenceImage } from './imagegen.js';
import { isWalletKeyPath } from './sensitive-paths.js';
import { recordUsage } from '../stats/tracker.js';
import { findModel, estimateCostUsd, GATEWAY_MARGIN, type GatewayModel } from '../gateway-models.js';
import { noChargeNote, cancelHint } from '../payments/billing-copy.js';

interface VideoGenInput {
  prompt: string;
  output_path?: string;
  model?: string;
  image_url?: string;
  duration_seconds?: number;
  contentId?: string;
  aspect_ratio?: string;
  real_face_asset_id?: string;
}

// BytePlus RealFace asset IDs from the RealFace tool (after H5 liveness +
// enrollment). Format: `ta_` + alphanumeric.
const REAL_FACE_ASSET_ID_REGEX = /^ta_[A-Za-z0-9]+$/;
const REAL_FACE_MODELS = new Set([
  'bytedance/seedance-2.0',
  'bytedance/seedance-2.0-fast',
]);

export interface VideoGenDeps {
  library?: ContentLibrary;
  onContentChange?: () => void | Promise<void>;
}

const DEFAULT_MODEL = 'xai/grok-imagine-video';
const DEFAULT_DURATION = 8;
const PRICE_PER_SECOND_USD = 0.05;
// POST submit is fast (~3-20s). Generation is async upstream (60-300s for
// Seedance, 20-90s for Grok). We poll until completed, then download. The
// server signs authorizations for 600s — keep the overall budget below that.
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_WAIT_MS = 480_000; // 8 min — covers Seedance worst case
const DOWNLOAD_TIMEOUT_MS = 60_000;

function estimateVideoCostUsd(durationSeconds = DEFAULT_DURATION): number {
  return Math.max(1, durationSeconds) * PRICE_PER_SECOND_USD;
}

/**
 * Resolve the per-clip USD cost used for the spend confirm, budget check, usage
 * stats, AND the content-budget asset record — one value so they can never
 * disagree. The flat $0.05/s estimate is the fallback for an unknown model, but
 * a catalog-priced per-second model (e.g. Seedance at $0.15/s) costs far more,
 * so take the HIGHER of the catalog price and the (margin-adjusted) flat
 * estimate. Without this the budget check + asset record undercount the cap ~3x
 * for Seedance. Mirrors ImageGen's resolveImageUnitCost. Exported for tests.
 */
export function resolveVideoUnitCost(catalogModel: GatewayModel | null, durationSeconds: number): number {
  const catalogUsd = catalogModel ? estimateCostUsd(catalogModel, { duration_seconds: durationSeconds }) : 0;
  const flatUsd = +(estimateVideoCostUsd(durationSeconds) * GATEWAY_MARGIN).toFixed(6);
  return Math.max(catalogUsd, flatUsd);
}

function buildExecute(deps: VideoGenDeps) {
  return async function execute(
    input: Record<string, unknown>,
    ctx: ExecutionScope,
  ): Promise<CapabilityResult> {
    const rawInput = input as unknown as VideoGenInput;
    const { output_path, model, image_url, duration_seconds, contentId, aspect_ratio, real_face_asset_id } = rawInput;

    if (!rawInput.prompt) return { output: 'Error: prompt is required', isError: true };

    // RealFace asset client-side validations (the gateway 400s on the same
    // conditions but a local check is friendlier — and the rejected request
    // doesn't burn an x402 round-trip).
    if (real_face_asset_id !== undefined) {
      if (typeof real_face_asset_id !== 'string' || !REAL_FACE_ASSET_ID_REGEX.test(real_face_asset_id)) {
        return {
          output: `Error: real_face_asset_id must match "ta_<alphanumeric>" (e.g. ta_abc123). Enroll one with the RealFace tool. Got: ${JSON.stringify(real_face_asset_id)}`,
          isError: true,
        };
      }
      const chosenModel = model || DEFAULT_MODEL;
      if (!REAL_FACE_MODELS.has(chosenModel)) {
        return {
          output: `Error: real_face_asset_id is only supported on Seedance 2.0 variants (${[...REAL_FACE_MODELS].join(', ')}). Current model: ${chosenModel}.`,
          isError: true,
        };
      }
      if (image_url) {
        return {
          output: 'Error: real_face_asset_id and image_url both seed the first frame — pick one. Drop image_url to use RealFace, or drop real_face_asset_id to use the image.',
          isError: true,
        };
      }
    }

    // Resolve image_url before sending. The gateway requires a URL (http(s)
    // or data: URI), but agents naturally pass a local file path —
    // verified 2026-05-04 in a live session: agent passed
    // `/Users/.../keyframe.png` and the gateway returned
    // `400 Invalid request body: invalid_format url path: image_url`.
    // ImageGen already had `resolveReferenceImage` for the same problem;
    // sharing the helper keeps the contract consistent across both tools
    // (local path → base64 data URI; http(s) URL → fetched + inlined;
    // data: URI → passes through). On any resolution failure, surface
    // the message instead of letting the gateway 400 bubble back.
    let resolvedImageUrl: string | undefined;
    if (image_url) {
      try {
        resolvedImageUrl = await resolveReferenceImage(image_url, ctx.workingDir);
      } catch (err) {
        return {
          output: `Could not resolve image_url ${JSON.stringify(image_url)}: ${(err as Error).message}`,
          isError: true,
        };
      }
    }

    // Pure tool: use exactly the model + prompt + duration the caller gave.
    // No LLM prompt-rewriting or model "routing" — the UI / agent decides those
    // upstream. (This removes a second, flaky free-model call that used to time
    // out and made "video generation" appear broken.)
    const prompt = rawInput.prompt;
    const videoModel = model || DEFAULT_MODEL;
    const duration = duration_seconds ?? DEFAULT_DURATION;
    const chosenPrompt = prompt;

    // Video bills per second — confirm the cost before spending. This is pure
    // price math (no LLM). Interactive callers (CLI / agent) get a prompt via
    // onAskUser; direct callers (e.g. the desktop media path) pass no onAskUser
    // and generate straight away — the explicit "generate" action is consent.
    // Resolve the per-clip cost ONCE — reused below by the confirm quote, the
    // budget pre-check, usage stats, and the asset record so none can disagree
    // or undercount a catalog-priced model. Best-effort catalog lookup: a cold
    // fetch failure degrades to the flat estimate, never aborts a generation.
    let videoCatalogModel: GatewayModel | null = null;
    try {
      videoCatalogModel = await findModel(videoModel);
    } catch { /* catalog unreachable — resolveVideoUnitCost falls back to the estimate */ }

    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!autoApprove && ctx.onAskUser) {
      // Model-aware estimate so the quoted price matches the model we name in
      // the prompt (flat per-second fallback only when the model is unknown).
      const est = resolveVideoUnitCost(videoCatalogModel, duration);
      const answer = await ctx.onAskUser(
        `Generate a ${duration}s video with ${videoModel} for ~$${est.toFixed(2)}? ${cancelHint()}`,
        ['Generate', 'Cancel'],
      );
      if (answer !== 'Generate') {
        return { output: `## Video generation cancelled\n\n${noChargeNote()}` };
      }
    }

    const estCost = resolveVideoUnitCost(videoCatalogModel, duration);

    if (contentId && deps.library) {
      const content = deps.library.get(contentId);
      if (!content) {
        return { output: `Content ${contentId} not found. ${noChargeNote()}` };
      }
      if (content.spentUsd + estCost > content.budgetUsd + 1e-9) {
        return {
          output:
            `## Video generation skipped\n` +
            `- Would exceed budget: spent $${content.spentUsd.toFixed(2)} + estimated ` +
            `$${estCost.toFixed(2)} > cap $${content.budgetUsd.toFixed(2)}\n\n` +
            noChargeNote(),
        };
      }
    }

    const chain = loadChain();
    const apiUrl = gatewayBase();
    const endpoint = `${apiUrl}/v1/videos/generations`;

    const outPath = output_path
      ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
      : path.resolve(ctx.workingDir, `generated-${Date.now()}.mp4`);
    // Don't let a caller-controlled output_path overwrite the wallet key store.
    if (isWalletKeyPath(outPath)) {
      return { output: `Error: refusing to write to the wallet key store: ${outPath}`, isError: true };
    }

    const body = JSON.stringify({
      model: videoModel,
      prompt: chosenPrompt,
      ...(resolvedImageUrl ? { image_url: resolvedImageUrl } : {}),
      ...(duration_seconds ? { duration_seconds } : {}),
      // aspect_ratio passes through to the gateway. Models that support it
      // (newer Seedance / grok variants) honor it; models that ignore it
      // produce their default size. If the gateway rejects an unknown
      // value, the 400 body surfaces via 3.15.45 diagnostic so the agent
      // can drop the param and retry.
      ...(aspect_ratio ? { aspect_ratio } : {}),
      // RealFace (BytePlus, Seedance 2.0 only) — seeds the first frame from
      // a real-person asset for cross-frame character consistency. Client
      // already validated the ID + model gate above; just pass through.
      ...(real_face_asset_id ? { real_face_asset_id } : {}),
    });

    const headers: Record<string, string> = {
      ...gatewayHeaders(),
      'Content-Type': 'application/json',
      'User-Agent': `franklin/${VERSION}`,
    };

    // Wall-clock start of the paid call (submit + poll + download). Fed
    // to recordUsage below so franklin-stats.json populates avgLatencyMs
    // for video models. Same fix as 3.15.61 (agent loop) — five
    // recordUsage callsites in this codebase, three of them were
    // hardcoding 0.
    const callStartedAt = Date.now();

    const onAbort = (ctrl: AbortController) => () => ctrl.abort();

    // Phase 1: submit the job. First POST triggers a 402; we sign and retry.
    // The signed paymentHeaders must be reused on every GET poll — the server
    // uses the authorization to verify identity on each poll and settles on
    // the first completed response.
    const submitCtrl = new AbortController();
    const submitTimeout = setTimeout(() => submitCtrl.abort(), SUBMIT_TIMEOUT_MS);
    const submitAbort = onAbort(submitCtrl);
    ctx.abortSignal.addEventListener('abort', submitAbort, { once: true });

    let paymentHeaders: Record<string, string> | null = null;
    let submitResult: { id?: string; poll_url?: string; error?: unknown; message?: unknown };

    try {
      let response = await fetch(endpoint, {
        method: 'POST',
        signal: submitCtrl.signal,
        headers,
        body,
      });

      if (response.status === 402) {
        paymentHeaders = await signPayment(response, chain, endpoint);
        if (!paymentHeaders) {
          return { output: 'Payment failed. Check wallet balance with: franklin balance', isError: true };
        }
        response = await fetch(endpoint, {
          method: 'POST',
          signal: submitCtrl.signal,
          headers: { ...headers, ...paymentHeaders },
          body,
        });
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return {
          output: `Video submit failed (${response.status}): ${errText.slice(0, 300)}`,
          isError: true,
        };
      }

      submitResult = await response.json();
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('abort')) {
        return {
          output: `Video submit timed out or was aborted after ${Math.round(SUBMIT_TIMEOUT_MS / 1000)}s.`,
          isError: true,
        };
      }
      return { output: `Error submitting video job: ${msg}`, isError: true };
    } finally {
      clearTimeout(submitTimeout);
      ctx.abortSignal.removeEventListener('abort', submitAbort);
    }

    if (!submitResult.poll_url || !paymentHeaders) {
      // Surface any diagnostic the body contained — same rationale as
      // imagegen.ts: "missing field" tells the agent nothing about
      // whether it was moderation, quota, or upstream model failure.
      const bits: string[] = [];
      if (!paymentHeaders) bits.push('payment headers missing');
      if (submitResult?.error !== undefined) bits.push(`error=${JSON.stringify(submitResult.error).slice(0, 240)}`);
      if (submitResult?.message !== undefined) bits.push(`message=${String(submitResult.message).slice(0, 240)}`);
      const detail = bits.length > 0 ? ` — ${bits.join('; ')}` : '';
      return { output: `API did not return a poll_url for the video job${detail}`, isError: true };
    }

    // Phase 2: poll GET /v1/videos/generations/{id} with the SAME signed
    // x-payment header until the job completes. Server settles on the first
    // completed poll and returns the backed-up video URL.
    const origin = new URL(apiUrl).origin;
    const pollEndpoint = submitResult.poll_url.startsWith('http')
      ? submitResult.poll_url
      : `${origin}${submitResult.poll_url}`;

    const outcome = await pollUntilReady(pollEndpoint, { ...headers, ...paymentHeaders }, ctx.abortSignal);
    if (outcome.kind === 'timed_out') {
      return {
        output:
          `Video generation did not complete within ${Math.round(POLL_MAX_WAIT_MS / 1000)}s. ` +
          `No USDC was charged (settlement only fires on completion).`,
        isError: true,
      };
    }
    if (outcome.kind === 'failed') {
      return {
        output: `Video generation failed upstream: ${outcome.error ?? 'unknown error'}. No USDC was charged.`,
        isError: true,
      };
    }
    const videoData = outcome.data;
    const videoUrl = videoData.url;
    if (!videoUrl) {
      // Same diagnostic pattern as the submit-side path above.
      const d = videoData as Record<string, unknown>;
      const bits: string[] = [];
      if (d.error !== undefined) bits.push(`error=${JSON.stringify(d.error).slice(0, 240)}`);
      if (d.message !== undefined) bits.push(`message=${String(d.message).slice(0, 240)}`);
      if (d.status !== undefined) bits.push(`status=${String(d.status).slice(0, 80)}`);
      const detail = bits.length > 0 ? ` — ${bits.join('; ')}` : '';
      return { output: `No video URL returned from API${detail}`, isError: true };
    }

    try {
      // Download the MP4
      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), DOWNLOAD_TIMEOUT_MS);
      const dlAbort = onAbort(dlCtrl);
      ctx.abortSignal.addEventListener('abort', dlAbort, { once: true });
      let vidResp: Response;
      try {
        vidResp = await fetch(videoUrl, { signal: dlCtrl.signal });
      } finally {
        clearTimeout(dlTimeout);
        ctx.abortSignal.removeEventListener('abort', dlAbort);
      }
      if (!vidResp.ok) {
        return { output: `Video fetched URL but download failed (${vidResp.status}): ${videoUrl}`, isError: true };
      }
      const buffer = Buffer.from(await vidResp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buffer);

      const fileSize = fs.statSync(outPath).size;
      const sizeMB = (fileSize / 1_048_576).toFixed(1);
      const dur = videoData.duration_seconds ?? duration;
      // Single authoritative cost for the actual generated duration — same
      // value for stats and the content-budget record (no undercount).
      const recCostUsd = resolveVideoUnitCost(videoCatalogModel, dur);

      // Stats: record this generation so it shows up in `franklin insights`
      // alongside chat spend. Before this, media generations bypassed
      // recordUsage entirely, so the insights panel under-reported total
      // spend and never surfaced video models in its "top models" list.
      const latencyMs = Date.now() - callStartedAt;
      try { recordUsage(videoModel, 0, 0, recCostUsd, latencyMs); } catch { /* ignore stats errors */ }

      let contentSummary = '';
      if (contentId && deps.library) {
        const rec = deps.library.addAsset(contentId, {
          kind: 'video',
          source: videoModel,
          costUsd: recCostUsd,
          data: outPath,
        });
        if (rec.ok) {
          if (deps.onContentChange) await deps.onContentChange();
          const c = deps.library.get(contentId);
          contentSummary =
            `\n\n## Content updated\n` +
            `- Attached to \`${contentId}\` at est. $${recCostUsd.toFixed(2)}\n` +
            (c
              ? `- Spent: $${c.spentUsd.toFixed(2)} / $${c.budgetUsd.toFixed(2)} cap ` +
                `(remaining $${(c.budgetUsd - c.spentUsd).toFixed(2)})`
              : '');
        } else {
          contentSummary =
            `\n\n## Content NOT updated\n` +
            `- ${rec.reason}\n` +
            `- The video was generated and saved locally; cost was NOT recorded ` +
            `against the content budget.`;
        }
      }

      return {
        output:
          `Video saved to ${outPath} (${sizeMB}MB, ${dur}s, ${videoModel})\n\n` +
          `Open with: open ${outPath}${contentSummary}`,
      };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('abort')) {
        return {
          output: `Video download timed out or was aborted after ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)}s.`,
          isError: true,
        };
      }
      return { output: `Error: ${msg}`, isError: true };
    }
  };
}

// ─── Polling ───────────────────────────────────────────────────────────────

interface VideoDataItem {
  url?: string;
  source_url?: string;
  duration_seconds?: number;
  request_id?: string;
}

interface VideoPollResponse {
  id?: string;
  status?: 'queued' | 'in_progress' | 'completed' | 'failed';
  data?: VideoDataItem[];
  error?: string;
  note?: string;
}

type PollOutcome =
  | { kind: 'completed'; data: VideoDataItem }
  | { kind: 'failed'; error?: string }
  | { kind: 'timed_out' };

/**
 * Poll the GET /v1/videos/generations/{id} endpoint until the job reaches a
 * terminal state. Reuses the caller's signed x-payment header verbatim on
 * every request — the server verifies the same authorization each poll and
 * settles on the first completed response.
 */
async function pollUntilReady(
  pollEndpoint: string,
  headers: Record<string, string>,
  userAbort: AbortSignal,
): Promise<PollOutcome> {
  const deadline = Date.now() + POLL_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (userAbort.aborted) throw new Error('aborted');

    const resp = await fetch(pollEndpoint, { method: 'GET', headers, signal: userAbort });

    // 202 = still queued/in_progress; 200 = completed or failed.
    if (resp.status === 202 || resp.status === 200) {
      const body = (await resp.json().catch(() => ({}))) as VideoPollResponse;
      if (body.status === 'completed' && body.data?.[0]?.url) {
        return { kind: 'completed', data: body.data[0] };
      }
      if (body.status === 'failed') {
        return { kind: 'failed', error: body.error };
      }
      // queued / in_progress — sleep and try again.
    } else if (resp.status === 429 || resp.status >= 500) {
      // Transient — back off briefly. Fall through to the sleep below.
    } else {
      const text = await resp.text().catch(() => '');
      throw new Error(`Poll failed (${resp.status}): ${text.slice(0, 300)}`);
    }

    await sleep(POLL_INTERVAL_MS, userAbort);
  }

  return { kind: 'timed_out' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Payment ───────────────────────────────────────────────────────────────

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
          resourceDescription: details.resource?.description || 'Franklin video generation',
          // Video poll can take up to 8 min; honor the server's advertised
          // value (blockrun sends 600s) and fall back to 600 not 300.
          maxTimeoutSeconds: details.maxTimeoutSeconds || 600,
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
        resourceDescription: details.resource?.description || 'Franklin video generation',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] Video payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) header = btoa(JSON.stringify(body));
    } catch { /* ignore */ }
  }
  return header;
}

// ─── Export ────────────────────────────────────────────────────────────────

export function createVideoGenCapability(deps: VideoGenDeps = {}): CapabilityHandler {
  return {
    spec: {
      name: 'VideoGen',
      description:
        "Generate a short MP4 video from a text prompt (optional seed image). " +
        "Calls BlockRun's /v1/videos/generations. Billed per generation — default model " +
        "xai/grok-imagine-video bills $0.05/s (8s default ≈ $0.42). Generation " +
        "takes ~20–60s. ALWAYS confirm with the user before calling — videos " +
        "are expensive and slow. Pass contentId to attach to a Content piece " +
        "(budget is checked before paying; asset is recorded on success). " +
        "PLATFORM TARGETING: when the user says they'll post to X / Twitter, " +
        "set aspect_ratio: '16:9' AND plan a follow-up `ffmpeg -vf scale=1280:720` " +
        "step — X rejects videos under 720p with 'aspect ratio too small'. " +
        "TikTok / Reels / Shorts: aspect_ratio '9:16'. Instagram Square: '1:1'. " +
        "MODERATION: bytedance/seedance-* refuses photorealistic human faces " +
        "(`InputImageSensitiveContentDetected.PrivacyInformation`); when the " +
        "seed image has a real-looking person, use xai/grok-imagine-video " +
        "instead, or regenerate the keyframe in a more stylized style first.",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the video to generate' },
          output_path: { type: 'string', description: 'Where to save the MP4. Default: generated-<timestamp>.mp4 in working directory' },
          model: {
            type: 'string',
            description:
              'Video model. Default: xai/grok-imagine-video ($0.05/s). Known-valid models on the BlockRun gateway as of 2026-08: ' +
              'xai/grok-imagine-video, xai/grok-imagine-video-1.5 ($0.08/s), bytedance/seedance-1.5-pro ($0.070/s), bytedance/seedance-2.0-mini ($0.0797/s), ' +
              'bytedance/seedance-2.0-fast ($0.165/s), bytedance/seedance-2.0 ($0.227/s), bytedance/seedance-2.5 ($0.315/s), azure/sora-2 ($0.10/s). ' +
              'Pick from this list; the gateway rejects unknown names with HTTP 400 (no money charged on rejection). ' +
              'Speak "Seedance" → bytedance/seedance-2.5 (newest flagship); "Seedance Pro" → bytedance/seedance-2.0; ' +
              '"Grok video" → xai/grok-imagine-video-1.5 (newer Grok clip model, $0.08/s vs $0.05/s); ' +
              '"Seedance fast" → bytedance/seedance-2.0-fast; "Seedance mini" → bytedance/seedance-2.0-mini (cheapest).',
          },
          image_url: { type: 'string', description: 'Optional seed image (image-to-video). Accepts http(s) URL, data: URI, or local file path — local paths get inlined as base64 data URIs automatically.' },
          duration_seconds: { type: 'number', description: 'Duration billed for. Default depends on model (8s for grok-imagine-video).' },
          aspect_ratio: {
            type: 'string',
            description:
              'Optional aspect ratio hint passed to the model. Common values: ' +
              '"16:9" (landscape — X/Twitter, YouTube, TikTok-landscape), ' +
              '"9:16" (vertical — TikTok, Reels, Shorts), ' +
              '"1:1" (square — Instagram feed). Models that don\'t support the ' +
              'param ignore it; if the gateway 400s on an unknown value, the ' +
              'error body surfaces — drop the param and retry.',
          },
          contentId: { type: 'string', description: 'Optional Content id to attach and budget against.' },
          real_face_asset_id: {
            type: 'string',
            description:
              'Optional BytePlus RealFace asset id (format `ta_<alphanumeric>`) for cross-frame ' +
              'character consistency from a real person. Enroll one with the RealFace tool ' +
              '(init → phone liveness → enroll). Seedance 2.0 variants only (bytedance/seedance-2.0, ' +
              'bytedance/seedance-2.0-fast). Mutually exclusive with image_url — both seed the ' +
              'first frame; pick one.',
          },
        },
        required: ['prompt'],
      },
    },
    execute: buildExecute(deps),
    concurrent: false,
  };
}

export const videoGenCapability: CapabilityHandler = createVideoGenCapability();
