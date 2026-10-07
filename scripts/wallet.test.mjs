import test from 'node:test';
import assert from 'node:assert/strict';
import { walletFromResponse, parseWallet } from '../dist/shop.mjs';
import { sessionShop, createLoginController } from './riot-login.mjs';
import { createLocalServer } from './local-server.mjs';

const balance = { VP: 1200, RP: 0, KC: 10000 };
const wallet = { Subject: 'private-subject', Balances: { '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741': 1200, 'e59aa87c-4cbf-517a-5983-6e81511be9b7': 0, '85ca954a-41f2-ce94-9b45-8ca3dd39a00d': 10000, other: 20 } };

test('wallet maps the three currencies, preserves zero, rejects missing/invalid balances and strips private fields', () => {
  assert.deepEqual(walletFromResponse(wallet), balance);
  assert.deepEqual(parseWallet({ ...balance, Subject: 'private' }), balance);
  for (const invalid of [null, {}, { Balances: {} }]) assert.throws(() => walletFromResponse(invalid), /残高/);
  for (const code of ['VP', 'RP', 'KC']) {
    for (const invalid of [undefined, null, '100', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseWallet({ ...balance, [code]: invalid }), /残高/);
  }
});

test('wallet fetch only reads the authenticated wallet and logout discards an in-flight response', async () => {
  const session = { shard: 'ap', subject: '00000000-0000-0000-0000-000000000001', accessToken: 'private-access', entitlement: 'private-entitlement', expiresAt: Date.now() + 3600000 };
  const paths = [];
  assert.deepEqual(await sessionShop(session, async (url, options) => {
    paths.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, undefined, 'GET only');
    if (url.endsWith('/version')) return Response.json({ data: { riotClientVersion: 'release-13.06-shipping-18-5590001' } });
    assert.equal(url, `https://pd.ap.a.pvp.net/store/v1/wallet/${session.subject}`);
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    assert.equal(options.headers['X-Riot-Entitlements-JWT'], 'private-entitlement');
    return Response.json(wallet);
  }, 'wallet'), balance);
  assert.equal(paths.length, 2);
  let resolveWallet;
  const auth = createLoginController({ openLogin: () => ({ result: Promise.resolve({}), cancel() {} }), connect: async () => session,
    loadShop: async (_session, _request, mode) => { assert.equal(mode, 'wallet'); return new Promise(resolve => { resolveWallet = resolve; }); } });
  await assert.rejects(auth.shop('wallet'), /ログイン/);
  auth.start();
  await new Promise(resolve => setImmediate(resolve));
  const pending = auth.shop('wallet');
  await auth.logout();
  resolveWallet(balance);
  await assert.rejects(pending, /ログアウト/);
});

test('wallet HTTP route enforces authentication, same-origin POST, empty body, and supports the client helper', async () => {
  let state = 'signed_out', calls = 0;
  const loader = async mode => { assert.equal(mode, 'wallet'); calls++; return balance; };
  for (const auth of [{ status: () => ({ state }), shop: loader }, undefined]) {
    const server = await createLocalServer({ auth, loadShop: loader });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken };
    const call = (options = {}) => fetch(origin + '/api/wallet', { method: 'POST', headers, body: '{}', ...options });
    try {
      const before = calls;
      assert.equal((await call({ headers: { Origin: origin } })).status, 403);
      assert.equal((await call({ headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
      assert.equal((await call({ method: 'GET', body: undefined })).status, 405);
      assert.equal((await call({ body: '{"subject":"someone-else"}' })).status, 400);
      if (auth) assert.equal((await call()).status, 401);
      assert.equal(calls, before);
      state = 'signed_in';
      const response = await call();
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), balance);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
