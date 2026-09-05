/**
 * WalletReservation accounting — ambiguous-settlement path (#128).
 * No network: every test injects a balance fetcher, and the postWithPayment
 * tests stub global fetch + the x402 signer.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { walletReservation, AMBIGUOUS_GRACE_MS } = await import('../dist/wallet/reservation.js');
const { postWithPayment, _setPaymentSignerForTests } = await import('../dist/tools/modal.js');

const fixed = (v) => async () => v;

test('markAmbiguous keeps the amount counted and survives a later release()', async () => {
  walletReservation._resetForTests(fixed(0.10));

  const a = await walletReservation.hold(0.06);
  assert.ok(a, 'first hold fits');
  assert.equal(await walletReservation.hold(0.06), null, 'second hold blocked by first');

  walletReservation.markAmbiguous(a, 1_000);
  walletReservation.release(a); // caller's finally — must be a no-op now

  const snap = walletReservation.snapshot();
  assert.equal(snap.count, 0);
  assert.equal(snap.ambiguousCount, 1);
  assert.equal(snap.totalUsd, 0.06, 'ambiguous spend still counted against headroom');
  assert.equal(await walletReservation.hold(0.06), null, 'cap errs tight, not loose');
});

test('markAmbiguous is idempotent and release-then-mark does not resurrect a hold', async () => {
  walletReservation._resetForTests(fixed(0.10));
  const a = await walletReservation.hold(0.06);
  walletReservation.markAmbiguous(a, 1_000);
  walletReservation.markAmbiguous(a, 1_000);
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'second mark is a no-op');

  const b = await walletReservation.hold(0.03);
  walletReservation.release(b);
  walletReservation.markAmbiguous(b, 1_000);
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'released token cannot become ambiguous');
  assert.equal(walletReservation.snapshot().totalUsd, 0.06);
});

test('ambiguous holds self-heal only on a real balance read that started after the window', async (t) => {
  // This test checks a 1 ms boundary; wall-clock scheduling must not move it.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let fetches = 0;
  walletReservation._resetForTests(async () => { fetches++; return 0.10; });
  const a = await walletReservation.hold(0.06);
  assert.equal(fetches, 1);
  walletReservation.markAmbiguous(a, 5_000);

  // markAmbiguous invalidated the cache: the next hold refetches, but the
  // window is still open so the entry survives the read.
  assert.equal(await walletReservation.hold(0.06), null);
  assert.equal(fetches, 2, 'markAmbiguous forced a refetch');
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'inside the window: kept');

  // Just short of the window: still kept.
  walletReservation._ageAmbiguousForTests(4_999);
  walletReservation.invalidateBalance();
  assert.equal(await walletReservation.hold(0.06), null);
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'boundary: kept until expiresAt <= read start');

  // Past the window: the next real read prunes it.
  walletReservation._ageAmbiguousForTests(2);
  walletReservation.invalidateBalance();
  const b = await walletReservation.hold(0.06);
  assert.ok(b, 'hold succeeds once the ambiguous entry is pruned');
  assert.equal(walletReservation.snapshot().ambiguousCount, 0);
  walletReservation.release(b);
});

test('a failed balance read (Infinity fallback) never prunes ambiguous entries', async () => {
  walletReservation._resetForTests(fixed(0.10));
  const a = await walletReservation.hold(0.06);
  walletReservation.markAmbiguous(a, 0); // window already closed

  walletReservation._resetForTests(async () => { throw new Error('rpc down'); });
  // _resetForTests cleared state; re-create the expired ambiguous entry.
  walletReservation._seedBalanceForTests(0.10);
  const b = await walletReservation.hold(0.06);
  walletReservation.markAmbiguous(b, 0);
  walletReservation.invalidateBalance();

  const c = await walletReservation.hold(0.06); // fetch throws -> Infinity -> hold allowed
  assert.ok(c, 'Infinity fallback does not block');
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'but it must not prune on a read that reflects nothing');
  walletReservation.release(c);
});

test('a read that STARTED inside the window does not prune even if it resolves after', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  walletReservation._resetForTests(async () => { await gate; return 0.10; });
  walletReservation._seedBalanceForTests(0.10);
  const a = await walletReservation.hold(0.06);
  walletReservation.markAmbiguous(a, 50);
  const pending = walletReservation.hold(0.06); // read starts now, inside window
  await new Promise((r) => setTimeout(r, 80)); // window closes while read is in flight
  release();
  assert.equal(await pending, null);
  assert.equal(walletReservation.snapshot().ambiguousCount, 1, 'F5: clock sampled at read start');
});

test('markAmbiguous is a no-op for free tokens and unknown ids', () => {
  walletReservation._resetForTests(fixed(1));
  walletReservation.markAmbiguous({ id: 'free-x', amountUsd: 0 });
  walletReservation.markAmbiguous('res-does-not-exist');
  walletReservation.markAmbiguous(null);
  assert.equal(walletReservation.snapshot().ambiguousCount, 0);
});

// ─── postWithPayment: which failures are ambiguous ────────────────────────

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; _setPaymentSignerForTests(null); });

function res402() {
  return new Response(JSON.stringify({ accepts: [] }), { status: 402, headers: { 'content-type': 'application/json' } });
}
/** fetch stub: first call 402, second call runs `paid(signal)`. */
function stubFetch(paid) {
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    n++;
    if (n === 1) return res402();
    return paid(init.signal);
  };
}
const hangUntilAbort = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => {
    const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e);
  }, { once: true });
});

async function runPaid({ paid, timeoutMs = 60, signer, parent = new AbortController() }) {
  walletReservation._resetForTests(fixed(1));
  _setPaymentSignerForTests(signer ?? (async () => ({ 'PAYMENT-SIGNATURE': 'sig' })));
  stubFetch(paid);
  const token = await walletReservation.hold(0.25);
  let threw = null;
  try {
    await postWithPayment('https://gateway.invalid/modal/create', {}, 'test', parent.signal, timeoutMs, token);
  } catch (e) { threw = e; }
  walletReservation.release(token); // the caller's finally
  return { threw, snap: walletReservation.snapshot(), token };
}

test('timeout after the signed request is dispatched -> ambiguous, hold kept', async () => {
  const { threw, snap } = await runPaid({ paid: hangUntilAbort, timeoutMs: 30 });
  assert.ok(threw, 'postWithPayment still throws');
  assert.equal(snap.ambiguousCount, 1);
  assert.equal(snap.ambiguousUsd, 0.25);
  assert.equal(snap.count, 0, 'moved out of the live reservation set');
});

test('ambiguous window is sized by the call timeout + margin', async () => {
  const { token } = await runPaid({ paid: hangUntilAbort, timeoutMs: 30 });
  // Age by the base margin: still inside (window = 30ms + AMBIGUOUS_GRACE_MS).
  walletReservation._ageAmbiguousForTests(AMBIGUOUS_GRACE_MS - 5);
  walletReservation.invalidateBalance();
  assert.equal(await walletReservation.hold(0.9), null, 'still counted');
  walletReservation._ageAmbiguousForTests(100);
  walletReservation.invalidateBalance();
  assert.ok(await walletReservation.hold(0.9), 'pruned after timeout + margin');
  void token;
});

test('signal already aborted before dispatch -> NOT ambiguous (F2)', async () => {
  const parent = new AbortController();
  const signer = async () => { parent.abort(); return { 'PAYMENT-SIGNATURE': 'sig' }; };
  let paidCalled = false;
  const { threw, snap } = await runPaid({ paid: () => { paidCalled = true; return hangUntilAbort(new AbortController().signal); }, signer, parent });
  assert.ok(threw);
  assert.equal(paidCalled, false, 'paid request never dispatched');
  assert.equal(snap.ambiguousCount, 0);
  assert.equal(snap.totalUsd, 0, 'released normally');
});

test('connection refused on the paid request -> NOT ambiguous (F2)', async () => {
  const paid = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const { threw, snap } = await runPaid({ paid });
  assert.ok(threw);
  assert.equal(snap.ambiguousCount, 0);
  assert.equal(snap.totalUsd, 0);
});

test('paid 200 whose body is cut off -> throws and is ambiguous, not ok:true (F3)', async () => {
  const paid = async () => ({
    ok: true, status: 200,
    text: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  const { threw, snap } = await runPaid({ paid });
  assert.ok(threw, 'must not return { ok: true, body: {} }');
  assert.equal(snap.ambiguousCount, 1);
});

test('probe (unpaid) request failing -> nothing dispatched, nothing ambiguous', async () => {
  walletReservation._resetForTests(fixed(1));
  globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const token = await walletReservation.hold(0.25);
  await assert.rejects(() => postWithPayment('https://gateway.invalid/x', {}, 't', new AbortController().signal, 50, token));
  walletReservation.release(token);
  assert.equal(walletReservation.snapshot().totalUsd, 0);
});

test('paid request succeeds -> normal release, no ambiguity', async () => {
  const paid = async () => new Response(JSON.stringify({ sandbox_id: 'sb_1' }), { status: 200 });
  const { threw, snap } = await runPaid({ paid });
  assert.equal(threw, null);
  assert.equal(snap.ambiguousCount, 0);
  assert.equal(snap.totalUsd, 0);
});

// ── blockrun#140: a Solana zero is the SDK's error value, not a balance ─────

test('readSolanaBalance refuses to report a zero as a balance', async () => {
  const { readSolanaBalance } = await import('../dist/wallet/reservation.js');
  assert.equal(await readSolanaBalance(async () => 4.2), 4.2, 'a real balance passes through');
  await assert.rejects(() => readSolanaBalance(async () => 0), /treating the balance as unknown/,
    'zero is indistinguishable from an RPC failure and must not be reported');
  // A genuine transport error already threw before reaching us.
  await assert.rejects(() => readSolanaBalance(async () => { throw new Error('ECONNRESET'); }), /ECONNRESET/);
});

test('an untrustworthy balance read fails open instead of refusing every paid tool', async () => {
  walletReservation._resetForTests(async () => {
    throw new Error('Solana balance read returned 0 — treating the balance as unknown');
  });
  const token = await walletReservation.hold(0.04);
  assert.ok(token, 'an RPC blip must not block a paid call the payment layer would accept');
  walletReservation.release(token);
});

test('an untrustworthy read does not prune ambiguous holds', async () => {
  // The second half of #140: pruning against a fake 0 would drop a settlement
  // that may really have landed, freeing headroom that is not free.
  let mode = 'ok';
  walletReservation._resetForTests(async () => {
    if (mode === 'ok') return 0.10;
    throw new Error('treating the balance as unknown');
  });

  const a = await walletReservation.hold(0.06);
  assert.ok(a);
  walletReservation.markAmbiguous(a, 1_000);
  assert.equal(walletReservation.snapshot().ambiguousCount, 1);

  // Age the entry past its window, then read a balance that reflects nothing.
  walletReservation._ageAmbiguousForTests(5_000);
  mode = 'unknown';
  await walletReservation.hold(0.001);

  assert.equal(walletReservation.snapshot().ambiguousCount, 1,
    'an ambiguous hold must survive a read that could not see it');
});
