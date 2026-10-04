import test from 'node:test';
import assert from 'node:assert/strict';
import { nightMarketFromStorefront } from './night-market.mjs';
import { snapshotFromStorefront } from './riot-client.mjs';
import { sessionShop, createLoginController } from './riot-login.mjs';
import { createLocalServer } from './local-server.mjs';

const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
const now = new Date('2026-10-01T00:00:00Z');
const offer = id => ({ BonusOfferID: 'ignored', Offer: { OfferID: 'ignored', Rewards: [{ ItemID: id }], Cost: { [VP]: 1775 } }, DiscountPercent: 20, DiscountCosts: { [VP]: 1420 }, IsSeen: false });
const storefront = {
  accessToken: 'storefront-secret', subject: ids[6],
  SkinsPanelLayout: { SingleItemOffers: [ids[0]], SingleItemOffersRemainingDurationInSeconds: 3600 },
  BonusStore: { BonusStoreOffers: ids.slice(0, 6).map(offer), BonusStoreRemainingDurationInSeconds: 86400 },
};

test('Night Market normalizes six discounted offers without exposing account or store metadata', () => {
  const result = nightMarketFromStorefront(storefront, 'ap', now);
  assert.deepEqual(result, {
    schemaVersion: 1, kind: 'night-market', source: 'riot-client', region: 'ap', fetchedAt: now.toISOString(), expiresAt: '2026-10-02T00:00:00.000Z', active: true,
    offers: ids.slice(0, 6).map(id => ({ id, price: 1420, originalPrice: 1775, discountPercent: 20 })),
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('ignored'), false);
  assert.equal(result.subject, undefined);
  const uppercase = structuredClone(storefront);
  uppercase.BonusStore.BonusStoreOffers[0].Offer.Rewards[0].ItemID = 'ABCDEFAB-0000-0000-0000-000000000001';
  assert.equal(nightMarketFromStorefront(uppercase, 'ap', now).offers[0].id, 'abcdefab-0000-0000-0000-000000000001');
});

test('Missing, null, empty and expired Night Markets are inactive while malformed data throws', () => {
  for (const BonusStore of [undefined, null, { BonusStoreOffers: [], BonusStoreRemainingDurationInSeconds: 100 }, { ...storefront.BonusStore, BonusStoreRemainingDurationInSeconds: 0 }]) {
    const result = nightMarketFromStorefront({ BonusStore }, 'ap', now);
    assert.equal(result.active, false);
    assert.equal(result.expiresAt, null);
    assert.deepEqual(result.offers, []);
  }
  for (const mutate of [
    value => { value.BonusStore = false; },
    value => { value.BonusStore = {}; },
    value => { value.BonusStore.BonusStoreOffers = null; },
    value => { value.BonusStore.BonusStoreOffers.push(offer(ids[6])); },
    value => { value.BonusStore.BonusStoreOffers[1] = offer(ids[0]); },
    value => { value.BonusStore.BonusStoreOffers[0].Offer.Rewards = []; },
    value => { value.BonusStore.BonusStoreOffers[0].Offer.Rewards[0].ItemID = 'bad-id'; },
    value => { value.BonusStore.BonusStoreOffers[0].Offer.Cost = {}; },
    value => { value.BonusStore.BonusStoreOffers[0].Offer.Cost[VP] = 0; },
    value => { value.BonusStore.BonusStoreOffers[0].DiscountCosts[VP] = 1776; },
    value => { value.BonusStore.BonusStoreOffers[0].DiscountCosts[VP] = -1; },
    value => { value.BonusStore.BonusStoreOffers[0].DiscountCosts[VP] = '1420'; },
    value => { value.BonusStore.BonusStoreOffers[0].DiscountPercent = 100.5; },
    value => { value.BonusStore.BonusStoreOffers[0].DiscountPercent = -1; },
    value => { value.BonusStore.BonusStoreRemainingDurationInSeconds = 90 * 86400 + 1; },
    value => { value.BonusStore.BonusStoreRemainingDurationInSeconds = -1; },
    value => { value.BonusStore.BonusStoreRemainingDurationInSeconds = '100'; },
  ]) {
    const changed = structuredClone(storefront);
    mutate(changed);
    assert.throws(() => nightMarketFromStorefront(changed, 'ap', now));
  }
  assert.throws(() => nightMarketFromStorefront({}, 'unknown', now));
  assert.throws(() => nightMarketFromStorefront(null, 'ap', now));
  assert.throws(() => nightMarketFromStorefront(storefront, 'ap', new Date(NaN)));
  const daily = snapshotFromStorefront({ ...storefront, BonusStore: 'invalid' }, 'ap', now);
  assert.deepEqual(daily.offers, [{ id: ids[0], price: null }]);
  assert.equal(daily.active, undefined);
});

test('Riot login fetches Night Market from the same storefront POST without extra requests', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/version') ? { data: { riotClientVersion: 'release-13.06-shipping-18-5590001' } } : storefront);
  };
  const account = { shard: 'ap', subject: ids[6], accessToken: 'access-secret', entitlement: 'entitlement-secret' };
  const result = await sessionShop(account, request, 'night-market');
  assert.equal(result.source, 'riot-login');
  assert.equal(result.kind, 'night-market');
  assert.equal(result.offers.length, 6);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://pd.ap.a.pvp.net/store/v3/storefront/${ids[6]}`);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, '{}');
  assert.equal(calls[1].options.headers['X-Riot-Entitlements-JWT'], 'entitlement-secret');
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  await assert.rejects(sessionShop(account, request, 'bad-mode'));
  assert.equal(calls.length, 2);
});

test('Night Market mode reaches the login loader and logout discards a pending response', async () => {
  let finish, received;
  const account = { expiresAt: Date.now() + 3600000 };
  const auth = createLoginController({
    openLogin: () => ({ result: Promise.resolve(account), cancel() {} }), connect: async value => value,
    loadShop: async (...args) => { received = args; return new Promise(resolve => { finish = resolve; }); },
  });
  auth.start();
  await new Promise(resolve => setImmediate(resolve));
  const pending = auth.shop('night-market');
  assert.deepEqual(received, [account, undefined, 'night-market']);
  await auth.logout();
  finish(nightMarketFromStorefront(storefront, 'ap', now));
  await assert.rejects(pending, /ログアウト/);
  await assert.rejects(auth.shop('night-market'), /ログイン/);
});

test('Night Market HTTP route enforces the local authenticated boundary and hides failures', async () => {
  let state = 'signed_out', fail = false, received;
  const snapshot = nightMarketFromStorefront(storefront, 'ap', now);
  const auth = { status: () => ({ state }), shop: async mode => { received = mode; if (fail) throw new Error('secret-token'); return snapshot; } };
  const server = await createLocalServer({ auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (overrides = {}) => fetch(`${origin}/api/night-market`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken }, body: '{}', ...overrides });
  try {
    assert.equal((await call({ method: 'GET', body: undefined })).status, 405);
    assert.equal((await call({ headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await call({ body: '{"mode":"night-market"}' })).status, 400);
    assert.equal((await call()).status, 401);
    assert.equal(received, undefined);
    state = 'signed_in';
    const success = await call();
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await success.json(), snapshot);
    assert.equal(received, 'night-market');
    fail = true;
    const failure = await call();
    assert.equal(failure.status, 503);
    assert.equal((await failure.text()).includes('secret-token'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Legacy Riot Client helper receives Night Market mode and keeps daily mode unchanged', async () => {
  const modes = [];
  const snapshot = nightMarketFromStorefront({}, 'ap', now);
  const server = await createLocalServer({ loadShop: async mode => { modes.push(mode); return snapshot; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/night-market', '/api/shop']) {
      const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken }, body: '{}' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
    }
    assert.deepEqual(modes, ['night-market', undefined]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
