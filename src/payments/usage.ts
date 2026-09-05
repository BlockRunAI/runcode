/**
 * The gateway's own per-request ledger, and how Franklin reconciles to it.
 *
 * Franklin's local numbers in key mode are catalog estimates: the account
 * gateway settles against a prepaid balance and returns no charge on the
 * response, so `franklin stats` reports what a call SHOULD have cost. This
 * module fetches what it DID cost.
 *
 * `GET /v1/usage` returns one row per request with a `request_id` that matches
 * the `x-blockrun-request-id` header the gateway already sends, so the join is
 * line-by-line rather than a comparison of two totals — a total that matches
 * can still be two errors cancelling out.
 *
 * Four properties of this feed change how it must be read, and getting any of
 * them wrong produces a confident wrong answer:
 *
 *   `cost_state: 'pending'` means the usage exists and its charge does not yet.
 *   Those rows can still be repriced. Summing them as zero understates spend
 *   and, worse, looks settled.
 *
 *   Zero-cost rows are INCLUDED on purpose. "You were not charged for this" is
 *   an answer; a row that is simply absent is indistinguishable from one the
 *   client dropped. Never filter them.
 *
 *   `unavailable_days` names days the gateway could not list rather than
 *   silently returning a short page. Swallowing it makes two correct ledgers
 *   look like they disagree.
 *
 *   `kind` says whether a row is checkable locally at all. A `chat` charge can
 *   be rebuilt from tokens and a published rate; a `service` charge is a
 *   per-call figure only the gateway holds, so a local estimate for one is a
 *   guess by construction and a mismatch is not evidence of a bug.
 *
 * The cursor is opaque. Do not parse it, and do not construct one.
 */

import { KEY_API_URL, USER_AGENT } from '../config.js';
import { loadApiKey } from './auth-mode.js';

export type CostState = 'priced' | 'pending' | 'free';
export type UsageKind = 'chat' | 'service';

export interface UsageRow {
  requestId: string;
  timestamp: string;
  endpoint: string;
  model: string | null;
  kind: UsageKind;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costState: CostState;
  status: number;
}

export interface UsagePage {
  rows: UsageRow[];
  /** Days the gateway could not list. Surface these; never treat as empty. */
  unavailableDays: string[];
}

/** Max rows the endpoint will return per page. */
const MAX_LIMIT = 500;
/** Stop paging rather than walk an unbounded history. */
const MAX_PAGES = 40;

function toRow(raw: Record<string, unknown>): UsageRow | null {
  const requestId = typeof raw.request_id === 'string' ? raw.request_id : '';
  if (!requestId) return null; // without the join key the row is not usable here
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const state = raw.cost_state;
  return {
    requestId,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    model: typeof raw.model === 'string' ? raw.model : null,
    kind: raw.kind === 'chat' ? 'chat' : 'service',
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    costUsd: num(raw.cost_usd),
    // An unrecognised state is treated as pending, not priced: the safe error
    // is "we do not know yet", never "settled at whatever number came through".
    costState: state === 'priced' || state === 'free' ? state : 'pending',
    status: num(raw.status),
  };
}

/**
 * Fetch usage rows, following the cursor. Returns null when there is no key or
 * the gateway is unreachable — callers show what they do know rather than
 * inventing a ledger.
 */
export async function fetchUsage(opts: {
  from?: string;
  to?: string;
  limit?: number;
  timeoutMs?: number;
} = {}): Promise<UsagePage | null> {
  const key = loadApiKey();
  if (!key) return null;

  const rows: UsageRow[] = [];
  const unavailableDays = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${KEY_API_URL}/v1/usage`);
    if (opts.from) url.searchParams.set('from', opts.from);
    if (opts.to) url.searchParams.set('to', opts.to);
    url.searchParams.set('limit', String(Math.min(opts.limit ?? MAX_LIMIT, MAX_LIMIT)));
    if (cursor) url.searchParams.set('cursor', cursor);

    let body: Record<string, unknown>;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (!res.ok) return null;
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }

    for (const raw of Array.isArray(body.data) ? body.data : []) {
      const row = toRow(raw as Record<string, unknown>);
      if (row) rows.push(row);
    }
    for (const d of Array.isArray(body.unavailable_days) ? body.unavailable_days : []) {
      if (typeof d === 'string') unavailableDays.add(d);
    }

    cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    if (!cursor) break;
  }

  return { rows, unavailableDays: [...unavailableDays] };
}

export interface UsageTotals {
  /** Rows whose charge has settled. This is the number you can trust. */
  pricedUsd: number;
  pricedCount: number;
  /** Usage that exists with no charge yet. Not a zero — it can still be priced. */
  pendingCount: number;
  /** Explicitly not chargeable. Counted, never hidden. */
  freeCount: number;
  chatCount: number;
  serviceCount: number;
}

export function summarize(rows: readonly UsageRow[]): UsageTotals {
  const t: UsageTotals = {
    pricedUsd: 0, pricedCount: 0, pendingCount: 0, freeCount: 0, chatCount: 0, serviceCount: 0,
  };
  for (const r of rows) {
    if (r.costState === 'priced') { t.pricedUsd += r.costUsd; t.pricedCount++; }
    else if (r.costState === 'pending') t.pendingCount++;
    else t.freeCount++;
    if (r.kind === 'chat') t.chatCount++; else t.serviceCount++;
  }
  return t;
}

export interface Reconciliation {
  /** Ledger rows Franklin also has locally, and whether the numbers agree. */
  matched: Array<{ row: UsageRow; localUsd: number; deltaUsd: number }>;
  /** Charged by the gateway with no local row. Franklin under-counted. */
  missingLocally: UsageRow[];
  /** Rows Franklin recorded that carry no id to join on. */
  unjoinable: number;
  totals: UsageTotals;
  unavailableDays: string[];
}

/**
 * Join the gateway ledger to Franklin's own journal on `request_id`.
 *
 * Only `priced` rows are compared. A `pending` row has no charge to disagree
 * with yet, and a `free` row's zero is an answer rather than a discrepancy.
 *
 * `unjoinable` counts local rows with no id — wallet-mode calls, free-path
 * calls, and anything recorded before the id was captured. They are reported
 * rather than hidden, because "0 mismatches" from a journal that could not be
 * joined is not the same statement as "0 mismatches".
 */
export function reconcile(
  ledger: UsagePage,
  local: ReadonlyArray<{ requestId?: string; costUsd: number }>,
): Reconciliation {
  const byId = new Map<string, number>();
  let unjoinable = 0;
  for (const r of local) {
    if (r.requestId) byId.set(r.requestId, (byId.get(r.requestId) ?? 0) + r.costUsd);
    else unjoinable++;
  }

  const matched: Reconciliation['matched'] = [];
  const missingLocally: UsageRow[] = [];
  for (const row of ledger.rows) {
    if (row.costState !== 'priced') continue;
    const localUsd = byId.get(row.requestId);
    if (localUsd === undefined) {
      // A charge with no local row: real spend Franklin never counted, so it
      // never reached --max-spend either.
      if (row.costUsd > 0) missingLocally.push(row);
      continue;
    }
    matched.push({ row, localUsd, deltaUsd: localUsd - row.costUsd });
  }

  return { matched, missingLocally, unjoinable, totals: summarize(ledger.rows), unavailableDays: ledger.unavailableDays };
}
