const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const token = /^[A-Za-z0-9._~+/-]+=*$/;
export class ProbeError extends Error {
  constructor(stage, status = 0, reason = 'response') { super(stage); this.stage = stage; this.status = status; this.reason = reason; }
}
export function transportReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  // Never return arbitrary exception text: it may contain credentials.
  const message = String(error?.message ?? '');
  if (/illegal invocation|incorrect this|requires.*this/i.test(message)) return 'runtime-binding';
  if (/cache.*(not supported|unsupported)|unsupported.*cache/i.test(message)) return 'runtime-cache';
  if (/redirect/i.test(message)) return 'redirect';
  if (['ENOTFOUND','EAI_AGAIN'].includes(error?.cause?.code)) return 'dns';
  if (error?.name === 'TypeError') return 'network-type-error';
  return 'network';
}
export function parseCallback(raw, state) {
  if (typeof raw !== 'string' || raw.length > 40000 || !/^[a-f0-9]{64}$/.test(state ?? '')) throw new ProbeError('URL確認');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new ProbeError('URL確認'); }
  if (url.origin !== 'https://playvalorant.com' || url.username || url.password || url.search || !/^\/(?:[a-z]{2}-[a-z]{2}\/)?opt_in\/?$/.test(url.pathname)) throw new ProbeError('URL確認');
  const data = new URLSearchParams(url.hash.slice(1));
  if (data.has('error') || ['state','access_token','id_token','token_type','expires_in'].some(k => data.getAll(k).length !== 1) || data.get('state') !== state || data.get('token_type').toLowerCase() !== 'bearer') throw new ProbeError('URL確認');
  const accessToken = data.get('access_token'), idToken = data.get('id_token');
  if (![accessToken,idToken].every(t => t && t.length <= 16384 && token.test(t))) throw new ProbeError('URL確認');
  const seconds = Number(data.get('expires_in'));
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) throw new ProbeError('URL確認');
  return { accessToken, idToken };
}
export async function probeShop(tokens, request = fetch) {
  async function json(stage, url, options = {}) {
    let response;
    // workerd rejects redirect:'error'. Inspect 3xx manually without ever
    // forwarding the Authorization header to a redirect destination.
    try { response = await request(url, { ...options, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw new ProbeError(stage, 0, transportReason(error)); }
    if (response.status >= 300 && response.status < 400) throw new ProbeError(stage, response.status, 'redirect');
    if (!response.ok) throw new ProbeError(stage, response.status);
    try { return await response.json(); } catch { throw new ProbeError(stage, response.status, 'json'); }
  }
  const headers = { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' };
  const player = await json('アカウント確認', 'https://auth.riotgames.com/userinfo', {headers});
  if (!uuid.test(player?.sub ?? '')) throw new ProbeError('アカウント確認');
  const ent = await json('利用権確認','https://entitlements.auth.riotgames.com/api/token/v1',{method:'POST',headers,body:'{}'});
  if (typeof ent?.entitlements_token !== 'string' || !token.test(ent.entitlements_token) || ent.entitlements_token.length > 16384) throw new ProbeError('利用権確認');
  const geo = await json('地域確認','https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant',{method:'PUT',headers,body:JSON.stringify({id_token:tokens.idToken})});
  const region = geo?.affinities?.live;
  if (!['na','latam','br','eu','ap','kr'].includes(region)) throw new ProbeError('地域確認');
  const shard = ['latam','br'].includes(region) ? 'na' : region;
  const version = (await json('バージョン確認','https://valorant-api.com/v1/version'))?.data?.riotClientVersion;
  if (typeof version !== 'string' || !/^release-\d+\.\d+-shipping-\d+-\d+$/.test(version)) throw new ProbeError('バージョン確認');
  const platform = btoa(JSON.stringify({platformType:'PC',platformOS:'Windows',platformOSVersion:'10.0.19042.1.256.64bit',platformChipset:'Unknown'}));
  const store = await json('ショップ取得',`https://pd.${shard}.a.pvp.net/store/v3/storefront/${player.sub}`,{method:'POST',body:'{}',headers:{...headers,'X-Riot-Entitlements-JWT':ent.entitlements_token,'X-Riot-ClientPlatform':platform,'X-Riot-ClientVersion':version}});
  const offers = store?.SkinsPanelLayout?.SingleItemStoreOffers;
  if (!Array.isArray(offers) || offers.length < 1 || offers.length > 4) throw new ProbeError('ショップ形式確認');
  const items = [];
  for (const offer of offers) {
    const id = offer?.Rewards?.[0]?.ItemID;
    const price = offer?.Cost?.['85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741'];
    if (!uuid.test(id ?? '') || !Number.isSafeInteger(price) || price < 0) throw new ProbeError('ショップ形式確認');
    // Public catalog only; never attach Riot credentials here.
    let name = id;
    try { const skin = await json('商品名確認',`https://valorant-api.com/v1/weapons/skinlevels/${id}?language=ja-JP`); if (typeof skin?.data?.displayName === 'string') name = skin.data.displayName.slice(0,200); } catch {}
    items.push({id,name,price});
  }
  return {ok:true,items,checkedAt:new Date().toISOString()};
}
