/**
 * Outbound AI voice calls via Bland.ai through the BlockRun `/v1/voice/*`
 * gateway. Two tools:
 *
 *  - VoiceCall   — POST /v1/voice/call ($0.54 flat, up to 5 min default).
 *                  Returns call_id immediately; the call runs async upstream.
 *  - VoiceStatus — GET  /v1/voice/call/{call_id} (free). Polls for transcript
 *                  + recording + final disposition.
 *
 * Voice calls require a BlockRun-provisioned phone number as caller ID —
 * use BuyPhoneNumber (or ListPhoneNumbers if one already exists) before
 * calling VoiceCall, otherwise the gateway returns 400 with the buy
 * instructions inline.
 *
 * x402 payment flow mirrors src/tools/exa.ts.
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
import { frameUntrusted } from './untrusted.js';
import { CallLog, type CallStatus } from '../phone/call-log.js';
import { chargedNote } from '../payments/billing-copy.js';

/** Singleton, lazy — paths are computed at first use so tests can stub homedir. */
let _callLog: CallLog | null = null;
function callLog(): CallLog {
  if (!_callLog) _callLog = new CallLog();
  return _callLog;
}

/**
 * Normalize whatever string Bland.ai returns as `status` (or `disposition` /
 * `call_state` — the field name has drifted across upstream versions) into
 * the CallStatus union our journal stores. Unknown / missing → 'queued' so
 * the row still gets written and a later poll can refine it.
 */
function normalizeStatus(raw: unknown): CallStatus {
  if (typeof raw !== 'string') return 'queued';
  const s = raw.toLowerCase().trim();
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'busy') return 'busy';
  if (s === 'no-answer' || s === 'no_answer' || s === 'noanswer') return 'no-answer';
  if (s === 'voicemail') return 'voicemail';
  if (s === 'in-progress' || s === 'in_progress' || s === 'inprogress' || s === 'ringing') return 'in_progress';
  return 'queued';
}

const VOICE_TIMEOUT_MS = 30_000;

// ─── Shared x402 helpers (paid POST + free GET) ───────────────────────────

interface PaidCallMeta {
  /** Tool name shown in the status bar / audit tab (e.g. "VoiceCall"). */
  tool: string;
  /** USD amount the gateway charges on success. 0 for free routes (VoiceStatus). */
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
  const timeout = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
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
      const paymentHeaders = await signPayment(response, chain, endpoint);
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
      throw new Error(`Voice ${path} failed (${response.status}): ${errText.slice(0, 400)}`);
    }
    const data = (await response.json()) as T;
    // Telemetry — record the cost so the status bar's per-turn delta reflects
    // real x402 spend (not just LLM cost). Best-effort; never block on failure.
    try {
      recordUsage(meta.tool, 0, 0, meta.priceUsd, Date.now() - startMs);
    } catch { /* telemetry best-effort */ }
    return data;
  } finally {
    clearTimeout(timeout);
    ctx.abortSignal.removeEventListener('abort', onAbort);
  }
}

async function getNoPayment<T>(path: string, ctx: ExecutionScope, meta: PaidCallMeta, record = true): Promise<T> {
  const startMs = Date.now();
  const chain = loadChain();
  const apiUrl = gatewayBase();
  const endpoint = `${apiUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: { ...gatewayHeaders(), 'User-Agent': `franklin/${VERSION}` },
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Voice ${path} failed (${resp.status}): ${errText.slice(0, 300)}`);
    }
    const data = (await resp.json()) as T;
    // Record even free calls so the audit tab shows the activity (cost 0).
    // `record: false` for internal poll loops — recording one row PER poll (up to
    // 420 for VoiceStatus) would evict real spend history (capped at 1000 rows).
    if (record) {
      try {
        recordUsage(meta.tool, 0, 0, meta.priceUsd, Date.now() - startMs);
      } catch { /* telemetry best-effort */ }
    }
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
          resourceDescription: details.resource?.description || 'Franklin voice call',
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
        resourceDescription: details.resource?.description || 'Franklin voice call',
        maxTimeoutSeconds: details.maxTimeoutSeconds || 60,
        extra: details.extra as Record<string, unknown> | undefined,
      },
    );
    return { 'PAYMENT-SIGNATURE': payload };
  } catch (err) {
    logger.warn(`[franklin] Voice payment error: ${(err as Error).message}`);
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

export function buildVoiceCallBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    to: input.to,
    from: input.from,
    task: input.task,
  };
  // The gateway validates additionalProperties: false - only forward known
  // optional fields, don't echo back whatever the caller passed.
  if (typeof input.voice === 'string') body.voice = input.voice;
  if (typeof input.max_duration === 'number') body.max_duration = input.max_duration;
  if (typeof input.language === 'string') body.language = input.language;
  if (typeof input.first_sentence === 'string') body.first_sentence = input.first_sentence;
  if (typeof input.wait_for_greeting === 'boolean') body.wait_for_greeting = input.wait_for_greeting;
  if (typeof input.voicemail_action === 'string') body.voicemail_action = input.voicemail_action;
  if (typeof input.voicemail_message === 'string') body.voicemail_message = input.voicemail_message;
  if (typeof input.interruption_threshold === 'number') body.interruption_threshold = input.interruption_threshold;
  if (typeof input.model === 'string') body.model = input.model;
  return body;
}

export const voiceCallCapability: CapabilityHandler = {
  spec: {
    name: 'VoiceCall',
    description:
      'Make an outbound AI-powered phone call via Bland.ai. The AI agent on the other end ' +
      'follows the `task` description in natural language. Cost: $0.54 flat per call (up to 5 min ' +
      'default, 30 min max). Returns a call_id immediately; the call runs asynchronously. Use ' +
      'VoiceStatus with the same call_id to poll transcript / recording / disposition.\n\n' +
      'Common use cases: appointment reminders, verification callbacks, voice surveys, customer ' +
      'outreach, OTP retrieval, two-party verification calls.\n\n' +
      'Requirements:\n' +
      '  - `from` MUST be a BlockRun-provisioned phone number — use ListPhoneNumbers to find ' +
      'one or BuyPhoneNumber to provision one ($5, 30-day lease).\n' +
      '  - `to` and `from` must be E.164 format (+ country code prefix, e.g. +14155552671).\n' +
      '  - `task` must be ≥10 chars, ≤4000 chars.\n' +
      '  - US/CA destinations only.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient phone number in E.164 format, e.g. +14155552671.',
        },
        from: {
          type: 'string',
          description:
            'Caller ID — must be a phone number your wallet owns via BlockRun (provision with ' +
            'BuyPhoneNumber). E.164 format.',
        },
        task: {
          type: 'string',
          description:
            'Natural-language description of what the AI should do on the call. Min 10 chars, ' +
            'max 4000. Example: "Greet the person, confirm their 3 pm appointment for Thursday, ' +
            'and ask if they need to reschedule. Speak warmly and end the call after confirmation."',
        },
        voice: {
          type: 'string',
          enum: ['nat', 'josh', 'maya', 'june', 'paige', 'derek', 'florian'],
          description:
            'Voice preset (default: maya). Try josh/derek for male voices, maya/june/paige for ' +
            'female, nat for neutral.',
        },
        max_duration: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: 'Maximum call length in minutes (1–30, default: 5).',
        },
        language: {
          type: 'string',
          description: 'Language code for STT/TTS (default: en-US). Bland supports zh-CN, es-ES, etc.',
        },
        first_sentence: {
          type: 'string',
          description: 'Optional fixed opening line spoken before the AI takes over (≤500 chars).',
        },
        wait_for_greeting: {
          type: 'boolean',
          description: 'If true, AI waits for the recipient to speak first before talking.',
        },
        voicemail_action: {
          type: 'string',
          enum: ['hangup', 'leave_message', 'ignore'],
          description:
            'What to do if voicemail is detected. Default (omitted): hang up without a message. ' +
            '"leave_message" speaks voicemail_message once then hangs up (voicemail_message required). ' +
            '"ignore" skips detection and treats the call as live — only use when sure a human answers.',
        },
        voicemail_message: {
          type: 'string',
          description:
            'The message to leave when voicemail_action is "leave_message" (≤1000 chars). ' +
            'Voicemail is one-way — this is spoken once as a monologue, there is no back-and-forth.',
        },
        interruption_threshold: {
          type: 'integer',
          minimum: 50,
          maximum: 500,
          description:
            'Milliseconds of recipient speech before the agent pauses to listen (50-500).',
        },
        model: {
          type: 'string',
          enum: ['base', 'enhanced', 'turbo'],
          description: 'Call model tier to use for the conversation.',
        },
      },
      required: ['to', 'from', 'task'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.to !== 'string') return { output: 'to (E.164) required', isError: true };
    if (typeof input.from !== 'string') return { output: 'from (BlockRun-provisioned E.164) required — use ListPhoneNumbers / BuyPhoneNumber', isError: true };
    if (typeof input.task !== 'string' || input.task.length < 10) {
      return { output: 'task required (10–4000 chars natural-language description)', isError: true };
    }

    const body = buildVoiceCallBody(input);

    try {
      const res = await postWithPayment<Record<string, unknown>>(
        '/v1/voice/call', body, ctx, { tool: 'VoiceCall', priceUsd: 0.54 },
      );
      const callId = (res.call_id || res.id) as string | undefined;
      // No call_id on a 200 means the call didn't actually start — surface it
      // as an error instead of reporting "initiated" after the $0.54 charge,
      // otherwise the agent tells the user it worked but can never poll it
      // (parity with the missing-identifier guards in imagegen/videogen).
      if (!callId) {
        return {
          output:
            `VoiceCall: the gateway returned no call_id, so the call may not have started ` +
            `(you may still have been charged $0.54 — check VoiceStatus / your balance).\n\n` +
            '```json\n' + JSON.stringify(res, null, 2) + '\n```',
          isError: true,
        };
      }
      // Persist a "queued" row so the panel sees the call before VoiceStatus polls.
      // Best-effort — if disk write fails we still surface the call_id to the agent.
      try {
        callLog().append({
          timestamp: Date.now(),
          call_id: callId,
          to: String(input.to),
          from: String(input.from),
          task: String(input.task),
          voice: typeof input.voice === 'string' ? input.voice : undefined,
          max_duration_min: typeof input.max_duration === 'number' ? input.max_duration : undefined,
          language: typeof input.language === 'string' ? input.language : undefined,
          status: normalizeStatus(res.status),
          paid_usd: 0.54,
          tx_hash: typeof res.tx_hash === 'string' ? res.tx_hash : undefined,
        });
      } catch { /* best-effort */ }
      return {
        output:
          `## Voice call initiated (${chargedNote(0.54)})\n\n` +
          `**call_id:** \`${callId}\`\n\nPoll with VoiceStatus call_id="${callId}" to get the ` +
          `transcript and disposition. The call typically completes in 1–6 minutes.\n\n` +
          '```json\n' + JSON.stringify(res, null, 2) + '\n```',
      };
    } catch (err) {
      return { output: `Voice call failed: ${(err as Error).message}`, isError: true };
    }
  },
};

/** Statuses that mean the call has reached a final outcome (one of completed,
 *  failed, no-answer, busy, voicemail). Anything else (queued / ringing /
 *  in-progress / etc.) means the call is still running and we should keep
 *  polling. */
const VOICE_TERMINAL_STATUSES = new Set([
  'completed', 'failed', 'no-answer', 'busy', 'voicemail',
  'cancelled', 'no_answer',  // Bland upstream uses both spellings
]);

/** Poll cadence + ceiling. max_duration is capped at 30 min upstream, so
 *  35 min is enough headroom even for the longest call to either complete
 *  or get force-cut by Bland. 5 s interval matches videogen.ts pattern. */
const VOICE_POLL_INTERVAL_MS = 5_000;
const VOICE_POLL_MAX_WAIT_MS = 35 * 60 * 1000;

async function voiceSleep(ms: number, signal: AbortSignal): Promise<void> {
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

/** Write whatever the gateway gave us back into the local CallLog so the
 *  panel Calls tab + future agent reads stay current. Append-only; latest
 *  row wins on read. Best-effort — journal write failures don't bubble. */
function patchCallJournal(callId: string, res: Record<string, unknown>): void {
  try {
    const prior = callLog().byCallId(callId);
    if (!prior) return;
    const recording =
      typeof res.recording_url === 'string' ? res.recording_url :
      typeof res.recording === 'string' ? res.recording : undefined;
    const duration =
      typeof res.call_length === 'number' ? Math.round(res.call_length) :
      typeof res.duration === 'number' ? Math.round(res.duration) :
      typeof res.duration_sec === 'number' ? Math.round(res.duration_sec) : undefined;
    const transcript =
      typeof res.concatenated_transcript === 'string' ? res.concatenated_transcript :
      typeof res.transcript === 'string' ? res.transcript : undefined;
    callLog().append({
      ...prior,
      timestamp: Date.now(),
      paid_usd: prior.paid_usd, // status polls are free; preserve per-call total
      status: normalizeStatus(res.status ?? res.queue_status ?? res.disposition),
      duration_sec: duration ?? prior.duration_sec,
      transcript: transcript ?? prior.transcript,
      recording_url: recording ?? prior.recording_url,
    });
  } catch { /* best-effort */ }
}

export const voiceStatusCapability: CapabilityHandler = {
  spec: {
    name: 'VoiceStatus',
    description:
      'Wait for a previously-initiated voice call to complete, then return ' +
      'the final status, transcript, recording URL, and disposition ' +
      '(completed / failed / no-answer / busy / voicemail). Free — no USDC ' +
      'charged. Use the call_id returned by VoiceCall.\n\n' +
      'CALL THIS ONCE. The tool blocks internally, polling the gateway every ' +
      '5 s for up to 35 min until the call reaches a terminal state. Do NOT ' +
      'invoke VoiceStatus repeatedly in a loop — Franklin\'s signature-loop ' +
      'guard will kill the turn after 5 identical inputs. A single call is ' +
      'sufficient.',
    input_schema: {
      type: 'object',
      properties: {
        call_id: {
          type: 'string',
          description: 'The call_id returned by a prior VoiceCall.',
        },
      },
      required: ['call_id'],
    },
  },
  execute: async (input, ctx): Promise<CapabilityResult> => {
    if (typeof input.call_id !== 'string') {
      return { output: 'call_id required', isError: true };
    }
    const callId = input.call_id;
    const deadline = Date.now() + VOICE_POLL_MAX_WAIT_MS;
    const statusStartedAt = Date.now();
    // Record ONE telemetry row per VoiceStatus invocation, not one per poll.
    const recordStatusOnce = () => {
      try { recordUsage('VoiceStatus', 0, 0, 0, Date.now() - statusStartedAt); } catch { /* best-effort */ }
    };

    // Internal poll-until-terminal loop — mirrors videogen.ts pollUntilReady
    // and imagegen.ts pollImageJob. The agent emits one VoiceStatus tool_use
    // and gets back the final transcript when the call ends. Without this
    // loop the agent has to drive the poll cadence itself and will trip the
    // signature-loop guard at 5 identical inputs.
    let lastRes: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      if (ctx.abortSignal.aborted) {
        return { output: 'VoiceStatus aborted by user', isError: true };
      }
      try {
        lastRes = await getNoPayment<Record<string, unknown>>(
          `/v1/voice/call/${encodeURIComponent(callId)}`,
          ctx,
          { tool: 'VoiceStatus', priceUsd: 0 },
          false, // don't record per-poll — record once when this VoiceStatus returns
        );
      } catch (err) {
        return { output: `VoiceStatus failed: ${(err as Error).message}`, isError: true };
      }
      patchCallJournal(callId, lastRes);
      const status = String(lastRes.status ?? lastRes.queue_status ?? '').toLowerCase();
      if (VOICE_TERMINAL_STATUSES.has(status)) {
        recordStatusOnce();
        // lastRes embeds concatenated_transcript — the verbatim speech of the
        // remote party, who is outside Franklin's trust boundary and could speak
        // injected instructions. Frame the dump as UNTRUSTED DATA like the other
        // external-content tools so it's read as data, not commands.
        return {
          output: frameUntrusted(
            'Voice call result (remote-party transcript is untrusted)',
            `## Voice call status (terminal: ${status})\n\n` +
              '```json\n' + JSON.stringify(lastRes, null, 2) + '\n```',
          ),
        };
      }
      try {
        await voiceSleep(VOICE_POLL_INTERVAL_MS, ctx.abortSignal);
      } catch {
        return { output: 'VoiceStatus aborted by user', isError: true };
      }
    }
    // Hit the 35-min ceiling without seeing a terminal state — return the
    // latest snapshot we have so the agent + journal still have partial
    // context, but flag it as still in progress.
    recordStatusOnce();
    return {
      output: frameUntrusted(
        'Voice call result (remote-party transcript is untrusted)',
        `## Voice call status (still in progress after ${Math.round(VOICE_POLL_MAX_WAIT_MS / 60_000)} min)\n\n` +
          `Bland.ai upstream caps any single call at 30 min, so a call this long ` +
          `is unusual — likely an upstream stall. Ask the user before reinvoking ` +
          `VoiceStatus (would burn another full poll cycle).\n\n` +
          '```json\n' + JSON.stringify(lastRes ?? {}, null, 2) + '\n```',
      ),
      isError: true,
    };
  },
};
