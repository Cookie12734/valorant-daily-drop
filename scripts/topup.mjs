import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localJson, parseLockfile } from './riot-client.mjs';

export class TopUpError extends Error {}
export function paymentURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new TopUpError('Riotの購入画面のURLを確認できません。'); }
  if (url.origin !== 'https://pmc.pay.riotgames.com' || url.username || url.password || url.pathname !== '/start' || ['s', 'sc', 'vc'].some(key => url.searchParams.getAll(key).length !== 1) || !url.searchParams.get('s') || url.searchParams.get('sc') !== 'valorant' || url.searchParams.get('vc') !== 'VP') throw new TopUpError('未対応のRiot購入画面です。Riot Clientで購入してください。');
  return url.href;
}

export async function clientPaymentURL(subject, { read = readFile, request = localJson, remote = fetch, localAppData = process.env.LOCALAPPDATA } = {}) {
  let client;
  try { client = parseLockfile(await read(join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile'), 'utf8')); }
  catch { throw new TopUpError('Riot Clientを起動し、このアプリと同じアカウントでログインしてください。'); }
  async function checkAccount() {
    const auth = await request(client, '/entitlements/v1/token');
    if (!subject || auth?.subject !== subject) throw new TopUpError('Riot Clientとこのアプリのアカウントが一致しません。同じアカウントでログインしてください。');
    return auth;
  }
  async function json(url, options) {
    const response = await remote(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new TopUpError(`RiotがVP購入画面を発行できませんでした（HTTP ${response.status}）。ログイン状態を確認してください。`);
    return response.json();
  }
  try {
    const auth = await checkAccount();
    if (typeof auth.accessToken !== 'string' || !auth.accessToken || /[\r\n]/.test(auth.accessToken)) throw new Error('Invalid token');
    const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };
    const user = await json('https://auth.riotgames.com/userinfo', { headers });
    if (user.sub !== subject || !/^[a-z]{3}$/i.test(user.country)) throw new TopUpError('購入先のアカウントと登録国を確認できません。');
    const config = await request(client, '/client-config/v1/config?type=player&app=valorant&patchline=live');
    const platform = config['payments.pay_plugin.platforms.valorant']?.[user.country.toUpperCase()];
    if (!platform || !['rgi', 'rgl', 'rgj', 'rgk', 'rgs', 'rgg'].includes(platform.pmc) || !['na', 'eu', 'ap', 'kr', 'br', 'latam'].includes(platform.platformCode)) throw new TopUpError('このアカウントの地域はVP購入に未対応です。');
    // Session schema: installed Riot Client swagger, PaymentsSessionRequest/Response.
    // Endpoint: Riot's public PMC JS. Verified with JP account, without charging.
    const result = await json(`https://edge.${platform.pmc}.pmc.pay.riotgames.com/riotpay/pmc/v2/sessions`, { method: 'POST', headers, body: JSON.stringify({ localeId: 'ja_JP', storefrontAccountCode: `valorant-${platform.platformCode}` }) });
    await checkAccount();
    return paymentURL(result?.pmcStartUrl);
  } catch (error) {
    if (error instanceof TopUpError) throw error;
    throw new TopUpError('Riot ClientからVP購入画面を取得できません。同じアカウントでログインして再度お試しください。');
  }
}

export function createTopUpController({ getSession, openWindow, createURL = clientPaymentURL }) {
  let state = 'idle', message = '', generation = 0, window;
  const status = () => ({ state, message });
  return {
    status,
    get isBusy() { return state === 'opening' || state === 'open'; },
    cancel() { generation++; window?.cancel(); window = undefined; state = 'idle'; message = ''; },
    async start() {
      if (this.isBusy) return status();
      const session = getSession(), current = ++generation;
      state = 'opening'; message = '';
      try {
        const url = paymentURL(await createURL(session.subject));
        if (generation !== current || getSession() !== session) throw new TopUpError('ログイン状態が変わったため中止しました。');
        const opened = openWindow(url);
        window = opened;
        opened.closed.then(() => {
          if (generation === current) { state = 'closed'; window = undefined; message = '購入画面を閉じました。残高を更新して確認してください。反映が遅れる場合は追加購入せずお待ちください。'; }
        });
        await opened.ready;
        if (generation === current && state === 'opening') state = 'open';
      } catch (error) {
        if (generation === current) {
          generation++; window?.cancel(); window = undefined;
          state = 'error'; message = error instanceof TopUpError ? error.message : '購入画面を読み込めませんでした。残高を確認してから再度お試しください。';
        }
      }
      return status();
    },
  };
}
