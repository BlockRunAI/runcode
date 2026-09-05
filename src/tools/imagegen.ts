/**
 * Image Generation capability — generate images via BlockRun API.
 * Uses x402 payment on Solana or Base.
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
import type { ContentLibrary } from '../content/library.js';
import { checkImageBudget, recordImageAsset } from '../content/record-image.js';
import { estimateImageCostUsd } from '../content/image-pricing.js';
import { recordUsage } from '../stats/tracker.js';
import { findModel, estimateCostUsd, GATEWAY_MARGIN, type GatewayModel } from '../gateway-models.js';
import { logger } from '../logger.js';
import { ssrfSafeFetch } from './ssrf.js';
import { isWalletKeyPath } from './sensitive-paths.js';
import { noChargeNote, cancelHint } from '../payments/billing-copy.js';

interface ImageGenInput {
  prompt: string;
  output_path?: string;
  size?: string;
  model?: string;
  /**
   * Optional reference image for image-to-image generation (style transfer,
   * character consistency, edits). When set, the call is routed to
   * /v1/images/image2image instead of /v1/images/generations and only
   * edit-capable models may be used (see EDIT_SUPPORTED_MODELS). Accepts:
   *   - http(s) URL — fetched and inlined client-side
   *   - data URI (data:image/...;base64,...)
   *   - local file path — read, base64-encoded, capped at ~4 MB
   */
  image_url?: string;
  /**
   * Optional list of reference images for multi-image fusion (e.g. a subject
   * photo + a brand logo). Each entry accepts the same forms as image_url.
   * Merged with image_url (if both are given). Per-provider cap: OpenAI 4,
   * Google 3. Cannot be combined with `mask`.
   */
  images?: string[];
  /**
   * Optional mask for inpainting: transparent pixels mark the editable region.
   * Same input forms as image_url. OpenAI edit models only; cannot be combined
   * with multiple source images.
   */
  mask?: string;
  /**
   * Number of images to generate (1–4). Default 1. Cost scales with n.
   */
  n?: number;
  /**
   * Optional Content id to attach this generation to. When provided:
   *   (1) Budget is checked BEFORE the paid generation — refusing up-front
   *       saves wasting USDC on a fill that couldn't be recorded.
   *   (2) On successful generation, each saved image is recorded as an asset
   *       on that content with the estimated USD cost.
   */
  contentId?: string;
}

/**
 * Models that accept a reference image via /v1/images/image2image. Mirrors the
 * gateway's EDIT_SUPPORTED_MODELS (src/app/api/v1/images/image2image/route.ts):
 * both OpenAI gpt-image-* and Google Nano Banana support image-to-image edits.
 */
export const EDIT_SUPPORTED_MODELS = new Set([
  'openai/gpt-image-1',
  'openai/gpt-image-2',
  'google/nano-banana',
  'google/nano-banana-pro',
]);

/**
 * Mask-based inpainting is OpenAI-only. Gemini (Nano Banana) does prompt-based
 * edits with no mask concept. Mirrors the gateway's MASK_SUPPORTED_MODELS.
 */
export const MASK_SUPPORTED_MODELS = new Set([
  'openai/gpt-image-1',
  'openai/gpt-image-2',
]);

/**
 * Per-provider multi-image (fusion) cap. Mirrors the gateway's
 * MAX_IMAGES_BY_PREFIX: OpenAI fuses up to 4 anchors, Gemini up to 3.
 */
const MAX_IMAGES_BY_PREFIX: Record<string, number> = {
  'openai/': 4,
  'google/': 3,
};

/**
 * Output-image count ceiling. The gateway has no hard max but price scales with
 * n, so cap client-side to keep a typo from draining the wallet.
 */
export const MAX_OUTPUT_IMAGES = 4;

/**
 * Valid sizes per known image model, mirroring the gateway's IMAGE_MODELS.sizes
 * (src/lib/models.ts). Used to fail cheaply before paying when a caller or the
 * media router picks a size the model rejects. Models absent from this table
 * (custom / future gateway models) skip validation and let the gateway decide.
 */
export const IMAGE_MODEL_SIZES: Record<string, string[]> = {
  'openai/gpt-image-1': ['1024x1024', '1536x1024', '1024x1536'],
  'openai/gpt-image-2': ['1024x1024', '1536x1024', '1024x1536'],
  'google/nano-banana': ['1024x1024'],
  'google/nano-banana-pro': ['1024x1024', '2048x2048', '4096x4096'],
};

export const REFERENCE_IMAGE_MAX_BYTES = 4_000_000;

/**
 * Resolve the per-image USD cost used for the budget check, spend confirm, and
 * asset record. Two sources, neither sufficient alone:
 *   - the live catalog price is authoritative for models the static table omits
 *     (closing the $0-budget bypass), but it is SIZE-BLIND — a single flat
 *     per_image figure that ignores the larger, pricier tiers;
 *   - the static table is SIZE-AWARE (e.g. gpt-image-1 is $0.02 at 1024x1024 but
 *     $0.04 at 1536x1024) but only covers a handful of models.
 * Take the HIGHER of the two so none of the three consumers ever undercounts the
 * real charge for a large, non-1024 size. The static figures are base prices with
 * NO gateway margin, whereas estimateCostUsd already applies GATEWAY_MARGIN — so
 * we margin-adjust the static operand before the Math.max, keeping both on the
 * realized-charge basis (otherwise the size-aware path would undercount by ~5%).
 * Exported for regression tests.
 */
export function resolveImageUnitCost(
  catalogModel: GatewayModel | null,
  model: string,
  size: string,
): number {
  const catalogUsd = catalogModel ? estimateCostUsd(catalogModel, { quantity: 1 }) : 0;
  const staticUsd = +(estimateImageCostUsd(model, size, 1) * GATEWAY_MARGIN).toFixed(6);
  return Math.max(catalogUsd, staticUsd);
}

/**
 * Normalize a reference image into a base64 data URI for the gateway. The
 * /v1/images/image2image endpoint validates `image` against /^data:image\//,
 * so http(s) URLs and local paths both have to be inlined client-side before
 * posting. Already-formed data URIs pass through.
 */
export async function resolveReferenceImage(input: string, workingDir: string): Promise<string> {
  if (input.startsWith('data:image/')) return input;

  if (/^https?:\/\//i.test(input)) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);
    try {
      // SSRF guard with per-redirect re-validation (a reference-image URL is
      // model/attacker-controllable, and a 302 to a loopback/metadata host
      // would otherwise slip a host-only check).
      const resp = await ssrfSafeFetch(input, {
        signal: ctrl.signal,
        allowPrivate: process.env.FRANKLIN_ALLOW_PRIVATE_FETCH === '1',
      });
      if (!resp.ok) {
        throw new Error(`Reference image fetch failed: ${resp.status} ${resp.statusText}`);
      }
      const contentType = (resp.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      if (!contentType.startsWith('image/')) {
        throw new Error(`Reference image URL returned non-image content-type: ${contentType || '(none)'}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
        throw new Error(
          `Reference image too large: ${(buf.byteLength / 1_000_000).toFixed(1)}MB > ${(REFERENCE_IMAGE_MAX_BYTES / 1_000_000).toFixed(1)}MB cap.`,
        );
      }
      return `data:${contentType};base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Treat as local file path.
  const resolved = path.isAbsolute(input) ? input : path.resolve(workingDir, input);
  const stat = fs.statSync(resolved);
  if (stat.size > REFERENCE_IMAGE_MAX_BYTES) {
    throw new Error(
      `Reference image too large: ${(stat.size / 1_000_000).toFixed(1)}MB > ${(REFERENCE_IMAGE_MAX_BYTES / 1_000_000).toFixed(1)}MB cap. Resize or crop first.`,
    );
  }
  const ext = path.extname(resolved).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mime = mimeMap[ext];
  if (!mime) {
    throw new Error(`Unsupported reference image extension ${ext || '(none)'}. Use .png/.jpg/.jpeg/.gif/.webp.`);
  }
  const bytes = fs.readFileSync(resolved);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export interface ImageGenDeps {
  /** Optional Content library for auto-recording generations into a piece. */
  library?: ContentLibrary;
  /** Invoked after successful content-linked generation; lets callers persist. */
  onContentChange?: () => void | Promise<void>;
}

function buildExecute(deps: ImageGenDeps) {
  return async function execute(
    input: Record<string, unknown>,
    ctx: ExecutionScope,
  ): Promise<CapabilityResult> {
    const rawInput = input as unknown as ImageGenInput;
    const { output_path, size, model, contentId, image_url, mask } = rawInput;

    if (!rawInput.prompt) {
      return { output: 'Error: prompt is required', isError: true };
    }

    // Collect reference images: image_url (single, back-compat) + images[]
    // (fusion), in that order. Edit mode is active whenever at least one
    // reference image is present — the call then routes to image2image.
    const referenceInputs: string[] = [
      ...(image_url ? [image_url] : []),
      ...(Array.isArray(rawInput.images) ? rawInput.images.filter(Boolean) : []),
    ];
    const editMode = referenceInputs.length > 0;

    // Output count: 1–4. Reject out-of-range up front so a typo can't blow the
    // wallet (price scales with n) or get silently clamped.
    const n = rawInput.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > MAX_OUTPUT_IMAGES) {
      return {
        output: `Error: n must be an integer between 1 and ${MAX_OUTPUT_IMAGES} (got ${rawInput.n}).`,
        isError: true,
      };
    }

    // A mask only makes sense as an inpainting directive on a source image.
    if (mask && !editMode) {
      return {
        output: 'Error: mask requires a source image. Pass image_url (or images) alongside mask.',
        isError: true,
      };
    }

    // Pure tool: use exactly the prompt the caller gave — no LLM rewriting.
    const prompt = rawInput.prompt;

    // Reference-image mode forces an edit-capable model. If the caller named
    // an unsupported one, fail loudly so we don't silently downgrade their
    // request to text-only generation.
    if (editMode && model && !EDIT_SUPPORTED_MODELS.has(model)) {
      return {
        output:
          `Error: model ${model} does not support reference images. ` +
          `Use one of: ${[...EDIT_SUPPORTED_MODELS].join(', ')}.`,
        isError: true,
      };
    }

    const imageModel = model || (editMode ? 'openai/gpt-image-2' : 'openai/gpt-image-1');
    let imageSize = size || '1024x1024';
    const chosenPrompt = prompt;

    // ── Edit-mode constraint checks (mirror the gateway, fail before paying) ──
    if (editMode) {
      // Mask inpainting is OpenAI-only.
      if (mask && !MASK_SUPPORTED_MODELS.has(imageModel)) {
        return {
          output:
            `Error: model ${imageModel} does not support mask-based editing. ` +
            `Mask inpainting is available on: ${[...MASK_SUPPORTED_MODELS].join(', ')}. ` +
            `Omit mask to edit with ${imageModel}.`,
          isError: true,
        };
      }
      // A mask targets a single region — it has no meaning across multiple
      // source images.
      if (mask && referenceInputs.length > 1) {
        return {
          output:
            'Error: mask cannot be combined with multiple source images. ' +
            'Send a single image with a mask, or multiple images without a mask.',
          isError: true,
        };
      }
      // Per-provider fusion cap.
      const maxImages = MAX_IMAGES_BY_PREFIX[`${imageModel.split('/')[0]}/`] ?? 1;
      if (referenceInputs.length > maxImages) {
        return {
          output:
            `Error: model ${imageModel} accepts at most ${maxImages} source ` +
            `image${maxImages > 1 ? 's' : ''} per edit (got ${referenceInputs.length}).`,
          isError: true,
        };
      }
    }


    // gpt-image-2 reliably serves 1024x1024 only — other sizes time out at
    // the gateway. Force the supported size regardless of caller / router
    // input so we never burn USDC on a request that's going to abort.
    if (imageModel === 'openai/gpt-image-2' && imageSize !== '1024x1024') {
      imageSize = '1024x1024';
    }

    // Validate the size against the model's supported set before paying. The
    // gateway rejects unsupported sizes with a 400, so catching it here saves
    // a wasted round-trip (and historically a wasted x402 retry). Models not
    // in the table (custom / future gateway models) skip this check.
    const supportedSizes = IMAGE_MODEL_SIZES[imageModel];
    if (supportedSizes && !supportedSizes.includes(imageSize)) {
      return {
        output:
          `Error: invalid size ${imageSize} for ${imageModel}. ` +
          `Supported sizes: ${supportedSizes.join(', ')}.`,
        isError: true,
      };
    }

    // Resolve the authoritative per-image cost ONCE, reused below for the
    // budget check, spend confirm, usage stats, and asset recording. The
    // catalog lookup is best-effort: a cold-cache fetch failure must NOT abort
    // a consented paid generation, so degrade to the static estimate instead of
    // letting findModel throw out of execute() (mirrors videogen's fallback).
    let catalogModel: GatewayModel | null = null;
    try {
      catalogModel = await findModel(imageModel);
    } catch {
      // Catalog momentarily unreachable — resolveImageUnitCost falls back to
      // the size-aware static table on its own.
    }
    const perImageUsd = resolveImageUnitCost(catalogModel, imageModel, imageSize);

    if (contentId && deps.library) {
      const decision = checkImageBudget(deps.library, contentId, imageModel, imageSize, n, perImageUsd * n);
      if (!decision.ok) {
        // Normal text output, not isError — the agent should adapt (smaller
        // size, different model, raise budget) rather than trigger retry.
        return {
          output:
            `## Image generation skipped\n` +
            `- ${decision.reason}\n\n` +
            `${noChargeNote()} Choose a cheaper model/size or raise the ` +
            `content budget before trying again.`,
        };
      }
    }

    // Confirm the spend before the paid call (parity with VideoGen). Pure price
    // math — no LLM. Interactive callers (CLI / agent) get a prompt via
    // onAskUser; direct callers (e.g. the desktop media path) pass no onAskUser
    // and generate straight away — the explicit "generate" action is consent.
    const autoApprove = process.env.FRANKLIN_MEDIA_AUTO_APPROVE_ALL === '1';
    if (!autoApprove && ctx.onAskUser) {
      const est = perImageUsd * n;
      const priceNote = est > 0 ? ` for ~$${est.toFixed(2)}` : '';
      const countNote = n > 1 ? `${n} images` : 'an image';
      const answer = await ctx.onAskUser(
        `Generate ${countNote} with ${imageModel}${priceNote}? ${cancelHint()}`,
        ['Generate', 'Cancel'],
      );
      if (answer !== 'Generate') {
        return { output: `## Image generation cancelled\n\n${noChargeNote()}` };
      }
    }

    // Resolve all reference images + the mask into base64 data URIs now, right
    // before the paid call. Done after the cheap validations so bad paths /
    // oversize attachments / unsupported combinations fail without any network
    // or filesystem cost beyond what's necessary.
    let referenceImages: string[] = [];
    let resolvedMask: string | undefined;
    if (editMode) {
      try {
        referenceImages = await Promise.all(
          referenceInputs.map(r => resolveReferenceImage(r, ctx.workingDir)),
        );
        if (mask) resolvedMask = await resolveReferenceImage(mask, ctx.workingDir);
      } catch (err) {
        return { output: `Error: ${(err as Error).message}`, isError: true };
      }
    }

  const chain = loadChain();
  const apiUrl = gatewayBase();
  // Reference-image mode hits the dedicated /v1/images/image2image endpoint;
  // otherwise stay on text-to-image generations.
  const endpoint = editMode
    ? `${apiUrl}/v1/images/image2image`
    : `${apiUrl}/v1/images/generations`;

  // Default output path
  const outPath = output_path
    ? (path.isAbsolute(output_path) ? output_path : path.resolve(ctx.workingDir, output_path))
    : path.resolve(ctx.workingDir, `generated-${Date.now()}.png`);
  // A caller-controlled output_path must not be allowed to overwrite the wallet
  // key store (e.g. output_path="~/.blockrun/.session" would brick the wallet).
  if (isWalletKeyPath(outPath)) {
    return { output: `Error: refusing to write to the wallet key store: ${outPath}`, isError: true };
  }

  const body = JSON.stringify(
    editMode
      ? {
          model: imageModel,
          prompt: chosenPrompt,
          // Gateway accepts a string (single) or array (fusion) for `image`.
          // Send a string for the single-image case to keep that path byte-
          // identical to before.
          image: referenceImages.length === 1 ? referenceImages[0] : referenceImages,
          ...(resolvedMask ? { mask: resolvedMask } : {}),
          size: imageSize,
          n,
        }
      : {
          model: imageModel,
          prompt: chosenPrompt,
          n,
          size: imageSize,
          response_format: 'b64_json',
        },
  );

  const headers: Record<string, string> = {
    ...gatewayHeaders(),
    'Content-Type': 'application/json',
    'User-Agent': `franklin/${VERSION}`,
  };

  const controller = new AbortController();
  // Reference-image mode (gpt-image-2 edits) is meaningfully slower than
  // pure text-to-image: the model is reasoning-driven and the request
  // body carries a few MB of base64. The shared 60s budget has to cover
  // both x402 retry attempts plus the actual generation, which made
  // image-to-image effectively always time out. Image-to-image gets 3
  // minutes; text-to-image keeps the original 60s.
  const timeoutMs = editMode ? 180_000 : 60_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Wall-clock start of the paid call, including 402 retry + (optional)
  // 202 polling. Used by recordUsage below so franklin-stats.json
  // populates avgLatencyMs for image models. Mirrors the agent-loop fix
  // in 3.15.61 — same pattern, same reason: insights couldn't surface
  // "Seedance is slower than grok" while every media call recorded 0.
  const callStartedAt = Date.now();

  try {
    // First request — will get 402
    let response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body,
    });

    // Handle x402 payment. Lifted out of the inner block so the polling
    // path below can reuse the signed headers — every poll request
    // re-presents the same authorization (the gateway settles on the
    // first completed poll, same contract as videogen.ts:251).
    let paymentHeaders: Record<string, string> | null = null;
    if (response.status === 402) {
      paymentHeaders = await signPayment(response, chain, endpoint);
      if (!paymentHeaders) {
        return { output: 'Payment failed. Check wallet balance with: franklin balance', isError: true };
      }

      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...headers, ...paymentHeaders },
        body,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { output: `Image generation failed (${response.status}): ${errText.slice(0, 200)}`, isError: true };
    }

    let result = await response.json() as {
      data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
      error?: unknown;
      message?: unknown;
      poll_url?: string;
      id?: string;
      status?: string;
    };

    // Async path: gateway returns HTTP 202 (Accepted, queued) + a poll_url
    // when the upstream image model takes longer than the inline budget
    // (gpt-image-1/-2 routinely exceed 30s). Verified 2026-05-04 from
    // Cloud Run logs — five back-to-back ImageGen calls that the agent
    // saw as "No image data returned from API" had all returned 202;
    // 4 of 5 actually completed in GCS within 41–56s and would have
    // been retrievable if Franklin had polled. Mirror videogen.ts's
    // pollUntilReady contract: same x-payment header on each poll.
    if (response.status === 202 && result.poll_url) {
      const origin = new URL(apiUrl).origin;
      const pollEndpoint = result.poll_url.startsWith('http')
        ? result.poll_url
        : `${origin}${result.poll_url}`;
      const pollHeaders = paymentHeaders ? { ...headers, ...paymentHeaders } : headers;
      // Replace the POST timeout with a longer poll deadline. Image
      // generation routinely completes within 1–3 min once queued; the
      // 5 min ceiling matches videogen's POLL_MAX_WAIT_MS scale.
      clearTimeout(timeout);
      const outcome = await pollImageJob(pollEndpoint, pollHeaders, controller.signal);
      if (outcome.kind === 'failed') {
        return {
          output: `Image generation failed upstream: ${JSON.stringify(outcome.error ?? '').slice(0, 240)}`,
          isError: true,
        };
      }
      if (outcome.kind === 'poll_http_error') {
        return { output: `Image poll failed (${outcome.status}): ${outcome.bodyPreview}`, isError: true };
      }
      if (outcome.kind === 'timed_out') {
        return {
          output:
            `Image generation queued but did not complete within 5 minutes. Payment was settled when the gateway accepted the job (HTTP 202). ` +
            `If this keeps happening, the upstream image model is overloaded — try a smaller / faster model or retry later.`,
          isError: true,
        };
      }
      result = outcome.body;
    }

    const items = (result.data ?? []).filter(
      (d): d is { b64_json?: string; url?: string; revised_prompt?: string } =>
        !!d && (!!d.b64_json || !!d.url),
    );
    if (items.length === 0) {
      // Some gateways return 200 with an `error` / `message` field for
      // moderation, quota, or upstream-model failures instead of using
      // HTTP error codes. Without surfacing those, the agent sees only
      // "No image data returned from API" and starts guessing — verified
      // 2026-05-04: agent guessed "gpt-image-2 is forced to 1024x1024
      // per the tool docs" and burned a retry on a size param that
      // wasn't the actual cause. Surface the diagnostic so the agent
      // (or user) can react.
      const bits: string[] = [];
      if (result.error !== undefined) {
        bits.push(`error=${JSON.stringify(result.error).slice(0, 240)}`);
      }
      if (result.message !== undefined) {
        bits.push(`message=${String(result.message).slice(0, 240)}`);
      }
      if (Array.isArray(result.data) && result.data.length === 0) {
        bits.push('data=[] (empty array — likely content moderation)');
      } else if (result.data === undefined) {
        bits.push('data field missing');
      }
      const detail = bits.length > 0 ? ` — ${bits.join('; ')}` : '';
      return { output: `No image data returned from API${detail}`, isError: true };
    }

    // Output paths: one image keeps the requested path verbatim; multiple
    // images get a -1/-2/... suffix before the extension so nothing clobbers.
    const targetPaths =
      items.length === 1 ? [outPath] : items.map((_, i) => withIndexSuffix(outPath, i + 1));

    // Save each returned image. The /v1/images/image2image endpoint returns
    // Gemini results as a data URI in `url`, so decode those locally instead
    // of going through fetch — saves a round-trip and avoids data:-URI quirks.
    const savedPaths: string[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        await saveImageDataToFile(items[i], targetPaths[i]);
      } catch (err) {
        return { output: `Error saving image ${i + 1}: ${(err as Error).message}`, isError: true };
      }
      savedPaths.push(targetPaths[i]);
    }

    // Stats: record this generation so it shows up in `franklin insights`
    // alongside chat spend. Before this, media generations bypassed
    // recordUsage entirely (only LLM chat calls were tracked), so the
    // insights panel under-reported total spend and never surfaced
    // image-generation models in its "top models" list. Fire-and-forget —
    // stats write must not fail a user-visible generation.
    const latencyMs = Date.now() - callStartedAt;
    void (async () => {
      try {
        const estCost = perImageUsd * items.length;
        recordUsage(imageModel, 0, 0, estCost, latencyMs);
      } catch { /* ignore stats errors */ }
    })();

    let contentSummary = '';
    if (contentId && deps.library) {
      // Record each saved image as its own asset so the content's budget
      // counts every paid output, not just the first.
      let attached = 0;
      let totalCost = 0;
      let lastReason = '';
      for (const p of savedPaths) {
        const rec = recordImageAsset(deps.library, {
          contentId,
          imagePath: p,
          model: imageModel,
          size: imageSize,
          costUsd: perImageUsd,
        });
        if (rec.ok) {
          attached++;
          totalCost += rec.costUsd;
        } else {
          lastReason = rec.reason;
        }
      }
      if (attached > 0) {
        if (deps.onContentChange) await deps.onContentChange();
        const c = deps.library.get(contentId);
        contentSummary =
          `\n\n## Content updated\n` +
          `- Attached ${attached} image${attached > 1 ? 's' : ''} to ` +
          `\`${contentId}\` at est. $${totalCost.toFixed(2)}\n` +
          (c
            ? `- Spent: $${c.spentUsd.toFixed(2)} / $${c.budgetUsd.toFixed(2)} cap ` +
              `(remaining $${(c.budgetUsd - c.spentUsd).toFixed(2)})`
            : '');
      } else {
        // Pre-flight guarded this, but keep defensive — bookkeeping refusal
        // after a successful paid generation is rare (TOCTOU) but possible.
        contentSummary =
          `\n\n## Content NOT updated\n` +
          `- ${lastReason}\n` +
          `- The image${savedPaths.length > 1 ? 's were' : ' was'} generated and ` +
          `saved locally; cost was NOT recorded against the content budget.`;
      }
    }

    const revisedPrompt = items[0]?.revised_prompt
      ? `\nRevised prompt: ${items[0].revised_prompt}`
      : '';
    const summaryLines = savedPaths.map(p => {
      const kb = (fs.statSync(p).size / 1024).toFixed(1);
      return `- ${p} (${kb}KB, ${imageSize})`;
    });
    const header =
      savedPaths.length === 1
        ? `Image saved to ${savedPaths[0]} (${(fs.statSync(savedPaths[0]).size / 1024).toFixed(1)}KB, ${imageSize})`
        : `${savedPaths.length} images saved:\n${summaryLines.join('\n')}`;
    const openHint =
      savedPaths.length === 1
        ? `\n\nOpen with: open ${savedPaths[0]}`
        : `\n\nOpen with: open ${savedPaths.join(' ')}`;

    return {
      output: `${header}${revisedPrompt}${openHint}${contentSummary}`,
    };
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('abort')) {
      return {
        output: editMode
          ? 'Image-to-image timed out (180s limit). The reference image may be too large or the model under load — try a smaller image or simpler prompt.'
          : 'Image generation timed out (60s limit). Try a simpler prompt.',
        isError: true,
      };
    }
    return { output: `Error: ${msg}`, isError: true };
  } finally {
    clearTimeout(timeout);
  }
  };
}

/** Insert a `-{idx}` suffix before the file extension: a.png → a-2.png. */
export function withIndexSuffix(p: string, idx: number): string {
  const ext = path.extname(p);
  const base = ext ? p.slice(0, p.length - ext.length) : p;
  return `${base}-${idx}${ext}`;
}

/**
 * Save one gateway image item to disk. Handles b64_json, data-URI `url`
 * (Gemini), and remote `url` (downloaded with a 30s timeout). Throws on a
 * malformed or empty item.
 */
async function saveImageDataToFile(
  imageData: { b64_json?: string; url?: string },
  destPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (imageData.b64_json) {
    fs.writeFileSync(destPath, Buffer.from(imageData.b64_json, 'base64'));
    return;
  }
  if (imageData.url && imageData.url.startsWith('data:')) {
    const match = imageData.url.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new Error('Malformed data URI in response');
    fs.writeFileSync(destPath, Buffer.from(match[1], 'base64'));
    return;
  }
  if (imageData.url) {
    const dlCtrl = new AbortController();
    const dlTimeout = setTimeout(() => dlCtrl.abort(), 30_000);
    try {
      const imgResp = await fetch(imageData.url, { signal: dlCtrl.signal });
      fs.writeFileSync(destPath, Buffer.from(await imgResp.arrayBuffer()));
    } finally {
      clearTimeout(dlTimeout);
    }
    return;
  }
  throw new Error('No image data (b64_json or url) in response');
}

// ─── Payment ───────────────────────────────────────────────────────────────

async function signPayment(
  response: Response,
  chain: 'base' | 'solana',
  endpoint: string
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
          resourceDescription: details.resource?.description || 'Franklin image generation',
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
          resourceDescription: details.resource?.description || 'Franklin image generation',
          maxTimeoutSeconds: details.maxTimeoutSeconds || 300,
          extra: details.extra as Record<string, unknown> | undefined,
        }
      );
      return { 'PAYMENT-SIGNATURE': payload };
    }
  } catch (err) {
    logger.warn(`[franklin] Image payment error: ${(err as Error).message}`);
    return null;
  }
}

async function extractPaymentReq(response: Response): Promise<string | null> {
  let header = response.headers.get('payment-required');
  if (!header) {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.x402 || body.accepts) {
        header = btoa(JSON.stringify(body));
      }
    } catch { /* ignore */ }
  }
  return header;
}

// ─── Export ────────────────────────────────────────────────────────────────

/**
 * Build the ImageGen capability. Passing `deps.library` enables the
 * contentId flow: pre-flight budget check + post-generation asset
 * recording. With no deps, behavior matches the pre-factory version.
 */
export function createImageGenCapability(deps: ImageGenDeps = {}): CapabilityHandler {
  return {
    spec: {
      name: 'ImageGen',
      description:
        "Generate or edit an image. Text-to-image from a prompt, or " +
        "image-to-image when you pass a reference image (style transfer, " +
        "character consistency, edits). Supports mask-based inpainting and " +
        "multi-image fusion. Billed per image — confirm " +
        "before generating. Saves to local file(s). Default size: 1024x1024. " +
        "Do NOT call repeatedly to iterate on style — ask the user first. " +
        "Pass contentId to attach the result to an existing Content piece: " +
        "the content's budget is checked BEFORE paying, and on success each " +
        "image is recorded as an asset with its estimated cost. Skipping " +
        "contentId generates one-off images with no budget tracking. " +
        "Edit-capable models: openai/gpt-image-1, openai/gpt-image-2, " +
        "google/nano-banana, google/nano-banana-pro. Mask inpainting is " +
        "OpenAI-only; multi-image fusion is capped at 4 (OpenAI) / 3 (Google).",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Text description of the image to generate, or edit instructions when a reference image is provided' },
          output_path: { type: 'string', description: 'Where to save the image. Default: generated-<timestamp>.png in working directory. With n>1, a -1/-2/... suffix is appended before the extension.' },
          size: { type: 'string', description: 'Image size. gpt-image-1/2: 1024x1024, 1536x1024, 1024x1536. google/nano-banana: 1024x1024. google/nano-banana-pro: 1024x1024, 2048x2048, 4096x4096. Default: 1024x1024. Note: openai/gpt-image-2 is forced to 1024x1024 (other sizes time out at the gateway).' },
          model: { type: 'string', description: 'Image model to use. Default: openai/gpt-image-1 (text-to-image) / openai/gpt-image-2 (image-to-image).' },
          image_url: { type: 'string', description: 'Optional reference image (image-to-image / style transfer). Accepts an http(s) URL, a data URI, or a local file path. Only edit-capable models are accepted.' },
          images: { type: 'array', items: { type: 'string' }, description: 'Optional list of reference images for multi-image fusion (e.g. subject + logo). Same forms as image_url. Merged with image_url. Cap: OpenAI 4, Google 3. Cannot combine with mask.' },
          mask: { type: 'string', description: 'Optional mask for inpainting — transparent pixels mark the editable region. Same forms as image_url. OpenAI edit models only; cannot combine with multiple source images.' },
          n: { type: 'number', description: 'Number of images to generate, 1-4. Default 1. Cost scales with n.' },
          contentId: { type: 'string', description: 'Optional Content id to attach this generation to. Pre-flight budget check + auto-record on success.' },
        },
        required: ['prompt'],
      },
    },
    execute: buildExecute(deps),
    concurrent: false,
  };
}

/** Back-compat static capability for callers that don't want the Content bridge. */
export const imageGenCapability: CapabilityHandler = createImageGenCapability();

// ─── Async-completion polling ────────────────────────────────────────────────
//
// Extracted so the 202-queued path can be unit-tested without spinning up the
// full x402 + wallet machinery. Mirrors videogen.ts:pollUntilReady contract:
//   - Same `x-payment` header on every poll (gateway settles on the first
//     completed poll).
//   - 202 → still queued; sleep + retry.
//   - 429 / 5xx → transient; sleep + retry.
//   - 200 with `status: 'completed'` or non-empty `data` → done.
//   - 200 with `status: 'failed'` → upstream-model failure.
//   - Other 4xx → surface body for diagnosis (e.g. moderation, expired auth).

export interface ImagePollBody {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  error?: unknown;
  status?: string;
}

export type ImagePollOutcome =
  | { kind: 'completed'; body: ImagePollBody }
  | { kind: 'failed'; error?: unknown }
  | { kind: 'timed_out' }
  | { kind: 'poll_http_error'; status: number; bodyPreview: string };

export interface PollImageJobOptions {
  /** Total wall-clock ceiling. Defaults to 5 min (matches videogen scale). */
  maxWaitMs?: number;
  /** Sleep between polls. Defaults to 3 s. */
  intervalMs?: number;
}

export async function pollImageJob(
  pollEndpoint: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  options: PollImageJobOptions = {},
): Promise<ImagePollOutcome> {
  const maxWaitMs = options.maxWaitMs ?? 5 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted');
    await sleep(intervalMs, signal);

    const resp = await fetch(pollEndpoint, { method: 'GET', headers, signal });
    if (resp.status === 202) continue;            // still queued
    if (resp.status === 429 || resp.status >= 500) continue; // transient

    if (resp.ok) {
      const body = (await resp.json().catch(() => null)) as ImagePollBody | null;
      if (!body) continue;
      if (body.status === 'failed') return { kind: 'failed', error: body.error };
      if (body.status === 'completed' || (body.data && body.data[0])) {
        return { kind: 'completed', body };
      }
      // Non-terminal but ok shape (e.g. status: 'in_progress') — wait.
      continue;
    }

    const text = await resp.text().catch(() => '');
    return { kind: 'poll_http_error', status: resp.status, bodyPreview: text.slice(0, 200) };
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
