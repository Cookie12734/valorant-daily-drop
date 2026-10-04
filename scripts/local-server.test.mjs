import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from './local-server.mjs';

test('every local API requires a per-instance capability before touching account state', async () => {
  let calls = 0;
  const auth = {
    status() { calls++; return { state: 'signed_in' }; },
    start() { calls++; }, logout() { calls++; },
    async shop() { calls++; return { offers: [] }; },
  };
  const server = await createLocalServer({ auth });
  const other = await createLocalServer();
  assert.match(server.apiToken, /^[a-f0-9]{64}$/);
  assert.notEqual(server.apiToken, other.apiToken);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, headers = {}) => fetch(origin + path, {
    method: path === '/api/status' ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token === undefined ? {} : { 'X-Daily-Drop-Token': token }), ...headers },
    ...(path === '/api/status' ? {} : { body: '{}' }),
  });
  try {
    for (const path of ['/api/status', '/api/login', '/api/logout', '/api/shop', '/api/night-market']) {
      for (const token of [undefined, '', 'wrong', '0'.repeat(64), other.apiToken, `${server.apiToken}, ${server.apiToken}`]) {
        const response = await call(path, token);
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.text()).includes(server.apiToken), false);
      }
      for (const headers of [{ Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        assert.equal((await call(path, server.apiToken, headers)).status, 403);
      }
    }
    assert.equal(calls, 0, 'rejected requests cannot read status or cause side effects');
    for (const path of ['/', '/app.mjs', '/api/status?token=' + server.apiToken]) {
      const response = await fetch(origin + path);
      assert.equal((await response.text()).includes(server.apiToken), false);
      if (path.startsWith('/api/')) assert.equal(response.status, 403, 'query strings cannot authenticate');
    }
    for (const path of ['/api/status', '/api/login', '/api/logout', '/api/shop', '/api/night-market']) {
      const response = await call(path, server.apiToken);
      assert.equal(response.status, path === '/api/login' ? 202 : 200);
      assert.equal((await response.text()).includes(server.apiToken), false);
    }
    assert.ok(calls > 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
