import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPaymentURL, createTopUpController, paymentURL } from './topup.mjs';
import { createLocalServer } from './local-server.mjs';

const url = 'https://pmc.pay.riotgames.com/start?s=secret&sc=valorant&vc=VP';
function fixture() {
  const state = { subject: 'account', country: 'jpn', post: 0, changeAccount: false };
  const deps = {
    localAppData: 'C:/test', read: async () => 'riot:1:12345:secret:https',
    request: async (_client, path) => {
      if (path === '/entitlements/v1/token') return { subject: state.subject, accessToken: 'private-token' };
      assert.equal(path, '/client-config/v1/config?type=player&app=valorant&patchline=live');
      return { 'payments.pay_plugin.platforms.valorant': { JPN: { pmc: 'rgj', platformCode: 'ap' } } };
    },
    remote: async (target, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      if (target === 'https://auth.riotgames.com/userinfo') return Response.json({ sub: state.subject, country: state.country });
      assert.equal(target, 'https://edge.rgj.pmc.pay.riotgames.com/riotpay/pmc/v2/sessions');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { localeId: 'ja_JP', storefrontAccountCode: 'valorant-ap' });
      state.post++;
      if (state.changeAccount) state.subject = 'other';
      return Response.json({ pmcStartUrl: url });
    },
  };
  return { state, deps };
}
test('VP checkout uses registered country, exact Riot host and session creation only', async () => {
  const { state, deps } = fixture();
  assert.equal(await clientPaymentURL('account', deps), url);
  assert.equal(state.post, 1);
  for (const unsafe of ['http://pmc.pay.riotgames.com/start?s=x', 'https://pmc.pay.riotgames.com.evil.test/start?s=x', url.replace('VP', 'RP'), url.replace('/start', '/other'), url.replace('https://', 'https://user@')]) assert.throws(() => paymentURL(unsafe));
});
test('account mismatches and unsupported regions cannot create/open checkout', async () => {
  const { state, deps } = fixture();
  await assert.rejects(clientPaymentURL('other', deps), /一致/);
  state.country = 'zzz'; await assert.rejects(clientPaymentURL('account', deps), /地域/);
  assert.equal(state.post, 0);
  state.country = 'jpn'; state.changeAccount = true;
  await assert.rejects(clientPaymentURL('account', deps), /一致/);
});
test('one window at a time, cancel during session creation, sanitized errors and closure', async () => {
  const session = { subject: 'account' };
  let release, close, opened = 0;
  const controller = createTopUpController({ getSession: () => session, createURL: () => new Promise(resolve => { release = resolve; }), openWindow: () => {
    opened++; const closed = new Promise(resolve => { close = resolve; });
    return { ready: Promise.resolve(), closed, cancel: close };
  } });
  const first = controller.start();
  assert.equal((await controller.start()).state, 'opening');
  controller.cancel(); release(url); await first; assert.equal(opened, 0);
  const next = controller.start(); release(url); await next;
  assert.equal(controller.status().state, 'open'); assert.equal(controller.isBusy, true);
  assert.equal((await controller.start()).state, 'open'); assert.equal(opened, 1);
  assert.ok(!JSON.stringify(controller.status()).includes('secret'));
  close(); await Promise.resolve(); assert.equal(controller.status().state, 'closed');
  const broken = createTopUpController({ getSession: () => session, createURL: async () => { throw new Error('private-token'); } });
  assert.equal((await broken.start()).state, 'error'); assert.ok(!broken.status().message.includes('private-token'));
});
test('topup routes require capability, same-origin JSON, login and exclude updates/purchases', async t => {
  let busy = false, calls = 0, signedIn = true;
  const server = await createLocalServer({ auth: { status: () => ({ state: signedIn ? 'signed_in' : 'signed_out' }), topup: { get isBusy() { return busy; }, start: async () => { calls++; busy = true; return { state: 'open' }; }, status: () => ({ state: busy ? 'open' : 'idle' }) }, purchases: { isBusy: false } }, updater: { busy: false, install: () => { throw new Error('must not install'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': server.apiToken };
  const call = (path, extra = {}) => fetch(origin + path, { method: 'POST', headers, body: '{}', ...extra });
  assert.equal((await call('/api/topup/start', { headers: {} })).status, 403);
  assert.equal((await call('/api/topup/start', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('/api/topup/start', { body: '{"url":"https://evil.test"}' })).status, 400);
  signedIn = false; assert.equal((await call('/api/topup/start')).status, 401); signedIn = true;
  assert.equal((await call('/api/topup/start')).status, 200); assert.equal(calls, 1);
  assert.equal((await call('/api/purchase/confirm')).status, 409);
  assert.equal((await call('/api/update/install')).status, 409);
  assert.deepEqual(await (await call('/api/topup/status')).json(), { state: 'open' });
});
