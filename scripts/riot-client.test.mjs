import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { parseLockfile, clientContext, snapshotFromStorefront } from './riot-client.mjs';
import { createLocalServer, requestPath, validHost } from './local-server.mjs';

const ids = [1, 2, 3, 4].map(number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`);
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const store = { accessToken: 'must-not-export', subject: ids[0], SkinsPanelLayout: { SingleItemOffers: ids, SingleItemOffersRemainingDurationInSeconds: 3600, SingleItemStoreOffers: ids.map((id, index) => ({ OfferID: id, Cost: { [VP]: 1775 + index }, Rewards: [{ ItemID: id }] })) } };

function call(server, { path = '/api/shop', method = 'POST', headers = {}, body = '{}' } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Daily-Drop-Token': server.apiToken, ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Riot shop normalization and local boundary protections', async () => {
  assert.equal(validHost('127.0.0.1', 80), true);
  assert.equal(validHost('127.0.0.1', 4173), false);
  assert.deepEqual(parseLockfile('Riot Client:123:50000:local-secret:https\n'), { port: 50000, password: 'local-secret' });
  for (const value of ['Client:123:50000:secret:http', 'Client:123:0:secret:https', 'Client:123:65536:secret:https', 'Client:123:50:secret\r\nInjected:https']) assert.throws(() => parseLockfile(value));
  const session = { game: { productId: 'valorant', patchlineId: 'live', version: 'release-13.06-shipping-18-5590001', launchConfiguration: { arguments: ['-ares-deployment=br', '-config-endpoint=https://shared.na.a.pvp.net'] } } };
  assert.equal(clientContext(session).shard, 'na');
  assert.equal(clientContext({ game: { ...session.game, patchlineId: 'pbe', launchConfiguration: { arguments: [] } } }).shard, 'pbe');
  assert.throws(() => clientContext({}));
  assert.throws(() => clientContext({}, 'https://pd.ap.a.pvp.net', ids[0]));
  assert.equal(clientContext({}, `${ids[0]} https://pd.ap.a.pvp.net`, ids[0]).shard, 'ap');
  const snapshot = snapshotFromStorefront(store, 'ap', new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(snapshot, { schemaVersion: 1, source: 'riot-client', fetchedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T01:00:00.000Z', region: 'ap', offers: ids.map((id, index) => ({ id, price: 1775 + index })) });
  assert.equal(JSON.stringify(snapshot).includes('must-not-export'), false);
  const changed = structuredClone(store);
  changed.SkinsPanelLayout.SingleItemStoreOffers[0].OfferID = '00000000-0000-0000-0000-000000000099';
  assert.throws(() => snapshotFromStorefront(changed, 'ap'));
  changed.SkinsPanelLayout.SingleItemStoreOffers = undefined;
  assert.equal(snapshotFromStorefront(changed, 'ap').offers[0].price, null);
  changed.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds = -1;
  assert.throws(() => snapshotFromStorefront(changed, 'ap'));
  assert.deepEqual(snapshotFromStorefront({ SkinsPanelLayout: { SingleItemOffers: [], SingleItemStoreOffers: [], SingleItemOffersRemainingDurationInSeconds: 3600 } }, 'ap').offers, []);
  assert.throws(() => snapshotFromStorefront({ SkinsPanelLayout: { SingleItemOffers: [...ids, '00000000-0000-0000-0000-000000000005'], SingleItemOffersRemainingDurationInSeconds: 3600 } }, 'ap'));
  for (const path of ['/../index.html', '/%2e%2e/index.html', '/assets/%2e%2e/index.html', '/%5c..%5csecret', '//example.com', '/%00']) assert.throws(() => requestPath(path));
  const directory = await mkdtemp(join(tmpdir(), 'valo-shop-'));
  await writeFile(join(directory, 'index.html'), '<p>local</p>');
  await writeFile(join(directory, 'app.mjs'), 'export const local = true;');
  await writeFile(join(directory, '.secret.json'), '{"secret":true}');
  let calls = 0;
  const server = await createLocalServer({ directory, loadShop: async () => { calls++; if (calls === 2) throw new Error('secret-token'); return snapshot; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await call(server, { path: '/api/status', method: 'GET', body: '' })).text, '{"local":true}');
    assert.equal(calls, 0);
    for (const headers of [{ Host: `evil.example:${port}` }, { Origin: 'https://evil.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) assert.equal((await call(server, { headers })).status, 403);
    assert.equal((await call(server, { method: 'GET', body: '' })).status, 405);
    assert.equal((await call(server, { body: '{"token":"unwanted"}' })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await call(server, { path: '/%2e%2e/index.html', method: 'GET', body: '' })).status, 400);
    assert.equal((await call(server, { path: '/.secret.json', method: 'GET', body: '' })).status, 404);
    assert.equal((await call(server, { path: '/', method: 'GET', body: '' })).text, '<p>local</p>');
    const module = await call(server, { path: '/app.mjs', method: 'GET', body: '' });
    assert.equal(module.status, 200);
    assert.equal(module.headers['content-type'], 'text/javascript; charset=utf-8');
    const success = await call(server);
    assert.equal(success.status, 200);
    assert.deepEqual(JSON.parse(success.text), snapshot);
    assert.equal(success.headers['cache-control'], 'no-store');
    const failure = await call(server);
    assert.equal(failure.status, 503);
    assert.equal(failure.text.includes('secret-token'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.ok(isAbsolute(directory) && directory.startsWith(`${resolve(tmpdir())}${sep}valo-shop-`));
    await rm(directory, { recursive: true, force: true });
  }
});
