import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareVersions, selectRelease, verifyChecksum, createUpdater } from './updater.mjs';
import { createLocalServer } from './local-server.mjs';

test('versions compare numerically and stable users do not receive previews', () => {
  for (const [a, b] of [['1.10.0', '1.9.0'], ['1.4.0', '1.4.0-preview.9'], ['1.4.0-preview.10', '1.4.0-preview.2'], ['2.0.0-alpha.a', '2.0.0-alpha.1']]) {
    assert.equal(compareVersions(a, b), 1);
    assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions('v1.4.0', '1.4.0'), 0);
  const releases = [{ tag_name: 'v9.0.0', draft: true }, { tag_name: 'v2.0.0-preview.1', prerelease: true }, { tag_name: 'v1.4.0' }, { tag_name: 'bad' }];
  assert.equal(selectRelease(releases, '1.3.0').tag_name, 'v1.4.0');
  assert.equal(selectRelease(releases, '1.4.0-preview.2').tag_name, 'v2.0.0-preview.1');
  assert.equal(selectRelease(releases, '1.4.0'), null);
});
test('checksum binds the bytes and exact archive filename', () => {
  const bytes = Buffer.from('release'), hash = createHash('sha256').update(bytes).digest('hex');
  verifyChecksum(bytes, `${hash}  app.zip\n`, 'app.zip');
  assert.throws(() => verifyChecksum(Buffer.from('tampered'), `${hash}  app.zip`, 'app.zip'));
  assert.throws(() => verifyChecksum(bytes, `${hash}  other.zip`, 'app.zip'));
});
test('checks coalesce, keep credentials absent, and unsupported installs fail', async () => {
  let calls = 0;
  const updater = createUpdater({ currentVersion: '1.0.0', supported: false, request: async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api.github.com\//); assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => [{ tag_name: 'v1.1.0', body: '<script>bad</script>' }] };
  } });
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(calls, 1);
  assert.equal(updater.status().release.version, '1.1.0');
  await assert.rejects(updater.install());
});
test('failed GitHub requests retain a recoverable error', async () => {
  const updater = createUpdater({ currentVersion: '1.0.0', request: async () => ({ ok: false }) });
  assert.match((await updater.check()).error, /GitHub/);
  assert.equal(updater.status().release, null);
});

for (const source of ['header', 'asset', 'unknown']) {
  test(`download progress tracks chunks and resets on retry (${source})`, async () => {
    const name = 'DailyDrop-1.1.0-win-x64.zip';
    const base = 'https://github.com/Cookie12734/valorant-daily-drop/releases/download/v1.1.0/';
    let resume;
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.fail('Progress timed out');
    };
    const updater = createUpdater({ currentVersion: '1.0.0', supported: true, request: async url => {
      if (url.startsWith('https://api.github.com/')) return Response.json([{ tag_name: 'v1.1.0', assets: [name, `${name}.sha256`].map(name => ({ name, size: source === 'unknown' ? undefined : 8, browser_download_url: base + name })) }]);
      if (url.endsWith('.sha256')) throw new Error('Checksum unavailable');
      return { ok: true, headers: new Headers(source === 'header' ? { 'content-length': '10' } : {}), body: (async function* () {
        await new Promise(resolve => { resume = resolve; });
        yield Buffer.alloc(4);
        await new Promise(resolve => { resume = resolve; });
        yield Buffer.alloc(6);
      })() };
    } });
    await updater.check();
    for (let attempt = 0; attempt < 2; attempt++) {
      const initial = await updater.install();
      assert.equal(initial.downloadedBytes, 0);
      await waitFor(() => !!resume);
      const next = resume; resume = null; next();
      await waitFor(() => updater.status().downloadedBytes === 4 && !!resume);
      assert.equal(updater.status().totalBytes, source === 'header' ? 10 : source === 'asset' ? 8 : null);
      assert.equal(updater.status().phase, 'downloading');
      const finish = resume; resume = null; finish();
      await waitFor(() => updater.status().phase === 'error');
      assert.equal(updater.status().downloadedBytes, 10);
      assert.equal(updater.status().totalBytes, 10);
      assert.equal(updater.busy, false);
    }
  });
}
test('update APIs require the capability, same origin, empty body, and exclude purchases', async () => {
  let installed = 0, purchaseBusy = true;
  const updater = { busy: false, status: () => ({ phase: 'idle' }), check: async () => ({}), install: async () => { installed++; updater.busy = true; return {}; } };
  const auth = { status: () => ({ state: 'signed_in' }), purchases: { get isBusy() { return purchaseBusy; } } };
  const server = await createLocalServer({ updater, auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body = '{}', token = server.apiToken) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Daily-Drop-Token': token }, body });
  try {
    assert.equal((await call('/api/update/install', '{}', 'bad')).status, 403);
    assert.equal((await call('/api/update/install', '{"url":"evil"}')).status, 400);
    assert.equal((await call('/api/update/install')).status, 409);
    purchaseBusy = false;
    assert.equal((await call('/api/update/install')).status, 200);
    assert.equal(installed, 1);
    assert.equal((await call('/api/purchase/confirm')).status, 409);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
