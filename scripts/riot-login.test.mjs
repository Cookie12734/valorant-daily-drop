import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationRequest, parseAuthRedirect, accountSession, sessionShop, createLoginController } from './riot-login.mjs';
import { createLocalServer } from './local-server.mjs';
import { parseSnapshot } from '../dist/shop.mjs';

test('Riot login callback binding, downstream requests and logout races', async () => {
  const auth = authorizationRequest();
  assert.notEqual(auth.state, authorizationRequest().state);
  assert.equal(new URL(auth.url).searchParams.get('state'), auth.state);
  const fragment = new URLSearchParams({ state: auth.state, access_token: 'test.access', id_token: 'test.id', token_type: 'Bearer', expires_in: '3600' });
  const callback = `https://playvalorant.com/opt_in#${fragment}`;
  const tokens = parseAuthRedirect(callback, auth.state, 1000);
  assert.equal(tokens.expiresAt, 3601000);
  assert.equal(parseAuthRedirect(callback.replace('playvalorant.com', 'playvalorant.com.evil.test'), auth.state), null);
  assert.equal(parseAuthRedirect(callback.replace('/opt_in', '/elsewhere'), auth.state), null);
  assert.throws(() => parseAuthRedirect(callback, 'wrong-state'));
  assert.throws(() => parseAuthRedirect(`${callback}&access_token=duplicate`, auth.state));
  assert.throws(() => parseAuthRedirect(callback.replace('3600', '-1'), auth.state));
  const id = '00000000-0000-0000-0000-000000000001';
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    let data;
    if (url.endsWith('/userinfo')) data = { sub: id };
    else if (url.includes('entitlements.auth')) data = { entitlements_token: 'test.entitlement' };
    else if (url.includes('riot-geo')) data = { affinities: { live: 'br' } };
    else if (url.endsWith('/version')) data = { data: { riotClientVersion: 'release-13.06-shipping-18-5590001' } };
    else data = { SkinsPanelLayout: { SingleItemOffers: [id], SingleItemOffersRemainingDurationInSeconds: 100, SingleItemStoreOffers: [{ OfferID: id, Cost: { '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741': 1775 }, Rewards: [{ ItemID: id }] }] } };
    return Response.json(data);
  };
  const account = await accountSession(tokens, request);
  assert.equal(account.shard, 'na');
  assert.equal(account.idToken, undefined);
  const shop = await sessionShop(account, request);
  assert.equal(parseSnapshot(shop).source, 'riot-login');
  assert.equal(shop.offers[0].price, 1775);
  assert.equal(JSON.stringify(shop).includes('test.'), false);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.equal(calls.find(call => call.url.endsWith('/version')).options.headers, undefined);
  assert.equal(calls.at(-1).url, `https://pd.na.a.pvp.net/store/v3/storefront/${id}`);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.body, '{}');
  assert.equal(calls.at(-1).options.headers['X-Riot-Entitlements-JWT'], 'test.entitlement');
  assert.equal(JSON.parse(calls.find(call => call.url.includes('riot-geo')).options.body).id_token, 'test.id');
  await assert.rejects(accountSession(tokens, async () => Response.json({}, { status: 403 })), /認証を拒否/);

  let complete, clock = 1000;
  const controller = createLoginController({ openLogin: () => ({ result: new Promise(resolve => { complete = resolve; }), cancel() {} }), connect: async value => value, loadShop: async () => shop, now: () => clock });
  assert.equal(controller.start().state, 'pending');
  await controller.logout();
  complete(account);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.status().state, 'signed_out');
  await assert.rejects(controller.shop());
  clock += 2001;
  controller.start();
  complete(account);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(controller.status(), { state: 'signed_in' });
  assert.deepEqual(await controller.shop(), shop);
  clock = account.expiresAt;
  assert.deepEqual(controller.status(), { state: 'signed_out' });
});

test('HTTP login requires same-origin POST and never returns tokens', async () => {
  let state = 'signed_out', starts = 0;
  const auth = { status: () => ({ state }), start: () => { starts++; state = 'pending'; }, logout: () => { state = 'signed_out'; }, shop: async () => { throw new Error('must-not-leak-token'); } };
  const server = await createLocalServer({ auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, overrides = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken }, body: '{}', ...overrides });
  try {
    assert.equal((await call('/api/login', { headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await call('/api/login', { body: '{"password":"not-accepted"}' })).status, 400);
    assert.equal(starts, 0);
    assert.equal((await call('/api/shop')).status, 401);
    const login = await call('/api/login');
    assert.equal(login.status, 202);
    assert.deepEqual(await login.json(), { local: true, login: true, auth: { state: 'pending' } });
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.equal(starts, 1);
    state = 'signed_in';
    const failure = await call('/api/shop');
    assert.equal(failure.status, 503);
    assert.equal((await failure.text()).includes('must-not-leak-token'), false);
    await call('/api/logout');
    assert.equal(state, 'signed_out');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('remembered login survives shutdown and is cleared before another login', async () => {
  let resolveClear, clears = 0, opens = 0;
  const controller = createLoginController({
    openLogin: () => { opens++; return { result: new Promise(() => {}), cancel() {} }; },
    clearSavedLogin: () => { clears++; return new Promise(resolve => { resolveClear = resolve; }); },
    now: () => 5000,
  });
  controller.start();
  controller.dispose();
  assert.equal(clears, 0, 'closing the app must preserve remembered login');
  const clearing = controller.logout();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clears, 1);
  assert.equal(controller.logout(), clearing, 'concurrent logout shares deletion');
  assert.throws(() => controller.start(), /ログアウト処理/);
  resolveClear();
  await clearing;
  assert.equal(controller.status().state, 'signed_out');
  assert.equal(opens, 1);

  const failure = createLoginController({ openLogin: () => { throw new Error('must not open'); }, clearSavedLogin: async () => { throw new Error('storage-secret'); } });
  await assert.rejects(failure.logout(), /削除できません/);
  assert.throws(() => failure.start(), /ログアウト処理/);
  assert.equal(JSON.stringify(failure.status()).includes('storage-secret'), false);
});
