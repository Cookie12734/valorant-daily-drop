const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const KC = '85ca954a-41f2-ce94-9b45-8ca3dd39a00d';
export const accessoryTypes = {
  'dd3bf334-87f3-40bd-b043-682a57a8dc3a': ['buddies/levels', 'ガンバディー'],
  'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475': ['sprays', 'スプレー'],
  '3f296c07-64c3-494c-923b-fe692a4fa1bd': ['playercards', 'プレイヤーカード'],
  'de7caa6b-adf7-4588-bbd1-143831e786c6': ['playertitles', 'プレイヤータイトル'],
};
function fail() { throw new Error('アクセサリーストアの情報を読み取れません。再取得してください。'); }
export function accessoryFromStorefront(store, region, now = new Date()) {
  const panel = store?.AccessoryStore;
  const seconds = panel?.AccessoryStoreRemainingDurationInSeconds;
  if (!Array.isArray(panel?.AccessoryStoreOffers) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 7 * 86400) fail();
  const offers = panel.AccessoryStoreOffers.map(({ Offer: offer } = {}) => {
    const reward = offer?.Rewards?.[0];
    if (!UUID.test(offer?.OfferID) || offer.IsDirectPurchase !== true || !Array.isArray(offer.Rewards) || offer.Rewards.length !== 1 || ![1, 2].includes(reward?.Quantity) || reward.Quantity === 2 && reward.ItemTypeID !== 'dd3bf334-87f3-40bd-b043-682a57a8dc3a' || !offer.Cost || Object.keys(offer.Cost).length !== 1) fail();
    return { id: reward.ItemID, itemTypeId: reward.ItemTypeID, offerId: offer.OfferID, price: offer.Cost[KC] };
  });
  return parseAccessory({ schemaVersion: 1, kind: 'accessory', source: 'riot-client', region, fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(), offers });
}
export function parseAccessory(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'accessory' || !['riot-login', 'riot-client'].includes(value.source) || !['na', 'eu', 'ap', 'kr', 'pbe'].includes(value.region) || !Array.isArray(value.offers) || value.offers.length > 4) fail();
  const fetched = Date.parse(value.fetchedAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(fetched) || fetched > Date.now() + 300000 || !Number.isFinite(expires) || expires < fetched || expires - fetched > 7 * 86400000) fail();
  const offers = value.offers.map(offer => {
    if (!offer || !UUID.test(offer.id) || !UUID.test(offer.offerId) || !Object.hasOwn(accessoryTypes, offer.itemTypeId) || !Number.isSafeInteger(offer.price) || offer.price <= 0 || offer.price > 10000) fail();
    return { id: offer.id.toLowerCase(), offerId: offer.offerId.toLowerCase(), itemTypeId: offer.itemTypeId, price: offer.price };
  });
  if (new Set(offers.map(o => o.id)).size !== offers.length || new Set(offers.map(o => o.offerId)).size !== offers.length) fail();
  return { schemaVersion: 1, kind: 'accessory', source: value.source, region: value.region, fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(expires).toISOString(), offers };
}
