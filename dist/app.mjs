import { parseSnapshot, parseNightMarket, remainingTime } from './shop.mjs';

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
const metadata = new Map();
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
function renderCards(offers) {
  $('shop-grid').replaceChildren(...offers.map((offer, index) => {
    const card = node('button', 'skin-card');
    card.type = 'button';
    card.dataset.weapon = offer.weapon;
    card.setAttribute('aria-label', `${offer.name}、${offer.price === null ? '価格未取得' : `${priceLabel(offer.price)} VP`}、詳細を見る`);
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
    } else art.append(node('span', 'small-label', 'スキン情報を取得できません'));
    const content = node('div', 'card-content');
    content.append(node('span', 'skin-name', offer.name), node('span', 'card-subtitle', snapshot ? market === 'daily' ? 'デイリーオファー' : 'ナイトマーケット' : 'プレビュー'));
    const price = node('div', 'card-price');
    price.append(node('span', 'vp-mark', 'V'), node('span', '', priceLabel(offer.price)), node('span', 'price-unit', 'VP'));
    if (offer.originalPrice !== undefined) {
      const discount = node('div', 'discount');
      discount.append(node('del', '', priceLabel(offer.originalPrice) + ' VP'), node('span', '', offer.discountPercent + '% OFF'));
      content.append(discount);
    }
    content.append(price);
    card.append(top, art, content);
    card.addEventListener('click', () => {
      $('skin-title').textContent = offer.name;
      $('skin-weapon').textContent = offer.weapon;
      $('skin-image').hidden = !offer.image;
      if (offer.image) $('skin-image').src = offer.image;
      $('skin-image').alt = offer.name;
      $('skin-price').textContent = offer.price === null ? '価格未取得' : `${priceLabel(offer.price)} VP`;
      $('skin-dialog').showModal();
    });
    return card;
  }));
  $('offer-count').textContent = String(offers.length).padStart(2, '0');
  if (!offers.length) $('shop-grid').append(node('p', 'small-label', market === 'daily' ? '現在、デイリーオファーがありません。ゲーム内のショップを確認してください。' : !snapshot ? '接続後にナイトマーケットを確認できます。' : !snapshot.active ? '現在、このアカウントのナイトマーケットは開催されていません。' : '表示できるナイトマーケットの商品がありません。'));
}
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  $('load-button').dataset.state = 'error';
}
function updateControls() {
  const pending = login && authState === 'pending';
  $('load-button').disabled = loading || pending || Boolean(logoutState);
  for (const id of ['daily-button', 'night-button']) $(id).disabled = loading || pending || Boolean(logoutState);
  $('logout-button').hidden = !login || !logoutState && !['pending', 'signed_in', 'error'].includes(authState);
  $('logout-button').disabled = Boolean(logoutState);
  $('logout-label').textContent = logoutState ? '終了中…' : pending ? 'キャンセル' : 'ログアウト';
  $('dialog-import').disabled = loading || pending || Boolean(logoutState);
  $('preview-button').disabled = loading;
  $('shop-grid').setAttribute('aria-busy', String(loading));
  $('load-label').textContent = logoutState ? '終了中…' : loading ? 'ショップを取得中…' : pending ? 'ログイン待ち…' :
    login && authState === 'signed_in' ? 'ショップを更新' : local && !login ? 'ショップを取得' : 'Riotでログイン';
  $('load-button').dataset.state = loading || pending ? 'loading' : $('error').hidden ? 'default' : 'error';
  if (pending) $('connection-label').textContent = 'ログイン待ち';
  else if (login && authState === 'signed_in' && !snapshot) $('connection-label').textContent = 'ログイン済み';
  else if (!snapshot) $('connection-label').textContent = '未接続';
}
function setLoading(busy) {
  loading = busy;
  updateControls();
}
async function skinInfo(offer) {
  if (!metadata.has(offer.id)) {
    const response = await fetch(`https://valorant-api.com/v1/weapons/skinlevels/${offer.id}?language=ja-JP`, { signal: AbortSignal.timeout(12000), credentials: 'omit' });
    if (!response.ok) throw new Error('metadata');
    const { data } = await response.json();
    const imageURL = new URL(data.displayIcon);
    if (imageURL.origin !== 'https://media.valorant-api.com' || typeof data.displayName !== 'string') throw new Error('metadata');
    const weapon = ['ヴァンダル', 'ファントム', 'クラシック', 'ショーティー', 'フレンジー', 'ゴースト', 'シェリフ', 'スティンガー', 'スペクター', 'バッキー', 'ジャッジ', 'ブルドッグ', 'ガーディアン', 'マーシャル', 'アウトロー', 'オペレーター', 'アレス', 'オーディン'].find(name => data.displayName.includes(name)) || '近接武器';
    metadata.set(offer.id, { name: data.displayName, image: imageURL.href, weapon });
  }
  return { ...offer, ...metadata.get(offer.id) };
}
async function displaySnapshot(value, mode, currentOperation) {
  const next = market === 'daily' ? parseSnapshot(value) : parseNightMarket(value);
  const results = await Promise.allSettled(next.offers.map(skinInfo));
  if (currentOperation !== operation) return;
  const offers = results.map((result, index) => result.status === 'fulfilled' ? result.value :
    { ...next.offers[index], name: `スキン ${index + 1}`, weapon: '情報未取得', image: null });
  snapshot = next;
  expired = false;
  renderCards(offers);
  $('connection-label').textContent = mode === 'local' ? `${next.region.toUpperCase()} · 接続済み` : `${next.region.toUpperCase()} · ファイル`;
  $('notice-tag').textContent = mode === 'local' ? 'YOUR SHOP' : 'SNAPSHOT';
  $('notice-text').textContent = mode === 'local' ? 'Riotから取得した、あなた専用のショップです。' : 'ファイル取得時点のショップです。最新情報はファイルを再取得してください。';
  $('shop-status').textContent = `${timeFormat.format(new Date(next.fetchedAt))} JST 取得${results.some(result => result.status === 'rejected') ? ' · 一部のスキン情報を取得できません。再読み込みしてください。' : ''}`;
  $('expiry-label').textContent = next.expiresAt ? `${timeFormat.format(new Date(next.expiresAt))} JST ${market === 'daily' ? '更新' : '終了'}` : '開催期間なし';
  $('preview-button').hidden = false;
  tick();
}
function tick() {
  if (!snapshot) return;
  if (snapshot.expiresAt === null) { $('clock').textContent = '開催なし'; return; }
  $('clock').textContent = remainingTime(snapshot.expiresAt);
  if (Date.now() >= Date.parse(snapshot.expiresAt) && !expired) {
    expired = true;
    $('notice-tag').textContent = 'EXPIRED';
    $('notice-text').textContent = 'このショップの表示期限が切れました。最新のショップを再取得してください。';
    $('connection-label').textContent = '期限切れ';
    $('shop-status').textContent = '表示中のオファーは過去のショップです。最新情報を再取得してください。';
  }
}
function resetPreview() {
  snapshot = null;
  $('error').hidden = true;
  $('clock').textContent = '— : — : —';
  $('connection-label').textContent = '未接続';
  $('notice-tag').textContent = 'PREVIEW';
  $('notice-text').textContent = '表示例です。あなたの今日のショップは接続後に表示されます。';
  $('expiry-label').textContent = '接続後に表示';
  $('shop-status').textContent = 'プレビュー · 価格はショップ取得後に表示';
  $('preview-button').hidden = true;
  renderCards(market === 'daily' ? preview : []);
  if (market !== 'daily') { $('notice-tag').textContent = 'NIGHT MARKET'; $('notice-text').textContent = '接続すると、あなたのナイトマーケットを確認できます。'; $('shop-status').textContent = '未取得'; }
  updateControls();
}
async function getShop() {
  const currentOperation = ++operation;
  $('error').hidden = true;
  setLoading(true);
  try {
    const response = await localFetch(market === 'daily' ? '/api/shop' : '/api/night-market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (currentOperation !== operation) return;
    if (response.status === 401 && login) { authState = 'signed_out'; resetPreview(); }
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
  const previous = authState;
  authState = login && ['signed_out', 'pending', 'signed_in', 'error'].includes(status.auth?.state) ? status.auth.state : 'signed_out';
  if (authState !== 'error') $('error').hidden = true;
  clearTimeout(pollTimer);
  if (login && authState === 'pending') {
    if (previous !== 'pending') loginStarted = Date.now();
    pollTimer = setTimeout(pollLogin, 1000);
  }
  if (login && authState === 'error') showError(typeof status.auth.error === 'string' ? status.auth.error : 'ログインできませんでした。もう一度お試しください。');
  updateControls();
  if (login && authState === 'signed_in' && previous !== 'signed_in') getShop();
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
  if (logoutState) return;
  ++operation;
  clearTimeout(pollTimer);
  logoutState = authState;
  authState = 'signed_out';
  loading = false;
  resetPreview();
  $('skin-dialog').close();
  try {
    const response = await localFetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('logout');
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
  if (loading || logoutState || authState === 'pending') return;
  if (!local) { $('help-dialog').showModal(); return; }
  if (login && authState !== 'signed_in') startLogin();
  else getShop();
});
$('logout-button').addEventListener('click', logout);
function selectMarket(next) {
  market = next;
  document.body.dataset.market = market;
  $('daily-button').setAttribute('aria-pressed', String(market === 'daily'));
  $('night-button').setAttribute('aria-pressed', String(market !== 'daily'));
  $('view-title').textContent = market === 'daily' ? '今日のショップ' : 'ナイトマーケット';
  $('shop-heading').textContent = market === 'daily' ? 'デイリーオファー' : '期間限定オファー';
  $('clock-label').textContent = market === 'daily' ? 'ショップ更新まで' : '開催終了まで';
}
for (const [id, next] of [['daily-button', 'daily'], ['night-button', 'night-market']]) $(id).addEventListener('click', () => {
  if (market === next || loading || logoutState || authState === 'pending') return;
  ++operation;
  $('skin-dialog').close();
  selectMarket(next);
  resetPreview();
  if (local && (!login || authState === 'signed_in')) getShop();
});
$('file-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || loading || logoutState || authState === 'pending') return;
  const currentOperation = ++operation;
  $('error').hidden = true;
  setLoading(true);
  try {
    if (file.size > 32768) throw new Error('ファイルが大きすぎます。npm run shopで生成したshop.jsonを選んでください。');
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('JSONファイルを読み取れません。shop.jsonを再取得してください。'); }
    selectMarket(data?.kind === 'night-market' ? 'night-market' : 'daily');
    resetPreview();
    await displaySnapshot(data, 'file', currentOperation);
  } catch (error) { if (currentOperation === operation) showError(error.message); }
  finally { if (currentOperation === operation) setLoading(false); }
  event.target.value = '';
});
for (const id of ['help-button', 'setup-button']) $(id).addEventListener('click', () => $('help-dialog').showModal());
$('dialog-import').addEventListener('click', () => { $('help-dialog').close(); $('file-input').click(); });
$('preview-button').addEventListener('click', resetPreview);
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
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
