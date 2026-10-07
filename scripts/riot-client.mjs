import { accessoryFromStorefront } from '../dist/accessory.mjs';
import { walletFromResponse } from '../dist/shop.mjs';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:https';
import { nightMarketFromStorefront } from './night-market.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHARDS = new Set(['na', 'eu', 'ap', 'kr', 'pbe']);
const VERSION = /^release-\d+\.\d+-shipping-\d+-\d+$/;
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const PLATFORM = Buffer.from(JSON.stringify({ platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' })).toString('base64');

export function parseLockfile(text) {
  const parts = text.trim().split(':');
  const [name, pid, port, password, protocol] = parts;
  if (parts.length !== 5 || !name || !/^\d+$/.test(pid) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !password || /[\s\x00-\x1f\x7f]/.test(password) || protocol !== 'https') throw new Error('Riot Client の接続情報を読み取れません。');
  return { port: Number(port), password };
}

// Internal client endpoints: https://valapidocs.techchrism.me/endpoint/entitlements-token
function localJson({ port, password }, pathname) {
  return new Promise((resolve, reject) => {
    // Only this fixed loopback request accepts the Riot Client's local certificate.
    const request = get({ hostname: '127.0.0.1', port, path: pathname, rejectUnauthorized: false, headers: { Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}` }, signal: AbortSignal.timeout(8000) }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Riot Client に接続できません。')); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(new Error('応答が大きすぎます。')); });
      response.on('error', reject);
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Riot Client の応答を読み取れません。')); } });
    });
    request.on('error', reject);
  });
}

async function remoteJson(url, headers = {}, options = {}) {
  const response = await fetch(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('API からデータを取得できません。');
  return response.json();
}

export function clientContext(sessions, log = '', subject = '') {
  const session = Object.values(sessions ?? {}).find(value => value?.productId === 'valorant');
  const args = session?.launchConfiguration?.arguments ?? [];
  const endpoint = args.find(value => typeof value === 'string' && value.startsWith('-config-endpoint='))?.slice('-config-endpoint='.length);
  const deployment = args.find(value => typeof value === 'string' && value.startsWith('-ares-deployment='))?.slice('-ares-deployment='.length).toLowerCase();
  let shard = endpoint?.match(/^https:\/\/shared\.(na|eu|ap|kr|pbe)\.a\.pvp\.net\/?$/)?.[1];
  shard ??= session?.patchlineId === 'pbe' ? 'pbe' : ({ na: 'na', latam: 'na', br: 'na', eu: 'eu', ap: 'ap', kr: 'kr' })[deployment];
  // ponytail: log fallback can be stale; require a live game session if that becomes a problem.
  // The log must at least belong to the current account; never guess the shard.
  if (!shard && UUID.test(subject) && log.toLowerCase().includes(subject.toLowerCase())) {
    shard = [...log.matchAll(/https:\/\/(?:pd\.|shared\.|glz-[a-z0-9-]+-\d+\.)(na|eu|ap|kr|pbe)\.a\.pvp\.net\b/g)].at(-1)?.[1];
  }
  const version = VERSION.test(session?.version ?? '') ? session.version : [...log.matchAll(/\brelease-\d+\.\d+-shipping-\d+-\d+\b/g)].at(-1)?.[0];
  if (!SHARDS.has(shard)) throw new Error('VALORANT を起動してログインし、もう一度お試しください。');
  return { shard, version };
}

async function logTail(localAppData) {
  let file;
  try {
    file = await open(join(localAppData, 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log'), 'r');
    const { size } = await file.stat();
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await file?.close(); }
}

// Storefront IDs are skin-level IDs; prices come from Riot, never from catalogue tiers.
export function snapshotFromStorefront(store, shard, now = new Date()) {
  const panel = store?.SkinsPanelLayout;
  const ids = panel?.SingleItemOffers;
  const remaining = panel?.SingleItemOffersRemainingDurationInSeconds;
  if (!SHARDS.has(shard) || !Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length || !Number.isSafeInteger(remaining) || remaining < 0 || remaining > 86400) throw new Error('本日のショップ情報を読み取れません。');
  const detailed = panel.SingleItemStoreOffers;
  if (detailed !== undefined && (!Array.isArray(detailed) || detailed.length !== ids.length || new Set(detailed.map(offer => offer?.OfferID?.toLowerCase())).size !== ids.length || detailed.some(offer => !ids.some(id => id.toLowerCase() === offer?.OfferID?.toLowerCase())))) throw new Error('ショップのオファー情報が一致しません。');
  const offers = ids.map(id => {
    const offer = detailed?.find(value => value.OfferID.toLowerCase() === id.toLowerCase());
    const reward = offer?.Rewards;
    if (offer && (!Array.isArray(reward) || reward.length !== 1 || typeof reward[0]?.ItemID !== 'string' || !UUID.test(reward[0].ItemID))) throw new Error('ショップの商品情報を読み取れません。');
    const price = offer?.Cost?.[VP] ?? null;
    if (price !== null && (!Number.isSafeInteger(price) || price < 0)) throw new Error('ショップの価格情報を読み取れません。');
    return { id: (reward?.[0].ItemID ?? id).toLowerCase(), price };
  });
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) throw new Error('ショップの商品情報が一致しません。');
  return { schemaVersion: 1, source: 'riot-client', fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + remaining * 1000).toISOString(), region: shard, offers };
}

export async function fetchShopSnapshot(mode = 'daily') {
  if (!['daily', 'night-market', 'accessory', 'wallet'].includes(mode)) throw new Error('ショップの種類を読み取れません。');
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('Windows の Riot Client が必要です。');
  let lockfile;
  try { lockfile = parseLockfile(await readFile(join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile'), 'utf8')); }
  catch { throw new Error('Riot Client を起動してログインしてください。'); }
  try {
    const [auth, sessions] = await Promise.all([localJson(lockfile, '/entitlements/v1/token'), localJson(lockfile, '/product-session/v1/external-sessions').catch(() => ({}))]);
    if (!UUID.test(auth?.subject ?? '') || typeof auth.accessToken !== 'string' || !auth.accessToken || typeof auth.token !== 'string' || !auth.token || /[\r\n]/.test(auth.accessToken + auth.token)) throw new Error('ログイン情報を取得できません。');
    let context;
    try { context = clientContext(sessions); } catch { context = clientContext(sessions, await logTail(localAppData), auth.subject); }
    let version = context.shard === 'pbe' ? context.version : undefined;
    if (context.shard !== 'pbe') {
      try { version = (await remoteJson('https://valorant-api.com/v1/version'))?.data?.riotClientVersion; } catch { /* The running client's version is a valid fallback. */ }
    }
    if (!VERSION.test(version ?? '')) version = context.version;
    if (!VERSION.test(version ?? '')) version = clientContext(sessions, await logTail(localAppData), auth.subject).version;
    if (!VERSION.test(version ?? '')) throw new Error('クライアントのバージョンを取得できません。');
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}`, 'X-Riot-Entitlements-JWT': auth.token, 'X-Riot-ClientPlatform': PLATFORM, 'X-Riot-ClientVersion': version };
    if (mode === 'wallet') return walletFromResponse(await remoteJson(`https://pd.${context.shard}.a.pvp.net/store/v1/wallet/${auth.subject}`, headers));
    const store = await remoteJson(`https://pd.${context.shard}.a.pvp.net/store/v3/storefront/${auth.subject}`, headers, { method: 'POST', body: '{}' });
    return mode === 'accessory' ? accessoryFromStorefront(store, context.shard) : mode === 'night-market' ? nightMarketFromStorefront(store, context.shard) : snapshotFromStorefront(store, context.shard);
  } catch { throw new Error('ショップを取得できません。VALORANT を起動してログインし、もう一度お試しください。'); }
}
