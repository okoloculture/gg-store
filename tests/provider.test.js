import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, db } from './helpers.js';
import { issueCode } from '../src/services/providerStub.js';

test('повтор с тем же request_id возвращает тот же код и не расходует второй ключ', () => {
  resetDatabase();
  const args = { provider: 'A', sku: 'KEY-CS2-PRIME', orderId: 'ord_x', requestId: 'req_ord_x_A' };

  const first = issueCode(args);
  const second = issueCode(args);

  assert.equal(first.status, 'ok');
  assert.equal(second.code, first.code);
  assert.equal(second.replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider_keys WHERE request_id = 'req_ord_x_A'").get().n, 1);
});

test('разные request_id получают разные ключи', () => {
  resetDatabase();
  const codes = new Set(
    Array.from({ length: 10 }, (unused, index) =>
      issueCode({ provider: 'A', sku: 'KEY-CS2-PRIME', orderId: `ord_${index}`, requestId: `req_${index}_A` }).code),
  );
  assert.equal(codes.size, 10);
});

test('пустой пул отвечает out_of_stock и ничего не списывает', () => {
  resetDatabase();
  const total = db.prepare("SELECT COUNT(*) AS n FROM provider_keys WHERE provider = 'B' AND sku = 'KEY-EFT'").get().n;

  for (let index = 0; index < total; index += 1) {
    assert.equal(issueCode({ provider: 'B', sku: 'KEY-EFT', orderId: `o${index}`, requestId: `r${index}` }).status, 'ok');
  }

  const overflow = issueCode({ provider: 'B', sku: 'KEY-EFT', orderId: 'o_last', requestId: 'r_last' });
  assert.equal(overflow.status, 'error');
  assert.equal(overflow.reason, 'out_of_stock');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider_issues WHERE request_id = 'r_last'").get().n, 0);
});
