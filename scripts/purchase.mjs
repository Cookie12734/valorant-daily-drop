import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const SKIN = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
const PLATFORM = Buffer.from(JSON.stringify({ platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' })).toString('base64');
const unresolved = value => value && ['pending', 'unknown'].includes(value.state);
const accountKey = session => createHash('sha256').update(session.subject).digest('hex');
export class PurchaseError extends Error {}

// One outstanding order, persisted BEFORE sending. Never retry a purchase POST.
export function createPurchaseController({ getSession, journalFile, request = fetch, now = Date.now }) {
  let quote, busy = false, record;
  const ready = readFile(journalFile, 'utf8').then(text => {
    const value = JSON.parse(text);
    if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.account) || !UUID.test(value.skinId) || !UUID.test(value.offerId) || !UUID.test(value.quoteId) || !UUID.test(value.xid) || !['pending', 'unknown', 'complete', 'failed'].includes(value.state) || value.orderId && !UUID.test(value.orderId)) throw new Error('Invalid purchase journal');
    record = value;
  }).catch(error => { if (error.code !== 'ENOENT') throw new PurchaseError('購入記録を読み取れません。安全のため購入を停止しました。'); });
  // Avoid an unhandled rejection before the first user action; actions still fail closed.
  ready.catch(() => {});

  async function save(value) {
    const file = await open(`${journalFile}.tmp`, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(`${journalFile}.tmp`, journalFile);
    record = value;
  }
  async function json(url, options = {}) {
    let response;
    try { response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new PurchaseError('Riotへの接続に失敗しました。'); }
    if (!response.ok) throw new PurchaseError(`Riotの購入APIが応答を拒否しました（HTTP ${response.status}）。`);
    try { return await response.json(); } catch { throw new PurchaseError('Riotの応答を確認できません。'); }
  }
  async function context(session) {
    if (!['na', 'eu', 'ap', 'kr'].includes(session.shard) || !UUID.test(session.subject)) throw new PurchaseError('接続先を確認できません。');
    const version = (await json('https://valorant-api.com/v1/version')).data?.riotClientVersion;
    if (typeof version !== 'string' || !/^release-\d+\.\d+-shipping-\d+-\d+$/.test(version)) throw new PurchaseError('ゲームのバージョンを確認できません。');
    return { base: `https://pd.${session.shard}.a.pvp.net`, headers: { Authorization: `Bearer ${session.accessToken}`, 'X-Riot-Entitlements-JWT': session.entitlement, 'X-Riot-ClientPlatform': PLATFORM, 'X-Riot-ClientVersion': version, 'Content-Type': 'application/json' } };
  }
  function stillSignedIn(session) {
    if (getSession() !== session) throw new PurchaseError('ログイン状態が変わったため購入を中止しました。');
  }
  async function owned(ctx, session, skinId) {
    const data = await json(`${ctx.base}/store/v1/entitlements/${session.subject}/${SKIN}`, { headers: ctx.headers });
    if (!Array.isArray(data.Entitlements) || data.Entitlements.some(item => !UUID.test(item?.ItemID))) throw new PurchaseError('所持スキンを確認できません。');
    return data.Entitlements.some(item => item.ItemID.toLowerCase() === skinId);
  }
  async function inspect(session, skinId, price) {
    const ctx = await context(session);
    const store = await json(`${ctx.base}/store/v3/storefront/${session.subject}`, { method: 'POST', headers: ctx.headers, body: '{}' });
    const panel = store.SkinsPanelLayout;
    const offers = panel?.SingleItemStoreOffers;
    if (!Number.isSafeInteger(panel?.SingleItemOffersRemainingDurationInSeconds) || panel.SingleItemOffersRemainingDurationInSeconds < 120 || !Array.isArray(offers) || offers.length > 4) throw new PurchaseError('ショップ更新直前、または商品情報を確認できないため購入できません。');
    const candidates = offers.filter(offer => offer?.Rewards?.some(reward => reward.ItemID?.toLowerCase() === skinId));
    const offer = candidates[0];
    if (candidates.length !== 1 || !UUID.test(offer?.OfferID) || offer.IsDirectPurchase !== true || !panel.SingleItemOffers?.includes(offer.OfferID) || !Array.isArray(offer.Rewards) || offer.Rewards.length !== 1 || offer.Rewards[0].ItemTypeID !== SKIN || offer.Rewards[0].Quantity !== 1 || !offer.Cost || Object.keys(offer.Cost).length !== 1 || !Number.isSafeInteger(offer.Cost[VP]) || offer.Cost[VP] <= 0 || offer.Cost[VP] !== price) throw new PurchaseError('商品または価格が変わりました。ショップを更新してください。');
    const wallet = await json(`${ctx.base}/store/v1/wallet/${session.subject}`, { headers: ctx.headers });
    const balance = wallet.Balances?.[VP];
    if (!Number.isSafeInteger(balance) || balance < price) throw new PurchaseError('VPが不足しているか、残高を確認できません。');
    if (await owned(ctx, session, skinId)) throw new PurchaseError('このスキンは既に所持しています。');
    stillSignedIn(session);
    return { ctx, offerId: offer.OfferID, balance };
  }
  function result(value = record) {
    if (!value) return { state: 'idle' };
    const messages = {
      complete: 'スキンの購入完了、または所持を確認しました。',
      failed: '購入は完了していません。商品と価格を改めて確認してください。',
      pending: '購入を処理中です。「購入結果を確認」で確認してください。',
      unknown: '購入結果を確認できません。二重購入を防ぐため再送信を停止しています。「購入結果を確認」を押してください。',
    };
    return { state: value.state, message: messages[value.state] };
  }
  async function run(action) {
    if (busy) throw new PurchaseError('購入処理中です。少し待ってから結果を確認してください。');
    busy = true;
    try { await ready; return await action(); } finally { busy = false; }
  }
  async function reconcile(session) {
    if (!record) return result();
    if (record.account !== accountKey(session)) {
      if (unresolved(record)) throw new PurchaseError('別アカウントの購入結果が未確認です。元のアカウントで結果を確認してください。');
      return result(null);
    }
    if (!unresolved(record)) return result();
    try {
      const ctx = await context(session);
      if (record.orderId) {
        const data = await json(`${ctx.base}/store/v1/order/${record.orderId}`, { headers: ctx.headers });
        if (data.OrderID !== record.orderId || !['ACCEPTED', 'COMPLETE', 'FAILED'].includes(data.Status)) throw new Error('Invalid order status');
        const state = data.Status === 'FAILED' ? 'failed' : data.Status === 'COMPLETE' && await owned(ctx, session, record.skinId) ? 'complete' : 'pending';
        await save({ ...record, state });
      } else if (await owned(ctx, session, record.skinId)) {
        await save({ ...record, state: 'complete' });
      }
    } catch { /* Missing results must never authorize a second purchase. */ }
    stillSignedIn(session);
    return result();
  }
  return {
    quote(input) { return run(async () => {
      quote = undefined;
      const session = getSession();
      if (!input || Object.keys(input).sort().join(',') !== 'expectedPrice,skinId' || typeof input.skinId !== 'string' || !UUID.test(input.skinId) || !Number.isSafeInteger(input.expectedPrice) || input.expectedPrice <= 0) throw new PurchaseError('購入する商品と価格を確認してください。');
      if (unresolved(record)) throw new PurchaseError('前回の購入結果が未確認です。先に購入結果を確認してください。');
      const skinId = input.skinId.toLowerCase();
      const { offerId, balance } = await inspect(session, skinId, input.expectedPrice);
      quote = { quoteId: randomUUID(), session, skinId, offerId, price: input.expectedPrice, balance, expiresAt: now() + 60000 };
      return { quoteId: quote.quoteId, skinId, price: quote.price, balance, expiresAt: new Date(quote.expiresAt).toISOString() };
    }); },
    confirm(input) { return run(async () => {
      const session = getSession();
      if (!input || Object.keys(input).join(',') !== 'quoteId' || !UUID.test(input.quoteId)) throw new PurchaseError('購入確認情報が不正です。');
      if (record?.quoteId === input.quoteId && record.account === accountKey(session)) return result();
      const selected = quote;
      if (!selected || selected.quoteId !== input.quoteId || selected.session !== session || selected.expiresAt <= now() || unresolved(record)) throw new PurchaseError('購入確認の有効期限が切れたか、前回の購入が未確認です。');
      quote = undefined;
      const { ctx, offerId, balance } = await inspect(session, selected.skinId, selected.price);
      if (offerId !== selected.offerId || balance !== selected.balance || selected.expiresAt <= now()) throw new PurchaseError('商品情報または残高が変わりました。もう一度確認してください。');
      const next = { schemaVersion: 1, account: accountKey(session), quoteId: selected.quoteId, skinId: selected.skinId, offerId, price: selected.price, xid: randomUUID(), state: 'unknown' };
      // A crash after this write is ambiguous even if no HTTP response arrives.
      await save(next);
      try {
        stillSignedIn(session);
        if (selected.expiresAt <= now()) throw new PurchaseError('購入確認の有効期限が切れました。もう一度確認してください。');
      } catch (error) { await save({ ...next, state: 'failed' }); throw error; }
      try {
        // Unofficial contract; no live-money test. Never invent a retry or fallback payload.
        // https://github.com/PrometheuzzZ/valorant-api-docs/blob/trunk/valorant-api-types/src/endpoints/store/CreateOrder.ts
        const data = await json(`${ctx.base}/store/v1/order/`, { method: 'POST', headers: ctx.headers, body: JSON.stringify({ XID: next.xid, OfferID: offerId }) });
        if (!UUID.test(data.OrderID) || !['ACCEPTED', 'COMPLETE', 'FAILED'].includes(data.Status)) throw new Error('Unrecognized order result');
        await save({ ...next, orderId: data.OrderID, state: data.Status === 'FAILED' ? 'failed' : 'pending' });
      } catch { /* The persisted unknown state blocks retries, including after restart. */ }
      return reconcile(session);
    }); },
    status() { return run(() => reconcile(getSession())); },
  };
}
