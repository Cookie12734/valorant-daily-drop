import test from 'node:test';
import assert from 'node:assert/strict';
import { accessoryFromStorefront, parseAccessory, accessoryTypes, KC } from '../dist/accessory.mjs';
import { sessionShop } from './riot-login.mjs';
import { createLocalServer } from './local-server.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-01T00:00:00Z');
const store = () => ({ AccessoryStore: { AccessoryStoreRemainingDurationInSeconds: 604800,
  AccessoryStoreOffers: Object.keys(accessoryTypes).map((type, i) => ({ Offer: { OfferID: id(i + 10), IsDirectPurchase: true,
    Cost: { [KC]: 4000 }, Rewards: [{ ItemID: id(i + 1), ItemTypeID: type, Quantity: i === 0 ? 2 : 1 }] } })) } });

test('accessory store normalizes all four types, KC prices, weekly expiry and empty stores', () => {
  const snapshot = accessoryFromStorefront(store(), 'ap', now);
  assert.equal(snapshot.kind, 'accessory');
  assert.equal(snapshot.offers.length, 4);
  assert.equal(snapshot.expiresAt, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(parseAccessory({ ...snapshot, accessToken: 'secret' }), snapshot);
  const empty = store(); empty.AccessoryStore.AccessoryStoreOffers = [];
  assert.deepEqual(accessoryFromStorefront(empty, 'ap', now).offers, []);
  for (const mutate of [
    s => { s.AccessoryStore.AccessoryStoreOffers[0].Offer.Cost = { vp: 4000 }; },
    s => { s.AccessoryStore.AccessoryStoreOffers[0].Offer.Cost[KC] = -1; },
    s => { s.AccessoryStore.AccessoryStoreOffers[0].Offer.Rewards[0].ItemTypeID = id(99); },
    s => { s.AccessoryStore.AccessoryStoreOffers[1].Offer.Rewards[0].Quantity = 2; },
    s => { s.AccessoryStore.AccessoryStoreOffers[0].Offer.IsDirectPurchase = false; },
    s => { s.AccessoryStore.AccessoryStoreOffers.push(s.AccessoryStore.AccessoryStoreOffers[0]); },
    s => { s.AccessoryStore.AccessoryStoreRemainingDurationInSeconds = -1; },
  ]) { const data = store(); mutate(data); assert.throws(() => accessoryFromStorefront(data, 'ap', now)); }
});

test('accessory retrieval uses the authenticated storefront and protected local route', async () => {
  let calls = 0;
  const snapshot = await sessionShop({ shard: 'ap', subject: id(99), accessToken: 'private', entitlement: 'private' }, async (url, options) => {
    calls++;
    if (url.endsWith('/version')) return Response.json({ data: { riotClientVersion: 'release-13.06-shipping-18-5590001' } });
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer private');
    return Response.json(store());
  }, 'accessory');
  assert.equal(snapshot.kind, 'accessory'); assert.equal(snapshot.source, 'riot-login'); assert.equal(calls, 2);
  let state = 'signed_out';
  const server = await createLocalServer({ auth: { status: () => ({ state }), shop: async mode => { assert.equal(mode, 'accessory'); return snapshot; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken };
  const call = (options = {}) => fetch(origin + '/api/accessory', { method: 'POST', body: '{}', headers, ...options });
  try {
    assert.equal((await call({ headers: { Origin: origin } })).status, 403);
    assert.equal((await call({ headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await call()).status, 401);
    state = 'signed_in';
    assert.equal((await call({ body: '{"extra":true}' })).status, 400);
    assert.deepEqual(await (await call()).json(), snapshot);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
