export class TopUpError extends Error {}
export function paymentURL(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new TopUpError('Riotの購入画面のURLを確認できません。'); }
  if (url.origin !== 'https://pmc.pay.riotgames.com' || url.username || url.password || url.pathname !== '/start' || ['s', 'sc', 'vc'].some(key => url.searchParams.getAll(key).length !== 1) || !url.searchParams.get('s') || url.searchParams.get('sc') !== 'valorant' || url.searchParams.get('vc') !== 'VP') throw new TopUpError('未対応のRiot購入画面です。Riot Clientで購入してください。');
  return url.href;
}

export async function clientPaymentURL(session, { remote = fetch } = {}) {
  const { subject, accessToken, entitlement } = session ?? {};
  if (!subject || [accessToken, entitlement].some(value => typeof value !== 'string' || !value || /[\r\n]/.test(value))) throw new TopUpError('ログイン情報を確認できません。アプリで再度ログインしてください。');
  async function json(url, options) {
    let response;
    try { response = await remote(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new TopUpError('Riotの購入サービスに接続できません。ネットワークを確認して再度お試しください。'); }
    if ([401, 403].includes(response.status)) throw new TopUpError('Riotの購入サービスで認証できません。アプリで再度ログインしてください。');
    if (!response.ok) throw new TopUpError(`RiotがVP購入画面を発行できませんでした（HTTP ${response.status}）。ログイン状態を確認してください。`);
    try { return await response.json(); }
    catch { throw new TopUpError('Riotの購入サービスの応答を読み取れません。時間をおいて再度お試しください。'); }
  }
  try {
    // The background Riot launcher exposes a lockfile but no entitlements API.
    // Use the app's authenticated account, as for wallet/store requests.
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const user = await json('https://auth.riotgames.com/userinfo', { headers });
    if (user?.sub !== subject || !/^[a-z]{3}$/i.test(user?.country)) throw new TopUpError('購入先のアカウントと登録国を確認できません。');
    const config = await json('https://clientconfig.rpg.riotgames.com/api/v1/config/player?app=valorant&patchline=live', { headers: { ...headers, 'X-Riot-Entitlements-JWT': entitlement } });
    const platform = config?.['payments.pay_plugin.platforms.valorant']?.[user.country.toUpperCase()];
    if (!platform || !['rgi', 'rgl', 'rgj', 'rgk', 'rgs', 'rgg'].includes(platform.pmc) || !['na', 'eu', 'ap', 'kr', 'br', 'latam'].includes(platform.platformCode)) throw new TopUpError('このアカウントの地域はVP購入に未対応です。');
    // Session schema: installed Riot Client swagger, PaymentsSessionRequest/Response.
    // Endpoint: Riot's public PMC JS. Verified with JP account, without charging.
    const result = await json(`https://edge.${platform.pmc}.pmc.pay.riotgames.com/riotpay/pmc/v2/sessions`, { method: 'POST', headers, body: JSON.stringify({ localeId: 'ja_JP', storefrontAccountCode: `valorant-${platform.platformCode}` }) });
    return paymentURL(result?.pmcStartUrl);
  } catch (error) {
    if (error instanceof TopUpError) throw error;
    throw new TopUpError('RiotからVP購入画面を取得できません。時間をおいて再度お試しください。');
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
      const current = ++generation;
      state = 'opening'; message = '';
      try {
        const session = getSession();
        const url = paymentURL(await createURL(session));
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
