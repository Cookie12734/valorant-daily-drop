import { accessoryFromStorefront } from '../dist/accessory.mjs';
import { randomBytes } from 'node:crypto';
import { snapshotFromStorefront } from './riot-client.mjs';
import { nightMarketFromStorefront } from './night-market.mjs';
import { createPurchaseController, PurchaseError } from './purchase.mjs';

const REDIRECT = 'https://playvalorant.com/opt_in';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PLATFORM = Buffer.from(JSON.stringify({ platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' })).toString('base64');
export class LoginError extends Error {}

export function authorizationRequest() {
  const state = randomBytes(32).toString('hex');
  const url = new URL('https://auth.riotgames.com/authorize');
  url.search = new URLSearchParams({ client_id: 'play-valorant-web-prod', redirect_uri: REDIRECT, response_type: 'token id_token', scope: 'account openid', nonce: randomBytes(32).toString('hex'), state }).toString();
  return { url: url.href, state };
}

export function parseAuthRedirect(raw, state, now = Date.now()) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== 'https://playvalorant.com' || url.pathname !== '/opt_in' || url.username || url.password) return null;
  const data = new URLSearchParams(url.hash.slice(1));
  if (!url.hash) return null;
  if (!state || data.getAll('state').length !== 1 || data.get('state') !== state) throw new LoginError('ログインの確認情報が一致しません。もう一度ログインしてください。');
  if (data.has('error')) throw new LoginError('Riotでログインが許可されませんでした。もう一度お試しください。');
  const accessToken = data.get('access_token');
  const idToken = data.get('id_token');
  const seconds = Number(data.get('expires_in'));
  if (['access_token', 'id_token', 'expires_in', 'token_type'].some(key => data.getAll(key).length !== 1) || data.get('token_type')?.toLowerCase() !== 'bearer' || ![accessToken, idToken].every(value => typeof value === 'string' && /^[A-Za-z0-9._~+/-]+=*$/.test(value) && value.length <= 16384) || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) throw new LoginError('Riotのログイン結果を読み取れません。認証仕様が変更された可能性があります。');
  return { accessToken, idToken, expiresAt: now + seconds * 1000 };
}

async function riotJson(url, options, request) {
  const stage = url.includes('/store/') ? 'ショップ' : url.endsWith('/version') ? 'バージョン情報' : 'アカウント情報';
  let response;
  try { response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new LoginError('Riotへの接続に失敗しました。ネットワークを確認してください。'); }
  if ([401, 403].includes(response.status)) throw new LoginError('Riotに認証を拒否されました。ログアウトして再度ログインしてください。');
  if (response.status === 429) throw new LoginError('Riotのアクセス上限に達しました。しばらく待ってからお試しください。');
  if (!response.ok) throw new LoginError(`${stage}を取得できません（HTTP ${response.status}）。時間をおいて再度お試しください。`);
  try { return await response.json(); } catch { throw new LoginError('Riotの応答形式が変更された可能性があります。'); }
}

export async function accountSession(tokens, request = fetch) {
  const headers = { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' };
  const [player, entitlement, geo] = await Promise.all([
    riotJson('https://auth.riotgames.com/userinfo', { headers }, request),
    riotJson('https://entitlements.auth.riotgames.com/api/token/v1', { method: 'POST', headers, body: '{}' }, request),
    riotJson('https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant', { method: 'PUT', headers, body: JSON.stringify({ id_token: tokens.idToken }) }, request),
  ]);
  const region = geo?.affinities?.live;
  const shard = ['na', 'latam', 'br', 'eu', 'ap', 'kr'].includes(region) ? ['latam', 'br'].includes(region) ? 'na' : region : undefined;
  const token = entitlement?.entitlements_token;
  if (!UUID.test(player?.sub ?? '') || !shard || typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16384) throw new LoginError('アカウントのショップ接続情報を取得できません。');
  // ID token is needed only for region discovery; do not retain it afterwards.
  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, subject: player.sub, entitlement: token, shard };
}

export async function sessionShop(session, request = fetch, mode = 'daily') {
  if (!['daily', 'night-market', 'accessory'].includes(mode)) throw new LoginError('ショップの種類を読み取れません。');
  const version = (await riotJson('https://valorant-api.com/v1/version', {}, request))?.data?.riotClientVersion;
  if (typeof version !== 'string' || !/^release-\d+\.\d+-shipping-\d+-\d+$/.test(version)) throw new LoginError('VALORANTのバージョン情報を取得できません。');
  const store = await riotJson(`https://pd.${session.shard}.a.pvp.net/store/v3/storefront/${session.subject}`, { method: 'POST', body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}`, 'X-Riot-Entitlements-JWT': session.entitlement, 'X-Riot-ClientPlatform': PLATFORM, 'X-Riot-ClientVersion': version } }, request);
  return { ...(mode === 'accessory' ? accessoryFromStorefront(store, session.shard) : mode === 'night-market' ? nightMarketFromStorefront(store, session.shard) : snapshotFromStorefront(store, session.shard)), source: 'riot-login' };
}

// ponytail: one local user per helper process; do not expose this server to a network.
export function createLoginController({ openLogin, connect = accountSession, loadShop = sessionShop, clearSavedLogin = async () => {}, now = Date.now, purchaseFile } = {}) {
  let state = 'signed_out', error, session, attempt, generation = 0, lastStart = -Infinity;
  let clearing, mustClear = false;
  function status() {
    if (session && session.expiresAt <= now() + 15000) { session = undefined; state = 'signed_out'; }
    return { state, ...(error ? { error } : {}) };
  }
  function reset() {
    generation++;
    session = undefined;
    state = 'signed_out';
    error = undefined;
    attempt?.cancel();
    attempt = undefined;
  }
  function logout() {
    if (clearing) return clearing;
    reset();
    mustClear = true;
    clearing = Promise.resolve().then(clearSavedLogin).then(() => { mustClear = false; }).catch(() => {
      state = 'error';
      error = '保存したログイン情報を削除できません。もう一度ログアウトしてください。';
      throw new LoginError(error);
    }).finally(() => { clearing = undefined; });
    return clearing;
  }
  function start() {
    if (mustClear) throw new LoginError('ログアウト処理の完了後にログインしてください。');
    if (state === 'pending' || status().state === 'signed_in') return status();
    if (now() - lastStart < 2000) throw new LoginError('少し待ってから、もう一度ログインしてください。');
    lastStart = now();
    reset();
    const current = generation;
    state = 'pending';
    try {
      attempt = openLogin();
      Promise.resolve(attempt.result).then(tokens => current === generation ? connect(tokens) : undefined).then(value => {
        if (current !== generation) return;
        session = value; state = 'signed_in'; attempt = undefined;
      }).catch(cause => {
        if (current !== generation) return;
        state = 'error'; error = cause instanceof LoginError ? cause.message : 'ログインできませんでした。もう一度お試しください。'; attempt = undefined;
      });
    } catch { state = 'error'; error = 'ログイン画面を開けませんでした。補助アプリを再起動してください。'; }
    return status();
  }
  const purchases = purchaseFile ? createPurchaseController({ journalFile: purchaseFile, now, getSession: () => {
    if (status().state !== 'signed_in') throw new PurchaseError('Riotアカウントでログインしてください。');
    return session;
  } }) : undefined;
  return { status, start, logout, dispose: reset, ...(purchases ? { purchases } : {}), async shop(mode = 'daily') {
    if (status().state !== 'signed_in') throw new LoginError('Riotアカウントでログインしてください。');
    const current = generation;
    const snapshot = await loadShop(session, undefined, mode);
    if (current !== generation || status().state !== 'signed_in') throw new LoginError('ログアウトしたため、取得を中止しました。');
    return snapshot;
  } };
}
