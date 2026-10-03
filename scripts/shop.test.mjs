import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshot, remainingTime } from '../dist/shop.mjs';

test('snapshot validation, secret stripping, expiry and malformed input', () => {
  const shop = { schemaVersion: 1, source: 'riot-client', region: 'ap',
    fetchedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-02T00:00:00Z',
    offers: [{ id: 'ba42fe63-457a-78ce-4499-47950a698129', price: 1775 }], accessToken: 'must-not-be-imported' };
  const parsed = parseSnapshot(shop);
  assert.equal(parsed.offers[0].price, 1775);
  assert.equal('accessToken' in parsed, false);
  assert.equal(remainingTime(parsed.expiresAt, Date.parse('2026-01-01T22:59:59Z')), '01 : 00 : 01');
  assert.equal(remainingTime(parsed.expiresAt, Date.parse('2026-01-03T00:00:00Z')), '00 : 00 : 00');
  for (const invalid of [null, {}, { ...shop, region: 'evil.example' },
    { ...shop, expiresAt: 'invalid' }, { ...shop, expiresAt: '2025-01-01' },
    { ...shop, offers: [{ id: '<script>', price: 1 }] },
    { ...shop, offers: [{ ...shop.offers[0], price: -1 }] },
    { ...shop, offers: [{ ...shop.offers[0], price: 1.5 }] },
    { ...shop, offers: [shop.offers[0], shop.offers[0]] }]) assert.throws(() => parseSnapshot(invalid));
  assert.equal(parseSnapshot({ ...shop, offers: [] }).offers.length, 0);
});
