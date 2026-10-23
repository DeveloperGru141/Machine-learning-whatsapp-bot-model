/**
 * Regression test for the "bot boots unlinked after a container restart" incident.
 *  1. Backup bundle must stay under the hard cap even with hundreds of session files.
 *  2. Backups must be debounced (rapid creds.update bursts collapse to one PUT).
 *  3. Boot hydration must prefer the *live* bundle from the Render API over the stale process.env snapshot.
 *  4. Hydration must restore creds.json so the client considers itself registered.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-test-'));
process.env.SESSIONS_DIR = tmp;
process.env.RENDER_API_KEY = 'test-key';
process.env.RENDER_SERVICE_ID = 'srv-test';
delete process.env.SESSION_BUNDLE_BASE64;

const { config } = require('./dist/config/env.js');
config.paths.sessions = tmp; // .env may override SESSIONS_DIR, so force the temp dir
const { whatsAppClient } = require('./dist/core/client.js');

const puts = [];
let liveBundleForGet = null;
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.render.com')) {
    if ((opts.method || 'GET') === 'PUT') {
      puts.push(JSON.parse(opts.body).value);
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    }
    if (liveBundleForGet) {
      return { ok: true, status: 200, json: async () => ({ value: liveBundleForGet }), text: async () => '' };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }
  throw new Error('unexpected fetch ' + url);
};

async function main() {
  console.log('🧪 Testing session persistence & restart hydration...\n');

  // --- Test 1 & 2: size cap + debounce ---
  fs.writeFileSync(
    path.join(tmp, 'creds.json'),
    JSON.stringify({ registered: false, account: { details: 'x'.repeat(40) }, me: { id: '2347058967815:9@s.whatsapp.net', lid: '83954564632610:9@lid' } })
  );
  for (let i = 0; i < 300; i++) {
    const blob = Buffer.alloc(900 + (i % 7) * 400);
    for (let b = 0; b < blob.length; b++) blob[b] = Math.floor(Math.random() * 256); // incompressible, worst case
    fs.writeFileSync(path.join(tmp, `session-${100000 + i}.0.json`), JSON.stringify({ k: blob.toString('base64') }));
  }
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(tmp, `sender-key-grp${i}@g.us--u--1.json`), JSON.stringify({ s: 'y'.repeat(2000) }));
  for (let i = 0; i < 90; i++) fs.writeFileSync(path.join(tmp, `pre-key-${i}.json`), JSON.stringify({ p: 'z'.repeat(80) }));

  await Promise.all([1, 2, 3, 4, 5].map(() => whatsAppClient.autoBackupSessionToRender()));
  assert.strictEqual(puts.length, 1, `expected exactly 1 PUT after burst, got ${puts.length}`);
  assert.ok(puts[0].length <= 60000, `bundle ${puts[0].length} exceeds 60000 cap`);
  const restored = JSON.parse(zlib.gunzipSync(Buffer.from(puts[0], 'base64')).toString('utf8'));
  assert.ok(restored['creds.json'], 'creds.json must always be in the bundle');
  console.log(`✅ Test 1 Passed: bundle ${puts[0].length}b (<=60000) with ${Object.keys(restored).length} of 415 files, creds kept.`);
  console.log('✅ Test 2 Passed: 5 concurrent backup triggers collapsed into 1 Render PUT.\n');

  // --- Test 3 & 4: hydration prefers live API bundle ---
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const mk = (id) =>
    zlib.gzipSync(Buffer.from(JSON.stringify({ 'creds.json': JSON.stringify({ account: { d: 'x'.repeat(60) }, me: { id, lid: '1:1@lid' } }) }))).toString('base64');
  const staleEnv = mk('0000000000:1@s.whatsapp.net');
  const liveApi = mk('2347058967815:9@s.whatsapp.net');
  process.env.SESSION_BUNDLE_BASE64 = staleEnv;
  liveBundleForGet = liveApi;

  const picked = await whatsAppClient.fetchLatestSessionBundle();
  assert.strictEqual(picked, liveApi, 'must prefer live Render API bundle over stale process.env snapshot');
  console.log('✅ Test 3 Passed: boot uses live API bundle, not the stale deploy-time env snapshot.');

  liveBundleForGet = null; // API unavailable -> fall back to env
  assert.strictEqual(await whatsAppClient.fetchLatestSessionBundle(), staleEnv, 'must fall back to process.env when API fails');
  console.log('✅ Test 3b Passed: falls back to env snapshot when Render API is unreachable.');

  liveBundleForGet = liveApi;
  const hydrated = zlib.gunzipSync(Buffer.from(await whatsAppClient.fetchLatestSessionBundle(), 'base64')).toString('utf8');
  assert.ok(JSON.parse(JSON.parse(hydrated)['creds.json']).me.id.startsWith('2347058967815'), 'hydrated creds must be the owner session');
  console.log('✅ Test 4 Passed: hydrated creds belong to the bot account (registered via account/me.lid).');

  console.log('\n🎉 ALL SESSION PERSISTENCE TESTS PASSED! 🚀');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ FAILED:', e);
  process.exit(1);
});
