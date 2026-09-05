/**
 * API-key payment mode — resolution, isolation from wallet mode, and the
 * local pricing that replaces the x402 charge the key gateway never reports.
 *
 * HOME is redirected to a temp dir BEFORE any import, because config.ts
 * resolves BLOCKRUN_DIR from os.homedir() at module load. Without this the
 * suite would read and write the developer's real ~/.blockrun.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'franklin-apikey-'));
process.env.HOME = TEST_HOME;
delete process.env.BLOCKRUN_API_KEY;
delete process.env.RUNCODE_CHAIN;
process.env.FRANKLIN_NO_AUDIT = '1';

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const auth = await import('../dist/payments/auth-mode.js');
const { API_URLS, KEY_API_URL, BLOCKRUN_DIR, saveChain } = await import('../dist/config.js');
const { redactSecrets } = await import('../dist/agent/secret-redact.js');
const catalog = await import('../dist/payments/price-catalog.js');
const { GATEWAY_TRANSACTION_FEE_USD } = await import('../dist/gateway-models.js');

// Synthetic — shaped like a real key so the format checks are meaningful, but
// not a credential. Never put a live key in a tracked file.
const VALID_KEY = 'brk_live_0000TESTKEYNOTREAL0000000000000000000';
const KEY_FILE = join(BLOCKRUN_DIR, 'api-key');

function clean() {
  delete process.env.BLOCKRUN_API_KEY;
  rmSync(KEY_FILE, { force: true });
  auth.resetPayModeCache();
}

function writeKeyFile(key) {
  mkdirSync(BLOCKRUN_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key + '\n');
  auth.resetPayModeCache();
}

test('Messages API credit refusal never invokes wallet signing', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  const { ModelClient } = await import('../dist/agent/llm.js');
  const client = new ModelClient({ apiUrl: KEY_API_URL, chain: 'solana' });
  const nativeFetch = globalThis.fetch;
  let signed = false;
  let requests = 0;
  client.signPayment = async () => { signed = true; return null; };
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: { message: 'Account credits exhausted' } }, { status: 402 });
  };
  try {
    const events = [];
    for await (const event of client.streamCompletion({ model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 })) events.push(event);
    assert.equal(signed, false);
    assert.equal(requests, 1);
    assert.match(events.find(event => event.kind === 'error')?.payload.message ?? '', /credits exhausted/);
  } finally {
    globalThis.fetch = nativeFetch;
    clean();
  }
});

// ─── Backward compatibility: no key means nothing changes ───────────────
//
// This is the guarantee the whole feature rests on. If it ever fails, every
// existing wallet user's traffic has silently moved hosts.

test('no key configured — wallet mode resolves to today exact host, per chain', () => {
  clean();

  saveChain('solana');
  auth.resetPayModeCache();
  let mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'wallet');
  assert.equal(mode.apiBase, API_URLS.solana);
  assert.equal(auth.gatewayBase(), 'https://sol.blockrun.ai/api');

  saveChain('base');
  auth.resetPayModeCache();
  mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'wallet');
  assert.equal(mode.apiBase, API_URLS.base);
  assert.equal(auth.gatewayBase(), 'https://blockrun.ai/api');
});

test('no key configured — gateway headers carry no Authorization', () => {
  clean();
  const headers = auth.gatewayHeaders();
  assert.equal('Authorization' in headers, false);
  assert.ok(headers['User-Agent'], 'User-Agent is still set');
});

test('isKeyMode is false with no key', () => {
  clean();
  assert.equal(auth.isKeyMode(), false);
});

// ─── Key mode ───────────────────────────────────────────────────────────

test('key on disk switches host to the key gateway and drops /api', () => {
  clean();
  writeKeyFile(VALID_KEY);

  const mode = auth.resolvePayMode();
  assert.equal(mode.kind, 'key');
  assert.equal(mode.apiBase, KEY_API_URL);
  assert.equal(auth.gatewayBase(), 'https://api.blockrun.ai');
  // The key host 404s `wrong_host` on /api/v1/... — the base must not carry it.
  assert.equal(auth.gatewayBase().endsWith('/api'), false);
  assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
  clean();
});

test('BLOCKRUN_API_KEY takes precedence over the key file', () => {
  clean();
  writeKeyFile('brk_live_fromdiskAAAAAAAAAAAAAAAAAAAAAAAA');
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  assert.equal(auth.loadApiKey(), VALID_KEY);
  assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
  clean();
});

test('useWalletMode overrides a configured key', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.equal(auth.isKeyMode(), true);

  auth.useWalletMode();
  assert.equal(auth.isKeyMode(), false);
  assert.equal('Authorization' in auth.gatewayHeaders(), false);
  clean();
});

test('invalidateKey refreshes credentials without changing the payment method', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.equal(auth.isKeyMode(), true);

  auth.invalidateKey();
  assert.equal(auth.isKeyMode(), true, 'only an explicit wallet selection changes payment method');
  clean();
});

test('a malformed configured key fails before any wallet fallback', () => {
  clean();
  // Truncated paste — sending this would produce a confusing 401 on the first
  // paid call instead of an obvious "that is not a key" at configure time.
  process.env.BLOCKRUN_API_KEY = 'brk_live_short';
  auth.resetPayModeCache();
  assert.throws(() => auth.isKeyMode(), /BLOCKRUN_API_KEY/);
  clean();
});

test('isApiKeyShaped accepts live and test keys, rejects other prefixes', () => {
  assert.equal(auth.isApiKeyShaped(VALID_KEY), true);
  assert.equal(auth.isApiKeyShaped('brk_test_' + 'a'.repeat(24)), true);
  assert.equal(auth.isApiKeyShaped('sk-proj-' + 'a'.repeat(40)), false);
  assert.equal(auth.isApiKeyShaped('brk_live_tooshort'), false);
  assert.equal(auth.isApiKeyShaped(''), false);
});

test('maskApiKey never reveals the secret tail beyond four characters', () => {
  const masked = auth.maskApiKey(VALID_KEY);
  assert.ok(masked.startsWith('brk_live_'));
  assert.equal(masked.includes(VALID_KEY), false);
  assert.ok(masked.endsWith(VALID_KEY.slice(-4)));
});

// ─── Fallback classification ────────────────────────────────────────────

test('classifies account failures without choosing a payment method', () => {
  assert.equal(auth.classifyKeyFailure(401, '{"code":"invalid_api_key"}'), 'invalid-key');
  assert.equal(
    auth.classifyKeyFailure(404, '{"code":"unsupported_endpoint"}'),
    'unsupported-endpoint'
  );
  // A malformed request must NOT be retried on the wallet — that would spend
  // real USDC on a call that was always going to fail.
  assert.equal(auth.classifyKeyFailure(400, '{"error":"Invalid request body"}'), null);
  assert.equal(auth.classifyKeyFailure(402, '{"error":"Payment Required"}'), null);
  assert.equal(auth.classifyKeyFailure(500, 'boom'), null);
  assert.equal(auth.classifyKeyFailure(404, '{"error":"Not Found"}'), null);
});

test('toWalletUrl moves a key-host URL onto the chain host, restoring /api', () => {
  assert.equal(
    auth.toWalletUrl('https://api.blockrun.ai/v1/exa/search', 'solana'),
    'https://sol.blockrun.ai/api/v1/exa/search'
  );
  assert.equal(
    auth.toWalletUrl('https://api.blockrun.ai/v1/chat/completions', 'base'),
    'https://blockrun.ai/api/v1/chat/completions'
  );
  // Already a wallet URL — left alone.
  assert.equal(
    auth.toWalletUrl('https://blockrun.ai/api/v1/models', 'base'),
    'https://blockrun.ai/api/v1/models'
  );
});


// ─── Forwarded-request auth (the payment proxy) ─────────────────────────

test('applyGatewayAuth replaces a client Authorization header, whatever its case', () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  // Node lowercases inbound header names. Before this was case-insensitive the
  // proxy sent BOTH `authorization` and `Authorization`, the gateway read the
  // client's, and every proxied call 401'd.
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer sk-ant-client-key',
    'X-Franklin-Version': '1',
  };
  auth.applyGatewayAuth(headers);

  const authKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization');
  assert.equal(authKeys.length, 1, 'exactly one Authorization header may survive');
  assert.equal(headers[authKeys[0]], `Bearer ${VALID_KEY}`);
  assert.equal(headers['content-type'], 'application/json', 'other headers are untouched');
  clean();
});

test('applyGatewayAuth leaves a client Authorization alone in wallet mode', () => {
  clean();
  // Wallet mode contributes no credential — payment rides on the 402 retry —
  // so stripping the client's header here would break plain pass-through.
  const headers = { authorization: 'Bearer sk-ant-client-key' };
  auth.applyGatewayAuth(headers);
  assert.equal(headers.authorization, 'Bearer sk-ant-client-key');
});

// ─── Secret redaction ───────────────────────────────────────────────────

test('a BlockRun API key is redacted from text', () => {
  const { redactedText, matches } = redactSecrets(`my key is ${VALID_KEY} ok`);
  assert.equal(redactedText.includes(VALID_KEY), false, 'the key must not survive redaction');
  assert.ok(matches.some((m) => m.label === 'blockrun_api_key'));
});

test('redaction does not fire on ordinary text that merely starts with brk', () => {
  const { matches } = redactSecrets('brk_live_ is a prefix, and brkfast is a word');
  assert.equal(matches.some((m) => m.label === 'blockrun_api_key'), false);
});

// ─── Price catalog ──────────────────────────────────────────────────────

test('priceForPath matches with or without the /api prefix and a query string', () => {
  catalog.__resetPriceCatalog();
  const withApi = catalog.priceForPath('/api/v1/surf/market/ranking');
  const withoutApi = catalog.priceForPath('/v1/surf/market/ranking');
  const withQuery = catalog.priceForPath('/v1/surf/market/ranking?symbol=BTC');
  assert.equal(withApi, withoutApi);
  assert.equal(withApi, withQuery);
  assert.ok(withApi > 0, 'surf is a paid endpoint');
});

test('priceForPath accepts a full gateway URL from either host', () => {
  catalog.__resetPriceCatalog();
  const viaKeyHost = catalog.priceForPath('https://api.blockrun.ai/v1/rpc/base');
  const viaWalletHost = catalog.priceForPath('https://blockrun.ai/api/v1/rpc/base');
  assert.equal(viaKeyHost, viaWalletHost);
  assert.ok(viaKeyHost > 0);
});

test('a more specific pattern beats a wildcard', () => {
  catalog.__primePriceCatalog([
    { endpoint: '/api/v1/modal/*', usd: 0.002 },
    { endpoint: '/api/v1/modal/sandbox/create', usd: 0.011 },
  ]);
  assert.equal(catalog.priceForPath('/v1/modal/sandbox/create'), 0.011);
  assert.equal(catalog.priceForPath('/v1/modal/sandbox/exec'), 0.002);
  catalog.__resetPriceCatalog();
});

test('free endpoints price at zero, unknown endpoints price as null', () => {
  catalog.__resetPriceCatalog();
  assert.equal(catalog.priceForPath('/v1/models'), 0);
  assert.equal(catalog.priceForPath('/v1/crypto/price/BTC'), 0);
  // Chat is model-priced; gateway-models.ts owns it, so the catalog declines.
  assert.equal(catalog.priceForPath('/v1/chat/completions'), null);
});

test('resolveCharge prefers a gateway charge, then a settlement, then the catalog', () => {
  catalog.__resetPriceCatalog();

  const settled = catalog.resolveCharge({
    apiPath: '/v1/surf/market/ranking', settledUsd: 0.0085, reportedUsd: 0.02,
  });
  assert.equal(settled.usd, 0.0085);
  assert.equal(settled.estimated, false, 'a settled x402 amount is exact');

  // This used to assert reportedUsd was exact. It is not: an upstream's own
  // costDollars is its cost, not BlockRun's charge — see the dedicated test
  // below. x-blockrun-cost-usd replaced it as the authority.
  const charged = catalog.resolveCharge({
    apiPath: '/v1/exa/search', chargedUsd: 0.01, reportedUsd: 0.007,
  });
  assert.equal(charged.usd, 0.01);
  assert.equal(charged.estimated, false, 'the gateway stating its charge is exact');

  const listed = catalog.resolveCharge({ apiPath: '/v1/surf/market/ranking' });
  assert.ok(listed.usd > 0, 'key-mode calls must never record zero for paid work');
  assert.equal(listed.estimated, true, 'a catalog price is an estimate');
});

test('resolveCharge falls back to a caller list price for an uncatalogued path', () => {
  catalog.__primePriceCatalog([{ endpoint: '/api/v1/surf/*', usd: 0.0085 }]);
  const charge = catalog.resolveCharge({ apiPath: '/v1/nonexistent/thing', fallbackUsd: 0.05 });
  assert.equal(charge.usd, 0.05);
  assert.equal(charge.estimated, true);
  catalog.__resetPriceCatalog();
});


test('the price catalog is read from the Base origin, the only host that publishes one', async () => {
  // Not a style assertion, and not "Base is the only one with prices" — sol
  // publishes prices too, in openapi.json under x-payment-info. Base is the
  // only host serving the services[] shape parsePricing reads, and sol's
  // published numbers currently disagree with what sol quotes and settles
  // ($0.001 published vs $0.0075 charged for surf fear-greed, measured
  // 2026-09-05). Repointing this per-host pins every estimate to the static
  // floor; switching to sol's sheet makes estimates worse. The comment on
  // CATALOG_URL carries all three numbers.
  const src = await readFile(
    new URL('../dist/payments/price-catalog.js', import.meta.url), 'utf-8'
  );
  assert.match(src, /https:\/\/blockrun\.ai\/\.well-known\/x402/);
  assert.doesNotMatch(
    src, /https:\/\/sol\.blockrun\.ai\/\.well-known/,
    'the sol origin publishes no prices — fetching it yields a permanently stale catalog'
  );
  // A 200 carrying no services[] must be reported, never swallowed.
  assert.match(src, /returned no services/);
});


// ─── The gateway's own charge header ────────────────────────────────────

const hdr = (v) => ({ headers: { get: (n) => (n === 'x-blockrun-cost-usd' && v !== undefined ? v : null) } });

test('chargeFromResponse treats 0 as a value and everything malformed as absent', () => {
  assert.equal(catalog.chargeFromResponse(hdr('0.010000')), 0.01);
  // A charge that genuinely settled at zero is written explicitly, and must be
  // distinguishable from a response that states no charge at all.
  assert.equal(catalog.chargeFromResponse(hdr('0.000000')), 0);
  assert.equal(catalog.chargeFromResponse(hdr(undefined)), null, 'absent');
  // Number('') is 0 in JS — booking that against a billed call is the bug.
  assert.equal(catalog.chargeFromResponse(hdr('')), null, 'empty is absent, not zero');
  assert.equal(catalog.chargeFromResponse(hdr('   ')), null);
  assert.equal(catalog.chargeFromResponse(hdr('abc')), null, 'malformed is absent');
  assert.equal(catalog.chargeFromResponse(hdr('-1')), null, 'negative is absent');
});

test('remainingCreditFromResponse follows the same rules', () => {
  const rc = (v) => ({ headers: { get: (n) => (n === 'x-blockrun-credit-remaining-usd' ? v : null) } });
  assert.equal(catalog.remainingCreditFromResponse(rc('41.998000')), 41.998);
  assert.equal(catalog.remainingCreditFromResponse(rc('0.000000')), 0, 'a real zero balance');
  // Absent on ungated accounts, which have no ceiling. Correct, not a failure.
  assert.equal(catalog.remainingCreditFromResponse(rc(null)), null);
  assert.equal(catalog.remainingCreditFromResponse(rc('')), null);
});

test('a gateway-stated charge outranks every other source, including zero', () => {
  catalog.__resetPriceCatalog();
  const c = catalog.resolveCharge({
    apiPath: '/v1/exa/search', chargedUsd: 0.01, settledUsd: 0.02, reportedUsd: 0.007,
  });
  assert.equal(c.usd, 0.01);
  assert.equal(c.estimated, false);

  // 0 must not be swallowed by a truthiness check.
  const zero = catalog.resolveCharge({ apiPath: '/v1/exa/search', chargedUsd: 0, fallbackUsd: 0.05 });
  assert.equal(zero.usd, 0, 'an explicit zero charge is authoritative');
  assert.equal(zero.estimated, false);
});

test("an upstream's self-reported cost is not what BlockRun charged", () => {
  catalog.__resetPriceCatalog();
  // Measured 2026-09-05: Exa reported costDollars $0.007 on a call the gateway
  // charged $0.010 for. Booking $0.007 as exact was a wrong number carrying
  // false confidence — worse than a hedged one.
  const c = catalog.resolveCharge({ apiPath: '/v1/exa/search', reportedUsd: 0.007 });
  assert.equal(c.estimated, true, 'a provider-reported cost is an estimate, not a charge');
  assert.ok(c.usd > 0);
});


// ─── Prices restated in model-facing tool descriptions ──────────────────

test('a price quoted in a tool description is the base, not the wallet quote', async () => {
  // These strings are what the AGENT reads to decide whether a call is worth
  // making, so a stale one changes spending behaviour, not just docs.
  //
  // There are TWO real prices per endpoint and one literal cannot serve both:
  // the API-key rail charges the base, the wallet rail adds a settlement fee,
  // and the 402 challenge / catalog both quote the wallet figure. Measured
  // 2026-09-05 via x-blockrun-cost-usd — surf $0.0075 vs $0.0085, rpc $0.0020
  // vs $0.0030, exa $0.0100 vs $0.0110, defillama $0.0050 vs $0.0060 — exactly
  // one fee apart every time. The descriptions state the base and name the fee
  // separately, which is true on either rail.
  //
  // Reads the built spec.description rather than the source file, so a comment
  // recording what a price USED to be does not trip it.
  catalog.__resetPriceCatalog();

  const rpc = await import('../dist/tools/rpc.js');
  const llama = await import('../dist/tools/defillama.js');
  const exa = await import('../dist/tools/exa.js');

  const cases = [
    [rpc.multiChainRpcCapability, '/v1/rpc/base'],
    [llama.defiLlamaProtocolsCapability, '/v1/defillama/protocols'],
    [exa.exaSearchCapability, '/v1/exa/search'],
    [exa.exaReadUrlsCapability, '/v1/exa/contents'],
  ].filter(([cap]) => cap && cap.spec);
  assert.ok(cases.length >= 3, 'found the capabilities to check');

  for (const [cap, probePath] of cases) {
    const base = catalog.basePriceForPath(probePath);
    assert.ok(base > 0, `${probePath} should have a base price`);
    // The fee is named as its own figure, so ignore it when checking the price.
    const quoted = [...cap.spec.description.matchAll(/\$(\d+\.\d{3,4})/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Math.abs(n - 0.001) > 1e-9);
    for (const q of quoted) {
      assert.ok(
        Math.abs(q - base) < 0.0005,
        `${cap.spec.name} quotes $${q}; the base price for ${probePath} is $${base}`
      );
    }
    assert.match(cap.spec.description, /settlement fee/, `${cap.spec.name} names the wallet-rail fee`);
    // The fee figure needs an owner too. The gateway's constant has moved
    // before — 0.001 to 0.002 and back — so a description that bakes it drifts
    // on the next move exactly like the prices did.
    const feeQuoted = [...cap.spec.description.matchAll(/\$(\d+\.\d{3,4})\s*settlement fee/g)]
      .map((m) => Number(m[1]));
    for (const f of feeQuoted) {
      assert.ok(
        Math.abs(f - GATEWAY_TRANSACTION_FEE_USD) < 1e-9,
        `${cap.spec.name} states a $${f} settlement fee; the constant is $${GATEWAY_TRANSACTION_FEE_USD}`
      );
    }
  }
});

test('basePriceForPath is the catalog price less exactly one settlement fee', () => {
  catalog.__resetPriceCatalog();
  const wallet = catalog.priceForPath('/v1/surf/market/ranking');
  const base = catalog.basePriceForPath('/v1/surf/market/ranking');
  assert.ok(Math.abs((wallet - base) - 0.001) < 1e-9, 'one fee apart');
  // Free endpoints stay free on both rails rather than going negative.
  assert.equal(catalog.basePriceForPath('/v1/models'), 0);
});

test('surf quotes one flat price, computed rather than typed', async () => {
  catalog.__resetPriceCatalog();
  const surf = await import('../dist/tools/surf.js');
  const desc = surf.surfMarketCapability.spec.description;

  // The tier sentence was wrong in both directions at once: 8.5x under on
  // tier 1, 2.4x over on tier 3.
  assert.doesNotMatch(desc, /Tier-1/, 'the stale tier sentence is gone from the live description');
  const base = catalog.basePriceForPath('/v1/surf/market/ranking');
  assert.match(desc, new RegExp(`\\$${base.toFixed(4)}`), 'states the base price');
  assert.match(desc, /settlement fee/, 'and names the wallet-rail fee separately');
});

// ── Credential containment ────────────────────────────────────────────────
// The key spends against a prepaid balance with no per-call signature, so it
// gets the same containment the wallet private keys already had.

test('the API key never reaches a Bash subprocess', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  const { bashCapability } = await import('../dist/tools/bash.js');
  const ctx = { workingDir: TEST_HOME, abortSignal: new AbortController().signal };

  // printenv and echo are auto-approved by bash-guard, so this is the exact
  // command that needed no confirmation before the fix.
  const printed = await bashCapability.execute({ command: 'printenv BLOCKRUN_API_KEY || echo ABSENT' }, ctx);
  assert.ok(!printed.output.includes(VALID_KEY), 'key must not appear in Bash output');
  assert.match(printed.output, /ABSENT/, 'the variable is unset in the child, not merely empty');

  // The parent process still has it — Franklin's own gateway calls read
  // process.env in-process and must be unaffected.
  assert.equal(process.env.BLOCKRUN_API_KEY, VALID_KEY, 'parent env is untouched');
  clean();
});

test('the on-disk API key is guarded like a wallet private key', async () => {
  const { isWalletKeyPath, WALLET_KEY_PATHS } = await import('../dist/tools/sensitive-paths.js');
  assert.equal(isWalletKeyPath(KEY_FILE), true, '~/.blockrun/api-key must be protected');
  assert.ok(WALLET_KEY_PATHS.includes(KEY_FILE), 'and listed among the guarded paths');
  // Not a blanket ban on the directory.
  assert.equal(isWalletKeyPath(join(BLOCKRUN_DIR, 'sessions.json')), false);
  assert.equal(isWalletKeyPath(KEY_FILE + '.bak'), false, 'exact file only, not siblings');
});

test('tool output is scrubbed of a key that reaches it by any route', async () => {
  const { redactSecretsInOutput } = await import('../dist/agent/secret-redact.js');

  // Pattern route: a brk_ key embedded in output nobody vetted.
  const shaped = redactSecretsInOutput(`config: BLOCKRUN_API_KEY=${VALID_KEY} done`);
  assert.ok(!shaped.text.includes(VALID_KEY), 'shaped key is removed');
  assert.match(shaped.text, /\[REDACTED:blockrun_api_key\]/);
  assert.ok(shaped.labels.includes('blockrun_api_key'));

  // Literal route: a configured key that does not match a published shape
  // still gets scrubbed, because the caller passes the live value.
  const odd = 'legacy-key-not-brk-shaped-01234567';
  const literal = redactSecretsInOutput(`token=${odd}`, [odd]);
  assert.ok(!literal.text.includes(odd), 'configured literal is removed');
  assert.ok(literal.labels.includes('configured_credential'));

  // Every occurrence, not just the first.
  const twice = redactSecretsInOutput(`${VALID_KEY} and again ${VALID_KEY}`);
  assert.ok(!twice.text.includes(VALID_KEY), 'all occurrences removed');

  // Clean output is returned untouched, and a blank/short literal cannot
  // blank out the text.
  const clean1 = redactSecretsInOutput('nothing secret here', ['', '   ', 'ab']);
  assert.equal(clean1.text, 'nothing secret here');
  assert.deepEqual(clean1.labels, []);
});

test('the tool-result funnel actually applies the redactor', async () => {
  // The unit test above proves redactSecretsInOutput works. This proves it is
  // wired: streaming-executor is the single choke point every tool result
  // passes through, and the scrub must happen BEFORE the persist-to-disk
  // branch or an oversized result would be written to disk unredacted.
  const src = await readFile(new URL('../dist/agent/streaming-executor.js', import.meta.url), 'utf-8');
  // Anchor on the assignment that applies the scrub and on the persist CALL
  // SITE (`output: persistLargeResult(`), not the function definition near
  // the top of the file.
  const applied = src.indexOf('output: redacted.text');
  const persistCall = src.indexOf('output: persistLargeResult(');
  assert.ok(applied > 0, 'streaming-executor must apply the redacted output to the result');
  assert.ok(persistCall > 0, 'sanity: the persist call site still exists');
  assert.ok(applied < persistCall, 'redaction must run before the result is persisted to disk');
});

test('key mode does not gate Modal on a wallet balance it does not have', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.equal(auth.isKeyMode(), true, 'precondition: key mode is active');

  const { walletReservation } = await import('../dist/wallet/reservation.js');
  walletReservation._resetForTests(); // real balance path, empty cache

  // Record what the balance read actually asks for. Asserting on this is what
  // makes the test see the branch: if key mode fell through to the wallet
  // path it would talk to a chain RPC and never request /v1/credits.
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url instanceof Request ? url.url : url));
    return new Response(
      JSON.stringify({ account_id: 'acct_test', billing_mode: 'prepaid', currency: 'USD',
                       granted_usd: 50, spent_usd: 10, remaining_usd: 40, blocked: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    // No wallet exists under this temp HOME. Before the fix the balance read
    // resolved to $0 and hold() refused every Modal call.
    const token = await walletReservation.hold(0.01);
    assert.ok(seen.some((u) => u.includes('/v1/credits')),
      `balance must come from the credit endpoint, got: ${JSON.stringify(seen)}`);
    assert.ok(token, 'a $0.01 hold must succeed against $40 of credit');
    walletReservation.release(token);

    // And the ceiling is real, not merely absent: $40 of credit refuses $41.
    walletReservation._resetForTests();
    assert.equal(await walletReservation.hold(41), null, 'a known credit balance still bounds holds');
  } finally {
    globalThis.fetch = realFetch;
    walletReservation._resetForTests();
    clean();
  }
});

test('an ungated account has no local ceiling rather than a zero one', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  const { walletReservation } = await import('../dist/wallet/reservation.js');
  walletReservation._resetForTests();

  const seen = [];
  const originalFetch = globalThis.fetch;
  // remaining_usd null is the documented ungated shape — never read as zero.
  globalThis.fetch = async (url) => {
    seen.push(String(url instanceof Request ? url.url : url));
    return new Response(
      JSON.stringify({ account_id: 'a', billing_mode: 'ungated', currency: 'USD',
                       granted_usd: 0, spent_usd: 9999, remaining_usd: null, blocked: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const token = await walletReservation.hold(5);
    assert.ok(seen.some((u) => u.includes('/v1/credits')), 'consulted the credit endpoint');
    assert.ok(token, 'an ungated account must not be told it is broke');
    walletReservation.release(token);
  } finally {
    globalThis.fetch = realFetch;
    walletReservation._resetForTests();
    clean();
  }
});

test('an unreachable credit endpoint does not strand a paying user', async () => {
  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();

  const { walletReservation } = await import('../dist/wallet/reservation.js');
  walletReservation._resetForTests();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    // fetchCreditBalance returns null on any failure. Falling back to a wallet
    // read here would reintroduce the bug; inventing $0 would be worse.
    const token = await walletReservation.hold(0.01);
    assert.ok(token, 'a gateway outage must not block a call the gateway would accept');
    walletReservation.release(token);
  } finally {
    globalThis.fetch = realFetch;
    walletReservation._resetForTests();
    clean();
  }
});

test('the system prompt does not promise a wallet in key mode', async () => {
  const { assembleInstructions } = await import('../dist/agent/context.js');

  clean();
  auth.resetPayModeCache();
  const walletPrompt = assembleInstructions(TEST_HOME).join('\n');

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  // Same workingDir on purpose: proves the instruction cache is keyed on the
  // pay mode and does not serve the wallet-mode prompt to a key-mode session.
  const keyPrompt = assembleInstructions(TEST_HOME).join('\n');
  clean();

  assert.match(walletPrompt, /agent with a wallet/, 'wallet mode keeps its identity line');
  assert.doesNotMatch(keyPrompt, /an autonomous AI agent with a wallet/,
    'key mode must not claim a wallet it does not have');
  assert.doesNotMatch(keyPrompt, /wallet pays automatically/,
    'key mode must not say the wallet pays');
  assert.match(keyPrompt, /account credits/, 'key mode names the real funding source');
  // The spend-without-hesitating posture survives the branch.
  assert.match(keyPrompt, /Don't hesitate on cents/);
});

// ── Billing copy ──────────────────────────────────────────────────────────
// These strings are the receipt the user reads, the prompt they approve, and
// the text the model reasons over when deciding what it can afford.

test('billing copy names the instrument that actually paid', async () => {
  const copy = await import('../dist/payments/billing-copy.js');

  clean();
  auth.resetPayModeCache();
  assert.match(copy.chargedNote(5), /\$5\.00 USDC charged/);
  assert.match(copy.noChargeNote(), /No USDC was spent/);
  assert.match(copy.cancelHint(), /No USDC is spent if you cancel/);
  assert.match(copy.receiptLine(0.005), /\$0\.0050 paid via x402/);

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  for (const s of [copy.chargedNote(5), copy.noChargeNote(), copy.cancelHint(), copy.receiptLine(0.005)]) {
    assert.doesNotMatch(s, /USDC/, `key mode must not say USDC: ${s}`);
    assert.doesNotMatch(s, /x402/, `key mode must not say x402: ${s}`);
  }
  assert.match(copy.chargedNote(5), /account credits/);
  // Key mode states no amount on a receipt: the local figure is an estimate
  // and the account ledger is authoritative.
  assert.doesNotMatch(copy.chargedNote(5), /\$5/, 'no local amount presented as the charge');
  // Sub-cent tiers must not render as $0.00 in wallet mode.
  clean();
  auth.resetPayModeCache();
  assert.match(copy.receiptLine(0.001), /\$0\.0010/);
  clean();
});

test('the mode is read at call time, not captured at import', async () => {
  // The mode can change mid-process, so a helper that memoised it at import
  // would keep printing "account credits" while Franklin signed from the
  // wallet. `--wallet` (useWalletMode) is the lever that actually flips it.
  //
  // Not invalidateKey(): since #158 that only refreshes a rejected credential
  // and deliberately does NOT demote to wallet billing, because an account
  // failure is never permission to spend from a wallet. Asserted below so this
  // test cannot drift back to the old assumption.
  const { chargedNote } = await import('../dist/payments/billing-copy.js');

  clean();
  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  auth.resetPayModeCache();
  assert.match(chargedNote(1), /account credits/);

  auth.invalidateKey();
  assert.match(chargedNote(1), /account credits/,
    'a rejected key must not silently move billing to the wallet');

  auth.useWalletMode();
  assert.match(chargedNote(1), /USDC charged/,
    'an explicit --wallet switch must change the copy immediately');
  clean();
  auth.resetPayModeCache();
});

test('no paid tool states a payment rail unconditionally', async () => {
  // Regression fence for the whole class. Every one of these was a live
  // string that fired in key mode before this change.
  const files = ['phone', 'prediction', 'videogen', 'imagegen', 'musicgen', 'voice', 'modal', 'blockrun', 'surf', 'realface', 'exa', 'rpc', 'defillama'];
  const offenders = [];
  for (const f of files) {
    const src = await readFile(new URL(`../src/tools/${f}.ts`, import.meta.url), 'utf-8');
    src.split('\n').forEach((line, i) => {
      if (/paid via x402|USDC charged|No USDC (is|was) spent|USDC from the user's wallet|wallet-owned/.test(line)) {
        offenders.push(`src/tools/${f}.ts:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `use the billing-copy helpers (or mode-neutral wording in static spec text):\n${offenders.join('\n')}`);
});

// ── Gateway host routing ──────────────────────────────────────────────────
// api.blockrun.ai authenticates a bearer key and 401s without one; the wallet
// hosts answer a 402 challenge and ignore a key. Telling the model they are
// aliases invites a request the receiving host cannot settle.

test('the system prompt names the one gateway host this session uses', async () => {
  const { assembleInstructions } = await import('../dist/agent/context.js');
  const section = () => {
    auth.resetPayModeCache();
    const all = assembleInstructions(TEST_HOME).join('\n');
    const i = all.indexOf('**Base URLs**');
    assert.ok(i > 0, 'Base URLs section must exist');
    return all.slice(i, all.indexOf('**Discovery', i));
  };

  clean();
  process.env.RUNCODE_CHAIN = 'solana';
  let s = section();
  assert.match(s, /Your host: `https:\/\/sol\.blockrun\.ai\/api`/);
  assert.doesNotMatch(s, /Your host: `https:\/\/blockrun\.ai/);

  // Same process, different chain: the instruction cache must not serve the
  // previous chain's host.
  process.env.RUNCODE_CHAIN = 'base';
  s = section();
  assert.match(s, /Your host: `https:\/\/blockrun\.ai\/api`/,
    'a chain switch must re-render the host, not hit a stale cache entry');

  process.env.BLOCKRUN_API_KEY = VALID_KEY;
  s = section();
  assert.match(s, /Your host: `https:\/\/api\.blockrun\.ai`/);
  assert.match(s, /not an alias of the Base gateway/,
    'the account host must never be described as a wallet-gateway alias');

  delete process.env.RUNCODE_CHAIN;
  clean();
  auth.resetPayModeCache();
});

test('no mode is told the account host is an alias of a wallet host', async () => {
  const { assembleInstructions } = await import('../dist/agent/context.js');
  for (const setup of [
    () => { clean(); process.env.RUNCODE_CHAIN = 'solana'; },
    () => { clean(); process.env.RUNCODE_CHAIN = 'base'; },
    () => { clean(); process.env.BLOCKRUN_API_KEY = VALID_KEY; },
  ]) {
    setup();
    auth.resetPayModeCache();
    const all = assembleInstructions(TEST_HOME).join('\n');
    assert.doesNotMatch(all, /alias: `https:\/\/api\.blockrun\.ai`/,
      'api.blockrun.ai is a separate account service, not an alias');
  }
  delete process.env.RUNCODE_CHAIN;
  clean();
  auth.resetPayModeCache();
});

// ── /v1/usage reconciliation ──────────────────────────────────────────────
// The four properties that turn a careless read of this feed into a confident
// wrong answer: pending is not a settled zero, zero-cost rows are real answers,
// unavailable_days is a short read, and only chat is locally checkable.

const usageRow = (o) => ({
  request_id: o.id, timestamp: '2026-09-05T12:00:00Z', endpoint: o.endpoint ?? '/v1/exa/search',
  model: o.model ?? null, kind: o.kind ?? 'service', input_tokens: 0, output_tokens: 0,
  cost_usd: o.cost ?? 0.01, cost_state: o.state ?? 'priced', status: 200,
});

const realFetch = globalThis.fetch;

function mockUsage(pages) {
  let i = 0;
  globalThis.fetch = async (url) => {
    const u = String(url instanceof Request ? url.url : url);
    assert.match(u, /^https:\/\/api\.blockrun\.ai\/v1\/usage/, 'usage reads the account host only');
    return new Response(JSON.stringify(pages[i++]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('usage follows the cursor and never parses it', async () => {
  clean(); process.env.BLOCKRUN_API_KEY = VALID_KEY; auth.resetPayModeCache();
  const { fetchUsage } = await import('../dist/payments/usage.js');
  mockUsage([
    { object: 'list', data: [usageRow({ id: 'a' })], next_cursor: 'OPAQUE//token==', unavailable_days: [] },
    { object: 'list', data: [usageRow({ id: 'b' })], next_cursor: null, unavailable_days: [] },
  ]);
  const page = await fetchUsage({});
  globalThis.fetch = realFetch;
  assert.deepEqual(page.rows.map((r) => r.requestId), ['a', 'b'], 'both pages are read');
  clean();
});

test('pending is not a settled zero, and free rows are counted not hidden', async () => {
  const { summarize } = await import('../dist/payments/usage.js');
  const { fetchUsage } = await import('../dist/payments/usage.js');
  clean(); process.env.BLOCKRUN_API_KEY = VALID_KEY; auth.resetPayModeCache();
  mockUsage([{ object: 'list', next_cursor: null, unavailable_days: [], data: [
    usageRow({ id: 'p', cost: 0.02, state: 'priced' }),
    usageRow({ id: 'q', cost: 0, state: 'pending' }),
    usageRow({ id: 'f', cost: 0, state: 'free' }),
    usageRow({ id: 'x', cost: 0.5, state: 'weird-new-value' }),
  ] }]);
  const page = await fetchUsage({});
  globalThis.fetch = realFetch;

  const t = summarize(page.rows);
  assert.equal(t.pricedUsd, 0.02, 'only settled charges are summed');
  assert.equal(t.pendingCount, 2, 'an unrecognised state is pending, never priced');
  assert.equal(t.freeCount, 1, 'a free row is an answer and stays visible');
  assert.equal(page.rows.length, 4, 'zero-cost rows are never filtered out');
  clean();
});

test('unavailable_days is surfaced rather than read as a quiet period', async () => {
  clean(); process.env.BLOCKRUN_API_KEY = VALID_KEY; auth.resetPayModeCache();
  const { fetchUsage } = await import('../dist/payments/usage.js');
  mockUsage([{ object: 'list', data: [], next_cursor: null, unavailable_days: ['2026-09-01', '2026-09-02'] }]);
  const page = await fetchUsage({});
  globalThis.fetch = realFetch;
  assert.deepEqual(page.unavailableDays, ['2026-09-01', '2026-09-02']);
  clean();
});

test('reconcile joins on request_id and names what it could not check', async () => {
  const { reconcile } = await import('../dist/payments/usage.js');
  const ledger = {
    rows: [
      usageRow({ id: 'match', cost: 0.0075 }),
      usageRow({ id: 'drift', cost: 0.0100 }),
      usageRow({ id: 'orphan', cost: 0.0500 }),
      usageRow({ id: 'later', cost: 0.02, state: 'pending' }),
    ].map((r) => ({
      requestId: r.request_id, timestamp: r.timestamp, endpoint: r.endpoint, model: r.model,
      kind: r.kind, inputTokens: 0, outputTokens: 0, costUsd: r.cost_usd, costState: r.cost_state, status: 200,
    })),
    unavailableDays: [],
  };
  const local = [
    { requestId: 'match', costUsd: 0.0075 },
    { requestId: 'drift', costUsd: 0.0075 },
    { costUsd: 0.0075 }, // wallet-mode / pre-upgrade row: no id to join on
  ];
  const r = reconcile(ledger, local);

  assert.equal(r.matched.length, 2);
  assert.equal(r.matched.find((m) => m.row.requestId === 'match').deltaUsd, 0);
  assert.ok(Math.abs(r.matched.find((m) => m.row.requestId === 'drift').deltaUsd + 0.0025) < 1e-9,
    'a local underestimate shows as a negative delta');
  assert.deepEqual(r.missingLocally.map((x) => x.requestId), ['orphan'],
    'a charge with no local row is real spend that never reached --max-spend');
  assert.equal(r.unjoinable, 1, 'rows with no id are reported, not silently counted as agreeing');
  // A pending ledger row has no charge to disagree with yet.
  assert.ok(!r.matched.some((m) => m.row.requestId === 'later'));
});

test('the request id is captured into the local journal', async () => {
  const { requestIdFromResponse } = await import('../dist/payments/price-catalog.js');
  const withId = new Response('{}', { headers: { 'x-blockrun-request-id': ' 326d2e86-abc ' } });
  assert.equal(requestIdFromResponse(withId), '326d2e86-abc', 'trimmed');
  assert.equal(requestIdFromResponse(new Response('{}')), null, 'absent header is null, not empty string');
  assert.equal(requestIdFromResponse(new Response('{}', { headers: { 'x-blockrun-request-id': '  ' } })), null);
  assert.equal(requestIdFromResponse(new Response('{}', { headers: { 'x-blockrun-request-id': 'x'.repeat(200) } })), null,
    'an absurd value is refused rather than stored');
});

test('cleanup', () => {
  clean();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

for (const status of [401, 402, 404, 429, 500]) {
  test(`API ${status} preserves the selected account and never retries with a wallet`, async () => {
    clean();
    process.env.BLOCKRUN_API_KEY = VALID_KEY;
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(JSON.stringify({ code: status === 404 ? 'unsupported_endpoint' : 'rejected' }), { status });
    };
    try {
      const { postWithPayment } = await import('../dist/payments/post-with-payment.js');
      const result = await postWithPayment(`${KEY_API_URL}/v1/exa/search`, { query: 'test' }, 'test');
      assert.equal(calls.length, 1, 'account errors must never trigger a wallet request');
      assert.equal(result.status, status);
      assert.equal(result.settled, false);
      assert.equal(calls[0].headers.get('authorization'), `Bearer ${VALID_KEY}`);
      assert.equal(auth.resolvePayMode().kind, 'key');
    } finally {
      globalThis.fetch = realFetch;
      clean();
    }
  });
}

for (const source of ['env', 'file']) {
  for (const value of ['', '   ', 'not-a-key']) {
    test(`invalid ${source} configuration cannot silently select a wallet (${JSON.stringify(value)})`, () => {
      clean();
      try {
        if (source === 'env') process.env.BLOCKRUN_API_KEY = value;
        else writeKeyFile(value);
        assert.throws(() => auth.resolvePayMode(), /API.key|BLOCKRUN_API_KEY/i);
        auth.useWalletMode();
        assert.equal(auth.resolvePayMode().kind, 'wallet', 'explicit --wallet still works');
      } finally { clean(); }
    });
  }
}

test('saving, rotating and removing a key refreshes request credentials across both wallet chains', () => {
  clean();
  try {
    const secondKey = 'brk_test_' + 'b'.repeat(24);
    auth.saveApiKey(VALID_KEY);
    assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${VALID_KEY}`);
    auth.saveApiKey(secondKey);
    assert.equal(auth.gatewayHeaders().Authorization, `Bearer ${secondKey}`);
    assert.equal(auth.clearApiKey(), true);
    for (const chain of ['solana', 'base']) {
      saveChain(chain);
      auth.resetPayModeCache();
      assert.equal(auth.gatewayBase(), API_URLS[chain]);
      assert.equal('Authorization' in auth.gatewayHeaders(), false);
    }
  } finally { clean(); }
});
