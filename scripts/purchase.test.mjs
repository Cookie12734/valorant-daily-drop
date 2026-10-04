import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createPurchaseController } from './purchase.mjs';
import { createLocalServer } from './local-server.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const SKIN = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'daily-drop-purchase-'));
  t.after(async () => { assert.ok(directory.startsWith(`${resolve(tmpdir())}${sep}daily-drop-purchase-`)); await rm(directory, { recursive: true, force: true }); });
  const journalFile = join(directory, 'purchase-state.json');
  let session = { subject: id(9), shard: 'ap', accessToken: 'private-access', entitlement: 'private-entitlement' };
  const state = { price: 1775, balance: 5000, owned: false, status: 'ACCEPTED', clock: 1000000, purchases: 0, timeout: false, seen: [], beforePost: undefined };
  const request = async (url, options) => {
    state.seen.push({ url, options });
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/version')) { assert.equal(options.headers, undefined); return Response.json({ data: { riotClientVersion: 'release-13.06-shipping-18-5590001' } }); }
    assert.ok(url.startsWith('https://pd.ap.a.pvp.net/'));
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    if (url.includes('/storefront/')) return Response.json({ SkinsPanelLayout: { SingleItemOffersRemainingDurationInSeconds: 3600, SingleItemOffers: [id(2)], SingleItemStoreOffers: [{ OfferID: id(2), IsDirectPurchase: true, Cost: { [VP]: state.price }, Rewards: [{ ItemTypeID: SKIN, ItemID: id(1), Quantity: 1 }] }] } });
    if (url.includes('/wallet/')) return Response.json({ Balances: { [VP]: state.balance } });
    if (url.includes('/entitlements/')) return Response.json({ Entitlements: state.owned ? [{ ItemID: id(1) }] : [] });
    if (url.endsWith('/order/') && options.method === 'POST') {
      state.purchases++;
      const saved = JSON.parse(await readFile(journalFile, 'utf8'));
      assert.equal(saved.state, 'unknown', 'persist before sending');
      assert.deepEqual(JSON.parse(options.body), { XID: saved.xid, OfferID: id(2) });
      assert.equal(JSON.stringify(saved).includes('private-'), false);
      assert.equal(JSON.stringify(saved).includes(session.subject), false);
      await state.beforePost?.();
      if (state.timeout) throw new Error('private-network-error');
      return Response.json({ OrderID: id(3), Status: state.status });
    }
    if (url.endsWith(`/order/${id(3)}`)) return Response.json({ OrderID: id(3), Status: state.status });
    throw new Error('Unexpected request');
  };
  const options = { journalFile, request, now: () => state.clock, getSession: () => { if (!session) throw new Error('signed out'); return session; } };
  const controller = createPurchaseController(options);
  const quote = () => controller.quote({ skinId: id(1), expectedPrice: 1775 });
  return { controller, quote, state, options, journalFile, signOut: () => { session = undefined; } };
}

test('explicit quote, single order submission, and COMPLETE plus ownership verification', async t => {
  const { controller, quote, state } = await setup(t);
  const value = await quote();
  assert.equal(value.price, 1775);
  assert.equal(value.balance, 5000);
  assert.equal(state.purchases, 0);
  assert.equal((await controller.confirm({ quoteId: value.quoteId })).state, 'pending');
  assert.equal(state.purchases, 1);
  await controller.confirm({ quoteId: value.quoteId });
  assert.equal(state.purchases, 1, 'repeated confirm cannot submit twice');
  state.status = 'COMPLETE';
  assert.equal((await controller.status()).state, 'pending', 'COMPLETE alone is insufficient');
  state.owned = true;
  assert.equal((await controller.status()).state, 'complete');
  assert.equal(state.purchases, 1);
});

test('stale price, insufficient balance, owned item, invalid input and expired quote never purchase', async t => {
  const { controller, quote, state } = await setup(t);
  await assert.rejects(controller.quote({ skinId: id(1), expectedPrice: 1775, mode: 'night-market' }));
  state.balance = 1; await assert.rejects(quote(), /VP/);
  state.balance = 5000; state.owned = true; await assert.rejects(quote(), /所持/);
  state.owned = false;
  let value = await quote(); state.price = 2000;
  await assert.rejects(controller.confirm({ quoteId: value.quoteId }), /価格/);
  state.price = 1775; value = await quote(); state.clock += 60001;
  await assert.rejects(controller.confirm({ quoteId: value.quoteId }), /期限/);
  value = await quote(); state.balance = 4000;
  await assert.rejects(controller.confirm({ quoteId: value.quoteId }), /残高/);
  await assert.rejects(controller.confirm({ quoteId: id(99) }));
  assert.equal(state.purchases, 0);
});

test('ambiguous transport failure persists across restart and can only be resolved by reads', async t => {
  const { controller, quote, state, options } = await setup(t);
  state.timeout = true;
  const value = await quote();
  assert.equal((await controller.confirm({ quoteId: value.quoteId })).state, 'unknown');
  const restarted = createPurchaseController(options);
  await assert.rejects(restarted.quote({ skinId: id(1), expectedPrice: 1775 }), /未確認/);
  assert.equal((await restarted.confirm({ quoteId: value.quoteId })).state, 'unknown');
  assert.equal((await restarted.status()).state, 'unknown');
  assert.equal(state.purchases, 1);
  state.owned = true;
  assert.equal((await restarted.status()).state, 'complete');
  assert.equal(state.purchases, 1);
});

test('parallel confirmations cannot double-submit and logout invalidates a quote', async t => {
  const { controller, quote, state, signOut } = await setup(t);
  const value = await quote();
  const results = await Promise.allSettled([controller.confirm({ quoteId: value.quoteId }), controller.confirm({ quoteId: value.quoteId })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(state.purchases, 1);
  state.status = 'FAILED'; await controller.status();
  const next = await quote(); signOut();
  await assert.rejects(controller.confirm({ quoteId: next.quoteId }));
  assert.equal(state.purchases, 1);
});

test('corrupt or unwritable journal prevents all purchase submissions', async t => {
  const { state, options, journalFile } = await setup(t);
  await writeFile(journalFile, 'broken-json');
  const corrupt = createPurchaseController(options);
  await assert.rejects(corrupt.quote({ skinId: id(1), expectedPrice: 1775 }), /購入記録/);
  const unavailable = createPurchaseController({ ...options, journalFile: join(journalFile, 'cannot-write.json') });
  const value = await unavailable.quote({ skinId: id(1), expectedPrice: 1775 });
  await assert.rejects(unavailable.confirm({ quoteId: value.quoteId }));
  assert.equal(state.purchases, 0);
});

test('purchase HTTP routes enforce capability, origin, method and signed-in account', async () => {
  let calls = 0, state = 'signed_out';
  const server = await createLocalServer({ auth: { status: () => ({ state }), purchases: { quote: async () => { calls++; return { quoteId: id(4) }; }, confirm: async () => { calls++; return { state: 'complete' }; }, status: async () => { calls++; return { state: 'idle' }; } } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const action of ['quote', 'confirm', 'status']) {
      const url = `${origin}/api/purchase/${action}`;
      const headers = { 'X-Daily-Drop-Token': server.apiToken, Origin: origin, 'Content-Type': 'application/json' };
      assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { Origin: origin, 'Content-Type': 'application/json' } })).status, 403);
      assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
      assert.equal((await fetch(url, { headers })).status, 405);
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
      assert.equal(calls, 0);
    }
    state = 'signed_in';
    assert.equal((await fetch(`${origin}/api/purchase/status`, { method: 'POST', headers: { 'X-Daily-Drop-Token': server.apiToken, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
