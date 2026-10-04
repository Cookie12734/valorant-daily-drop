const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const SHARDS = new Set(['na', 'eu', 'ap', 'kr', 'pbe']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// BonusStore is optional outside Night Market. Only normalized offer data leaves this boundary.
// Response shape: https://valapidocs.techchrism.me/endpoint/storefront
export function nightMarketFromStorefront(store, shard, now = new Date()) {
  if (!object(store) || !SHARDS.has(shard) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('ナイトマーケットの情報を読み取れません。');
  const snapshot = { schemaVersion: 1, kind: 'night-market', source: 'riot-client', region: shard, fetchedAt: now.toISOString(), expiresAt: null, active: false, offers: [] };
  const bonus = store.BonusStore;
  if (bonus === undefined || bonus === null) return snapshot;
  const remaining = bonus?.BonusStoreRemainingDurationInSeconds;
  const entries = bonus?.BonusStoreOffers;
  if (!object(bonus) || !Array.isArray(entries) || entries.length > 6 || !Number.isSafeInteger(remaining) || remaining < 0 || remaining > 90 * 86400) throw new Error('ナイトマーケットの情報を読み取れません。');
  const offers = entries.map(entry => {
    const rewards = entry?.Offer?.Rewards;
    const id = rewards?.[0]?.ItemID;
    const originalPrice = entry?.Offer?.Cost?.[VP];
    const price = entry?.DiscountCosts?.[VP];
    const discountPercent = entry?.DiscountPercent;
    if (!Array.isArray(rewards) || rewards.length !== 1 || typeof id !== 'string' || !UUID.test(id) || !object(entry?.Offer?.Cost) || !object(entry?.DiscountCosts) || !Number.isSafeInteger(originalPrice) || originalPrice <= 0 || !Number.isSafeInteger(price) || price < 0 || price > originalPrice || !Number.isSafeInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new Error('ナイトマーケットの商品情報を読み取れません。');
    return { id: id.toLowerCase(), price, originalPrice, discountPercent };
  });
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) throw new Error('ナイトマーケットの商品情報が一致しません。');
  if (remaining === 0 || offers.length === 0) return snapshot;
  return { ...snapshot, active: true, expiresAt: new Date(now.getTime() + remaining * 1000).toISOString(), offers };
}
