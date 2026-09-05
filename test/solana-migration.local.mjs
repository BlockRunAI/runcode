/**
 * blockrun#119 — an upgrade must not silently change the active Solana wallet.
 *
 * HOME is redirected before any import: config.ts resolves BLOCKRUN_DIR from
 * os.homedir() at module load, and this suite writes wallet-shaped files.
 * It must never see the developer's real ~/.blockrun.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME = homedir();
const TEST_HOME = mkdtempSync(join(tmpdir(), 'franklin-solmig-'));
process.env.HOME = TEST_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const { BLOCKRUN_DIR } = await import('../dist/config.js');
const mig = await import('../dist/wallet/solana-migration.js');

assert.ok(BLOCKRUN_DIR.startsWith(TEST_HOME), `refusing to run against ${REAL_HOME}`);
mkdirSync(BLOCKRUN_DIR, { recursive: true });

const SESSION = join(BLOCKRUN_DIR, '.solana-session');
const LEGACY = join(BLOCKRUN_DIR, 'solana-wallet.json');

function newWallet() {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey) };
}
function clean() { rmSync(SESSION, { force: true }); rmSync(LEGACY, { force: true }); }

test('the active address is derived from the session key, not read from a file', () => {
  clean();
  const w = newWallet();
  writeFileSync(SESSION, w.secret + '\n');
  assert.equal(mig.activeSolanaAddress(), w.address);
});

test('no session file means no active wallet, and no wallet is created', () => {
  clean();
  assert.equal(mig.activeSolanaAddress(), null);
  // The whole point: a diagnostic must not have the side effect of creating
  // the wallet it is reporting on.
  assert.equal(existsSync(SESSION), false);
});

test('a corrupt session file reports no active wallet instead of throwing', () => {
  clean();
  writeFileSync(SESSION, 'not-a-base58-key');
  assert.equal(mig.activeSolanaAddress(), null);
});

test('a legacy wallet at a different address is reported as a divergence', async () => {
  clean();
  const active = newWallet();
  const legacy = newWallet();
  writeFileSync(SESSION, active.secret + '\n');
  writeFileSync(LEGACY, JSON.stringify({ address: legacy.address, privateKey: legacy.secret }));

  const d = await mig.detectSolanaWalletDivergence();
  assert.ok(d, 'a different legacy address must be surfaced — this is the #119 bug');
  assert.equal(d.active, active.address);
  assert.ok(d.alternatives.some((w) => w.address === legacy.address));

  const report = mig.formatDivergence(d);
  assert.match(report, new RegExp(active.address));
  assert.match(report, new RegExp(legacy.address));
  assert.doesNotMatch(report, new RegExp(legacy.secret), 'never print a secret key');
  assert.doesNotMatch(report, new RegExp(active.secret), 'never print a secret key');
});

test('a legacy wallet holding the SAME address is not a divergence', async () => {
  clean();
  const w = newWallet();
  writeFileSync(SESSION, w.secret + '\n');
  writeFileSync(LEGACY, JSON.stringify({ address: w.address, privateKey: w.secret }));
  assert.equal(await mig.detectSolanaWalletDivergence(), null, 'same wallet in both files is fine');
});

test('a lying address field cannot fabricate a divergence', async () => {
  clean();
  const w = newWallet();
  const impostor = newWallet();
  writeFileSync(SESSION, w.secret + '\n');
  // File claims someone else's address while holding w's key. The address must
  // be derived from the key, so this is the active wallet and not a divergence.
  writeFileSync(LEGACY, JSON.stringify({ address: impostor.address, privateKey: w.secret }));
  const d = await mig.detectSolanaWalletDivergence();
  assert.equal(d, null, "the file's address field must not be trusted over the key");
});

test('no session file means nothing to diverge from', async () => {
  clean();
  const legacy = newWallet();
  writeFileSync(LEGACY, JSON.stringify({ address: legacy.address, privateKey: legacy.secret }));
  assert.equal(await mig.detectSolanaWalletDivergence(), null);
});

test('cleanup', () => { clean(); rmSync(TEST_HOME, { recursive: true, force: true }); });
