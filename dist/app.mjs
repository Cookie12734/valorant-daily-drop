import { parseAccessory, accessoryTypes } from './accessory.mjs';
import { parseSnapshot, parseNightMarket, parseWallet, remainingTime } from './shop.mjs';

// Browser-only local helper launch. Fragments are not sent over HTTP.
let localApiToken = '';
if (location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('local-api');
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    localApiToken = token;
    history.replaceState(null, '', location.pathname + location.search);
    try { sessionStorage.setItem('daily-drop-local-api', token); } catch { /* Current page still works without storage. */ }
  } else {
    try { localApiToken = sessionStorage.getItem('daily-drop-local-api') || ''; } catch { /* Desktop attaches its capability in the main process. */ }
  }
}
function localFetch(path, options = {}) {
  return fetch(path, { ...options, headers: { ...options.headers, ...(localApiToken ? { 'X-Daily-Drop-Token': localApiToken } : {}) } });
}

const $ = id => document.getElementById(id);
const preview = [
  { id: 'c9678d8c-4327-f397-b0ec-dca3c3d6fb15', name: 'プライム ヴァンダル', weapon: 'ヴァンダル', image: '/assets/prime.png', price: null },
  { id: 'ba42fe63-457a-78ce-4499-47950a698129', name: 'リーヴァー ヴァンダル', weapon: 'ヴァンダル', image: '/assets/reaver.png', price: null },
  { id: 'c00e786e-4e6f-0ef7-0ce3-32ba9918ba41', name: 'オニ ファントム', weapon: 'ファントム', image: '/assets/oni.png', price: null },
  { id: '99b0edce-48db-b898-1d6f-0fa89795226d', name: 'クロナミの刃', weapon: '近接武器', image: '/assets/kuronami.png', price: null },
];
let snapshot = null;
let snapshotMode = 'preview';
let market = 'daily';
let local = false;
let login = false;
let authState = 'signed_out';
let loading = false;
let expired = false;
let operation = 0;
let pollTimer;
let loginStarted = 0;
let logoutState = '';
let purchaseCapable = false;
let purchaseBusy = false;
let selectedOffer = null;
let purchaseOffer = null;
let purchaseQuote = null;
let purchaseState = 'idle';
let purchaseMessage = '';
let purchaseStatusChecked = false;
let walletBusy = false;
let walletOperation = 0;
const metadata = new Map();
const currency = () => market === 'accessory' ? 'KC' : 'VP';
const marketName = () => market === 'accessory' ? 'アクセサリーストア' : 'ナイトマーケット';
const dateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function priceLabel(price) {
  return price === null ? '—' : new Intl.NumberFormat('ja-JP').format(price);
}
function clearWallet() {
  ++walletOperation;
  walletBusy = false;
  $('wallet-dialog').close();
  $('wallet-dialog').setAttribute('aria-busy', 'false');
  $('wallet-balances').hidden = true;
  for (const code of ['VP', 'RP', 'KC']) $('wallet-' + code).textContent = '—';
  $('wallet-message').textContent = '';
}
async function getWallet() {
  if (!local || login && authState !== 'signed_in' || logoutState || purchaseBusy || walletBusy) return;
  const current = ++walletOperation;
  walletBusy = true;
  $('wallet-balances').hidden = true;
  for (const code of ['VP', 'RP', 'KC']) $('wallet-' + code).textContent = '—';
  $('wallet-message').textContent = '残高を取得しています…';
  $('wallet-dialog').setAttribute('aria-busy', 'true');
  if (!$('wallet-dialog').open) $('wallet-dialog').showModal();
  updateControls();
  try {
    const response = await localFetch('/api/wallet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (current !== walletOperation) return;
    if (response.status === 401 && login) { authState = 'signed_out'; clearWallet(); resetPreview(); showError('Riotに再度ログインしてください。'); return; }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '残高を取得できませんでした。');
    const balances = parseWallet(data);
    for (const code of ['VP', 'RP', 'KC']) $('wallet-' + code).textContent = `${priceLabel(balances[code])} ${code}`;
    $('wallet-balances').hidden = false;
    $('wallet-message').textContent = `${timeFormat.format(new Date())} JST 取得 · 最新の残高は「更新」で確認できます。`;
  } catch (error) {
    if (current === walletOperation) $('wallet-message').textContent = ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? '残高を取得できませんでした。接続を確認して再度お試しください。' : error.message;
  } finally {
    if (current === walletOperation) { walletBusy = false; $('wallet-dialog').setAttribute('aria-busy', 'false'); updateControls(); }
  }
}
function canPurchase() {
  return purchaseCapable && local && login && authState === 'signed_in' && snapshotMode === 'local' && snapshot && market !== 'night-market' && !expired && !logoutState;
}
function unresolvedPurchase() {
  return ['pending', 'unknown'].includes(purchaseState);
}
function validPurchaseQuote() {
  return purchaseQuote && purchaseOffer && purchaseQuote.skinId === purchaseOffer.id && Date.parse(purchaseQuote.expiresAt) > Date.now();
}
function updatePurchaseControls() {
  const available = Boolean(canPurchase());
  const ready = Boolean(validPurchaseQuote());
  $('skin-purchase-button').hidden = !available;
  $('skin-purchase-button').disabled = purchaseBusy || loading;
  $('skin-purchase-unavailable').hidden = available;
  $('purchase-dialog').setAttribute('aria-busy', String(purchaseBusy));
  $('purchase-dialog').dataset.state = purchaseState;
  $('purchase-summary').hidden = !purchaseQuote || !purchaseOffer;
  $('purchase-expiry').hidden = !purchaseQuote || purchaseState !== 'idle';
  if (purchaseQuote && purchaseOffer) {
    $('purchase-skin-name').textContent = purchaseOffer.name;
    $('purchase-price').textContent = `${priceLabel(purchaseQuote.price)} ${currency()}`;
    $('purchase-balance').textContent = `${priceLabel(purchaseQuote.balance)} ${currency()}`;
    $('purchase-after-balance').textContent = `${priceLabel(purchaseQuote.balance - purchaseQuote.price)} ${currency()}`;
    $('purchase-expiry').textContent = ready ? 'この確認内容は短時間で失効します。価格と残高を確認して確定してください。' : '確認内容の期限が切れました。再取得してください。';
  }
  $('purchase-message').textContent = purchaseMessage;
  $('purchase-confirm-button').hidden = !purchaseQuote || purchaseState !== 'idle';
  $('purchase-confirm-button').disabled = purchaseBusy || loading || !available || !ready || !purchaseQuote || purchaseQuote.balance < purchaseQuote.price;
  $('purchase-confirm-button').textContent = purchaseQuote ? `${priceLabel(purchaseQuote.price)} ${currency()}で購入を確定` : '購入を確定';
  $('purchase-refresh-button').hidden = !purchaseOffer || purchaseState !== 'idle' || ready;
  $('purchase-refresh-button').disabled = purchaseBusy || loading || !available;
  $('purchase-check-button').hidden = !unresolvedPurchase();
  $('purchase-check-button').disabled = purchaseBusy || !purchaseCapable || authState !== 'signed_in';
  $('purchase-cancel-button').textContent = purchaseQuote && purchaseState === 'idle' ? 'キャンセル' : '閉じる';
  for (const button of document.querySelectorAll('dialog form[method="dialog"] button')) button.disabled = purchaseBusy;
  $('purchase-result').hidden = !purchaseCapable || authState !== 'signed_in' || purchaseState === 'idle';
  $('purchase-result-message').textContent = purchaseMessage;
  $('purchase-result-button').disabled = purchaseBusy;
  $('purchase-result-button').textContent = unresolvedPurchase() ? '購入結果を確認' : '購入結果を見る';
}
function setPurchaseBusy(busy) {
  purchaseBusy = busy;
  updateControls();
}
function showPurchaseDialog() {
  $('skin-dialog').close();
  $('purchase-title').textContent = purchaseOffer ? purchaseOffer.name : '購入結果';
  updatePurchaseControls();
  if (!$('purchase-dialog').open) $('purchase-dialog').showModal();
  $('purchase-message').focus();
}
async function purchaseRequest(path, body = {}) {
  const response = await localFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '購入内容を確認できませんでした。');
  return data;
}
function applyPurchaseResult(result) {
  if (!['idle', 'complete', 'pending', 'unknown', 'failed'].includes(result?.state)) throw new Error('購入結果を読み取れませんでした。');
  purchaseState = result.state;
  purchaseMessage = typeof result.message === 'string' && result.message ? result.message : {
    idle: '', complete: '購入が完了しました。', pending: '購入の結果を確認中です。再送信せず、結果を確認してください。',
    unknown: '購入の結果がまだ確認できません。再送信せず、結果を確認してください。', failed: '購入は完了しませんでした。',
  }[purchaseState];
  purchaseStatusChecked = true;
  if (purchaseState !== 'idle') purchaseQuote = null;
  updatePurchaseControls();
}
async function checkPurchaseStatus() {
  const previous = purchaseState;
  try {
    const result = await purchaseRequest('/api/purchase/status');
    applyPurchaseResult(result);
    return previous !== 'complete' && purchaseState === 'complete';
  } catch (error) {
    purchaseState = 'unknown';
    purchaseStatusChecked = false;
    purchaseMessage = ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? 'アプリに接続できず、購入の結果を確認できません。再送信せず、結果を確認してください。' : error.message;
    updatePurchaseControls();
    return false;
  }
}
async function requestPurchaseQuote(offer) {
  if (purchaseBusy || loading || !canPurchase() || !offer || !Number.isSafeInteger(offer.price)) return;
  if (unresolvedPurchase()) { showPurchaseDialog(); return; }
  purchaseOffer = { ...offer };
  purchaseQuote = null;
  purchaseState = 'idle';
  purchaseMessage = '購入の未確定結果と最新の価格・残高を確認しています…';
  showPurchaseDialog();
  setPurchaseBusy(true);
  try {
    await checkPurchaseStatus();
    if (!purchaseStatusChecked || unresolvedPurchase()) {
      purchaseOffer = null;
      showPurchaseDialog();
      return;
    }
    purchaseState = 'idle';
    purchaseMessage = '最新の価格と残高を確認しています…';
    updatePurchaseControls();
    const quote = await purchaseRequest('/api/purchase/quote', { skinId: offer.id, expectedPrice: offer.price, ...(market === 'accessory' ? { mode: 'accessory' } : {}) });
    if (purchaseOffer.id !== offer.id || !canPurchase()) return;
    if (!quote || (market === 'accessory' && quote.currency !== 'KC') || typeof quote.quoteId !== 'string' || !quote.quoteId || quote.skinId !== offer.id || quote.price !== offer.price || !Number.isSafeInteger(quote.price) || quote.price <= 0 || !Number.isSafeInteger(quote.balance) || quote.balance < 0 || typeof quote.expiresAt !== 'string' || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('購入内容が変更されたか、期限が切れました。ショップを更新して再確認してください。');
    purchaseQuote = quote;
    purchaseMessage = quote.balance < quote.price ? `${currency()}残高が不足しています。購入は確定できません。` : 'この商品を、この価格で購入します。内容を確認してから確定してください。';
  } catch (error) {
    purchaseQuote = null;
    purchaseMessage = ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? '購入内容を取得できませんでした。接続を確認して再取得してください。' : error.message;
  } finally {
    setPurchaseBusy(false);
    if ($('purchase-dialog').open) $('purchase-message').focus();
  }
}
async function confirmPurchase() {
  if (purchaseBusy || loading || !canPurchase() || !validPurchaseQuote() || !purchaseStatusChecked || purchaseQuote.balance < purchaseQuote.price || unresolvedPurchase()) { updatePurchaseControls(); return; }
  const quoteId = purchaseQuote.quoteId;
  clearWallet();
  // Consume the UI quote before sending: a lost response must never resend it.
  purchaseQuote = null;
  purchaseState = 'pending';
  purchaseMessage = '購入を送信しています。画面を閉じずにお待ちください…';
  setPurchaseBusy(true);
  try {
    const result = await purchaseRequest('/api/purchase/confirm', { quoteId });
    if (!['complete', 'pending', 'unknown', 'failed'].includes(result?.state)) throw new Error('購入の結果を読み取れませんでした。再送信せず、結果を確認してください。');
    applyPurchaseResult(result);
  } catch (error) {
    purchaseState = 'unknown';
    purchaseStatusChecked = false;
    purchaseMessage = ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? '接続が途切れたため、購入の結果は不明です。再送信せず、結果を確認してください。' : error.message;
  } finally {
    setPurchaseBusy(false);
    if ($('purchase-dialog').open) $('purchase-message').focus();
  }
  if (purchaseState === 'complete' && market !== 'night-market') await getShop();
}
async function refreshPurchaseResult() {
  if (purchaseBusy || !purchaseCapable || authState !== 'signed_in') return;
  setPurchaseBusy(true);
  const completed = await checkPurchaseStatus();
  if (purchaseState === 'idle') purchaseMessage = '未確定の購入はありません。商品を選び、購入内容を改めて確認できます。';
  setPurchaseBusy(false);
  if ($('purchase-dialog').open) $('purchase-message').focus();
  if (completed && market !== 'night-market') await getShop();
}
function renderCards(offers) {
  $('shop-grid').replaceChildren(...offers.map((offer, index) => {
    const card = node('button', 'skin-card');
    card.type = 'button';
    card.disabled = purchaseBusy;
    card.dataset.skinId = offer.id;
    card.dataset.weapon = offer.weapon;
    card.setAttribute('aria-label', `${offer.name}、${offer.price === null ? '価格未取得' : `${priceLabel(offer.price)} ${currency()}`}、詳細を見る`);
    const top = node('div', 'card-top');
    top.append(node('span', '', offer.weapon), node('span', 'card-number', String(index + 1).padStart(2, '0')));
    const art = node('div', 'weapon-art');
    if (offer.image) {
      const image = node('img', '');
      image.src = offer.image;
      image.alt = '';
      image.width = 400;
      image.height = 180;
      image.decoding = 'async';
      if (index === 0) image.fetchPriority = 'high';
      image.addEventListener('error', () => art.replaceChildren(node('span', 'small-label', '画像を取得できません')), { once: true });
      art.append(image);
    } else art.append(node('span', 'small-label', offer.itemTypeId === 'de7caa6b-adf7-4588-bbd1-143831e786c6' ? offer.name : '画像なし'));
    const content = node('div', 'card-content');
    content.append(node('span', 'skin-name', offer.name), node('span', 'card-subtitle', snapshot ? market === 'daily' ? 'デイリーオファー' : marketName() : 'プレビュー'));
    const price = node('div', 'card-price');
    price.append(node('span', 'vp-mark', market === 'accessory' ? 'K' : 'V'), node('span', '', priceLabel(offer.price)), node('span', 'price-unit', currency()));
    if (offer.originalPrice !== undefined) {
      const discount = node('div', 'discount');
      discount.append(node('del', '', priceLabel(offer.originalPrice) + ' VP'), node('span', '', offer.discountPercent + '% OFF'));
      content.append(discount);
    }
    content.append(price);
    card.append(top, art, content);
    card.addEventListener('click', () => {
      if (purchaseBusy) return;
      selectedOffer = offer;
      $('skin-title').textContent = offer.name;
      $('skin-weapon').textContent = offer.weapon;
      $('skin-image').hidden = !offer.image;
      if (offer.image) $('skin-image').src = offer.image;
      $('skin-image').alt = offer.name;
      $('skin-price').textContent = offer.price === null ? '価格未取得' : `${priceLabel(offer.price)} ${currency()}`;
      updatePurchaseControls();
      $('skin-dialog').showModal();
    });
    return card;
  }));
  $('offer-count').textContent = String(offers.length).padStart(2, '0');
  if (!offers.length) $('shop-grid').append(node('p', 'small-label', market === 'daily' ? '現在、デイリーオファーがありません。ゲーム内のショップを確認してください。' : market === 'accessory' ? snapshot ? '現在、表示できるアクセサリーはありません。' : '接続後にアクセサリーストアを確認できます。' : !snapshot ? '接続後にナイトマーケットを確認できます。' : !snapshot.active ? '現在、このアカウントのナイトマーケットは開催されていません。' : '表示できるナイトマーケットの商品がありません。'));
}
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  $('load-button').dataset.state = 'error';
}
function updateControls() {
  const pending = login && authState === 'pending';
  $('wallet-button').hidden = !local || login && authState !== 'signed_in';
  $('wallet-button').disabled = purchaseBusy || loading || walletBusy || Boolean(logoutState);
  $('wallet-refresh-button').disabled = walletBusy || purchaseBusy || Boolean(logoutState) || !local || login && authState !== 'signed_in';
  $('wallet-refresh-button').textContent = walletBusy ? '取得中…' : '更新';
  $('load-button').disabled = purchaseBusy || loading || pending || Boolean(logoutState);
  for (const id of ['daily-button', 'night-button', 'accessory-button']) $(id).disabled = purchaseBusy || loading || pending || Boolean(logoutState);
  $('logout-button').hidden = !login || !logoutState && !['pending', 'signed_in', 'error'].includes(authState);
  $('logout-button').disabled = purchaseBusy || Boolean(logoutState);
  $('logout-label').textContent = logoutState ? '終了中…' : pending ? 'キャンセル' : 'ログアウト';
  $('dialog-import').disabled = purchaseBusy || loading || pending || Boolean(logoutState);
  $('file-input').disabled = purchaseBusy || loading || pending || Boolean(logoutState);
  $('preview-button').disabled = purchaseBusy || loading;
  for (const id of ['help-button', 'setup-button']) $(id).disabled = purchaseBusy;
  for (const card of $('shop-grid').querySelectorAll('button')) card.disabled = purchaseBusy;
  $('shop-grid').setAttribute('aria-busy', String(purchaseBusy || loading));
  $('load-label').textContent = logoutState ? '終了中…' : loading ? 'ショップを取得中…' : pending ? 'ログイン待ち…' :
    login && authState === 'signed_in' ? 'ショップを更新' : local && !login ? 'ショップを取得' : 'Riotでログイン';
  $('load-button').dataset.state = loading || pending ? 'loading' : $('error').hidden ? 'default' : 'error';
  if (pending) $('connection-label').textContent = 'ログイン待ち';
  else if (login && authState === 'signed_in' && !snapshot) $('connection-label').textContent = 'ログイン済み';
  else if (!snapshot) $('connection-label').textContent = '未接続';
  updatePurchaseControls();
}
function setLoading(busy) {
  loading = busy;
  updateControls();
}
async function skinInfo(offer) {
  if (!metadata.has(offer.id)) {
    const type = accessoryTypes[offer.itemTypeId];
    const response = await fetch(`https://valorant-api.com/v1/${type?.[0] ?? 'weapons/skinlevels'}/${offer.id}?language=ja-JP`, { signal: AbortSignal.timeout(12000), credentials: 'omit' });
    if (!response.ok) throw new Error('metadata');
    const { data } = await response.json();
    const icon = data.largeArt ?? data.fullTransparentIcon ?? data.displayIcon;
    const imageURL = icon ? new URL(icon) : null;
    if (imageURL && imageURL.origin !== 'https://media.valorant-api.com' || typeof data.displayName !== 'string') throw new Error('metadata');
    const weapon = type?.[1] ?? (['ヴァンダル', 'ファントム', 'クラシック', 'ショーティー', 'フレンジー', 'ゴースト', 'シェリフ', 'スティンガー', 'スペクター', 'バッキー', 'ジャッジ', 'ブルドッグ', 'ガーディアン', 'マーシャル', 'アウトロー', 'オペレーター', 'アレス', 'オーディン'].find(name => data.displayName.includes(name)) || '近接武器');
    metadata.set(offer.id, { name: data.titleText || data.displayName, image: imageURL?.href ?? null, weapon });
  }
  return { ...offer, ...metadata.get(offer.id) };
}
async function displaySnapshot(value, mode, currentOperation) {
  const next = market === 'accessory' ? parseAccessory(value) : market === 'daily' ? parseSnapshot(value) : parseNightMarket(value);
  const results = await Promise.allSettled(next.offers.map(skinInfo));
  if (currentOperation !== operation) return;
  const offers = results.map((result, index) => result.status === 'fulfilled' ? result.value :
    { ...next.offers[index], name: `商品 ${index + 1}`, weapon: '情報未取得', image: null });
  snapshot = next;
  snapshotMode = mode;
  purchaseQuote = null;
  expired = false;
  renderCards(offers);
  $('connection-label').textContent = mode === 'local' ? `${next.region.toUpperCase()} · 接続済み` : `${next.region.toUpperCase()} · ファイル`;
  $('notice-tag').textContent = mode === 'local' ? 'YOUR SHOP' : 'SNAPSHOT';
  $('notice-text').textContent = mode === 'local' ? 'Riotから取得した、あなた専用のショップです。' : 'ファイル取得時点のショップです。最新情報はファイルを再取得してください。';
  $('shop-status').textContent = `${timeFormat.format(new Date(next.fetchedAt))} JST 取得${results.some(result => result.status === 'rejected') ? ' · 一部の商品情報を取得できません。再読み込みしてください。' : ''}`;
  $('expiry-label').textContent = next.expiresAt ? `${timeFormat.format(new Date(next.expiresAt))} JST ${market !== 'night-market' ? '更新' : '終了'}` : '開催期間なし';
  $('preview-button').hidden = false;
  tick();
  updatePurchaseControls();
}
function tick() {
  if (purchaseQuote && !validPurchaseQuote()) {
    purchaseMessage = '確認内容の期限が切れました。購入内容を再取得してください。';
    updatePurchaseControls();
  }
  if (!snapshot) return;
  if (snapshot.expiresAt === null) { $('clock').textContent = '開催なし'; return; }
  $('clock').textContent = remainingTime(snapshot.expiresAt);
  if (Date.now() >= Date.parse(snapshot.expiresAt) && !expired) {
    expired = true;
    $('notice-tag').textContent = 'EXPIRED';
    $('notice-text').textContent = 'このショップの表示期限が切れました。最新のショップを再取得してください。';
    $('connection-label').textContent = '期限切れ';
    $('shop-status').textContent = '表示中のオファーは過去のショップです。最新情報を再取得してください。';
    updatePurchaseControls();
  }
}
function resetPreview() {
  if (purchaseBusy) return;
  snapshot = null;
  snapshotMode = 'preview';
  purchaseQuote = null;
  purchaseOffer = null;
  selectedOffer = null;
  $('error').hidden = true;
  $('clock').textContent = '— : — : —';
  $('connection-label').textContent = '未接続';
  $('notice-tag').textContent = 'PREVIEW';
  $('notice-text').textContent = '表示例です。あなたの今日のショップは接続後に表示されます。';
  $('expiry-label').textContent = '接続後に表示';
  $('shop-status').textContent = 'プレビュー · 価格はショップ取得後に表示';
  $('preview-button').hidden = true;
  renderCards(market === 'daily' ? preview : []);
  if (market !== 'daily') { $('notice-tag').textContent = market === 'accessory' ? 'ACCESSORY STORE' : 'NIGHT MARKET'; $('notice-text').textContent = `接続すると、あなたの${marketName()}を確認できます。`; $('shop-status').textContent = '未取得'; }
  updateControls();
}
async function getShop() {
  if (purchaseBusy) return;
  purchaseQuote = null;
  const currentOperation = ++operation;
  $('error').hidden = true;
  setLoading(true);
  try {
    const response = await localFetch(market === 'daily' ? '/api/shop' : market === 'accessory' ? '/api/accessory' : '/api/night-market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (currentOperation !== operation) return;
    if (response.status === 401 && login) { authState = 'signed_out'; clearWallet(); resetPreview(); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'ショップを取得できませんでした。もう一度ログインして取得してください。');
    await displaySnapshot(data, 'local', currentOperation);
  } catch (error) {
    if (currentOperation === operation) showError(error.name === 'TimeoutError' ? '取得に時間がかかっています。ネットワークを確認して、もう一度取得してください。' : ['TypeError', 'SyntaxError'].includes(error.name) ? 'アプリに接続できません。再起動してお試しください。' : error.message);
  } finally {
    if (currentOperation === operation) setLoading(false);
  }
}
function applyStatus(status) {
  local = status?.local === true;
  login = local && status.login === true;
  purchaseCapable = login && status.purchase === true;
  const previous = authState;
  authState = login && ['signed_out', 'pending', 'signed_in', 'error'].includes(status.auth?.state) ? status.auth.state : 'signed_out';
  if (!local || login && authState !== 'signed_in') clearWallet();
  if (authState !== 'error') $('error').hidden = true;
  clearTimeout(pollTimer);
  if (login && authState === 'pending') {
    if (previous !== 'pending') loginStarted = Date.now();
    pollTimer = setTimeout(pollLogin, 1000);
  }
  if (login && authState === 'error') showError(typeof status.auth.error === 'string' ? status.auth.error : 'ログインできませんでした。もう一度お試しください。');
  updateControls();
  if (login && authState === 'signed_in' && previous !== 'signed_in') {
    const currentOperation = operation;
    (async () => {
      if (purchaseCapable) {
        setPurchaseBusy(true);
        await checkPurchaseStatus();
        setPurchaseBusy(false);
      }
      if (currentOperation === operation && authState === 'signed_in') getShop();
    })();
  }
}
async function pollLogin() {
  if (authState !== 'pending') return;
  const currentOperation = operation;
  if (Date.now() - loginStarted >= 10 * 60 * 1000) {
    await logout();
    clearTimeout(pollTimer);
    if (authState === 'pending') { authState = 'error'; updateControls(); }
    showError('ログインの待ち時間を超えました。もう一度ログインしてください。');
    return;
  }
  try {
    const response = await localFetch('/api/status', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('status');
    const status = await response.json();
    if (authState === 'pending' && currentOperation === operation) applyStatus(status);
  } catch {
    if (authState === 'pending' && currentOperation === operation) {
      showError('アプリに接続できません。キャンセルして再度お試しください。');
      pollTimer = setTimeout(pollLogin, 1000);
    }
  }
}
async function startLogin() {
  if (purchaseBusy) return;
  clearWallet();
  const currentOperation = ++operation;
  $('error').hidden = true;
  authState = 'pending';
  loginStarted = Date.now();
  updateControls();
  try {
    const response = await localFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (currentOperation !== operation) return;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'ログイン画面を開けませんでした。もう一度お試しください。');
    applyStatus(data);
  } catch (error) {
    if (currentOperation !== operation) return;
    authState = 'error';
    showError(['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? 'ログイン画面を開けませんでした。アプリを再起動してお試しください。' : error.message);
    updateControls();
  }
}
async function logout() {
  if (purchaseBusy || logoutState) return;
  clearWallet();
  ++operation;
  clearTimeout(pollTimer);
  logoutState = authState;
  authState = 'signed_out';
  loading = false;
  resetPreview();
  $('skin-dialog').close();
  $('purchase-dialog').close();
  try {
    const response = await localFetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('logout');
    purchaseQuote = null;
    purchaseOffer = null;
    purchaseState = 'idle';
    purchaseMessage = '';
    purchaseStatusChecked = false;
  } catch {
    authState = logoutState;
    if (authState === 'pending') pollTimer = setTimeout(pollLogin, 1000);
    showError('保存したログイン情報を削除できませんでした。もう一度ログアウトしてください。');
  } finally {
    logoutState = '';
    updateControls();
  }
}
$('load-button').addEventListener('click', () => {
  if (purchaseBusy || loading || logoutState || authState === 'pending') return;
  if (!local) { $('help-dialog').showModal(); return; }
  if (login && authState !== 'signed_in') startLogin();
  else getShop();
});
$('logout-button').addEventListener('click', logout);
$('wallet-button').addEventListener('click', getWallet);
$('wallet-refresh-button').addEventListener('click', getWallet);
function selectMarket(next) {
  market = next;
  document.body.dataset.market = market;
  $('daily-button').setAttribute('aria-pressed', String(market === 'daily'));
  $('night-button').setAttribute('aria-pressed', String(market === 'night-market'));
  $('accessory-button').setAttribute('aria-pressed', String(market === 'accessory'));
  $('view-title').textContent = market === 'daily' ? '今日のショップ' : marketName();
  $('shop-heading').textContent = market === 'daily' ? 'デイリーオファー' : market === 'accessory' ? 'アクセサリー' : '期間限定オファー';
  $('clock-label').textContent = market !== 'night-market' ? 'ショップ更新まで' : '開催終了まで';
}
for (const [id, next] of [['daily-button', 'daily'], ['night-button', 'night-market'], ['accessory-button', 'accessory']]) $(id).addEventListener('click', () => {
  if (purchaseBusy || market === next || loading || logoutState || authState === 'pending') return;
  ++operation;
  $('skin-dialog').close();
  $('purchase-dialog').close();
  selectMarket(next);
  resetPreview();
  if (local && (!login || authState === 'signed_in')) getShop();
});
$('file-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || purchaseBusy || loading || logoutState || authState === 'pending') return;
  const currentOperation = ++operation;
  $('error').hidden = true;
  setLoading(true);
  try {
    if (file.size > 32768) throw new Error('ファイルが大きすぎます。npm run shopで生成したshop.jsonを選んでください。');
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('JSONファイルを読み取れません。shop.jsonを再取得してください。'); }
    selectMarket(data?.kind === 'accessory' ? 'accessory' : data?.kind === 'night-market' ? 'night-market' : 'daily');
    resetPreview();
    await displaySnapshot(data, 'file', currentOperation);
  } catch (error) { if (currentOperation === operation) showError(error.message); }
  finally { if (currentOperation === operation) setLoading(false); }
  event.target.value = '';
});
for (const id of ['help-button', 'setup-button']) $(id).addEventListener('click', () => { if (!purchaseBusy) $('help-dialog').showModal(); });
$('dialog-import').addEventListener('click', () => { if (!purchaseBusy) { $('help-dialog').close(); $('file-input').click(); } });
$('preview-button').addEventListener('click', resetPreview);
$('skin-purchase-button').addEventListener('click', () => requestPurchaseQuote(selectedOffer));
$('purchase-refresh-button').addEventListener('click', () => requestPurchaseQuote(purchaseOffer));
$('purchase-confirm-button').addEventListener('click', confirmPurchase);
$('purchase-check-button').addEventListener('click', refreshPurchaseResult);
$('purchase-result-button').addEventListener('click', () => { if (!purchaseBusy) showPurchaseDialog(); });
$('purchase-dialog').addEventListener('close', () => {
  if (purchaseState === 'idle') { purchaseQuote = null; updatePurchaseControls(); }
  const card = [...$('shop-grid').querySelectorAll('button')].find(button => button.dataset.skinId === selectedOffer?.id);
  (!$('purchase-result').hidden ? $('purchase-result-button') : card || $('load-button')).focus();
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', event => { if (purchaseBusy) event.preventDefault(); });
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (!purchaseBusy && event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
$('today').textContent = dateFormat.format(new Date());
$('today').dateTime = new Date().toISOString();
resetPreview();
setInterval(tick, 1000);
if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
  localFetch('/api/status', { signal: AbortSignal.timeout(3000), credentials: 'same-origin' })
    .then(response => { if (response.status === 403) showError('アプリを再起動するか、起動時に表示された専用URLから接続してください。'); return response.ok ? response.json() : null; })
    .then(status => { if (status) applyStatus(status); })
    .catch(() => {});
}
