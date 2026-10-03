const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !['riot-client', 'riot-login'].includes(value.source) ||
      !['na', 'eu', 'ap', 'kr', 'latam', 'br', 'pbe'].includes(value.region) ||
      !Array.isArray(value.offers) || value.offers.length > 4) {
    throw new Error('ショップファイルの形式が違います。npm run shopで生成したshop.jsonを選んでください。');
  }
  const fetched = Date.parse(value.fetchedAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(fetched) || !Number.isFinite(expires) || expires < fetched ||
      expires - fetched > 48 * 3600 * 1000 || fetched > Date.now() + 5 * 60 * 1000) {
    throw new Error('ショップの日時が正しくありません。PCの時計を確認し、ファイルを再取得してください。');
  }
  const offers = value.offers.map(offer => {
    if (!offer || !UUID.test(offer.id) ||
        (offer.price !== null && (!Number.isSafeInteger(offer.price) || offer.price < 0 || offer.price > 1000000))) {
      throw new Error('ショップのアイテム情報が正しくありません。ファイルを再取得してください。');
    }
    return { id: offer.id.toLowerCase(), price: offer.price };
  });
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) {
    throw new Error('ショップのアイテムが重複しています。ファイルを再取得してください。');
  }
  // Import only shop fields; account or authentication fields never enter app state.
  return { schemaVersion: 1, source: value.source, region: value.region,
    fetchedAt: new Date(fetched).toISOString(), expiresAt: new Date(expires).toISOString(), offers };
}
export function remainingTime(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(number => String(number).padStart(2, '0')).join(' : ');
}
