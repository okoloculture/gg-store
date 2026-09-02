import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, sql } from './helpers.js';
import { issueCode } from '../src/services/providerStub.js';

const count = async (table, where, ...params) =>
  (await sql.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${table} WHERE ${where}`, ...params)).n;

test('повтор с тем же request_id возвращает тот же код и не расходует второй ключ', async () => {
  await resetDatabase();
  const args = { provider: 'A', sku: 'KEY-CS2-PRIME', orderId: 'ord_x', requestId: 'req_ord_x_A' };

  const first = await issueCode(args);
  const second = await issueCode(args);

  assert.equal(first.status, 'ok');
  assert.equal(second.code, first.code);
  assert.equal(second.replayed, true);
  assert.equal(await count('provider_keys', "request_id = 'req_ord_x_A'"), 1);
});

test('разные request_id получают разные ключи', async () => {
  await resetDatabase();
  const codes = new Set();
  for (let index = 0; index < 10; index += 1) {
    const issued = await issueCode({
      provider: 'A', sku: 'KEY-CS2-PRIME', orderId: `ord_${index}`, requestId: `req_${index}_A`,
    });
    codes.add(issued.code);
  }
  assert.equal(codes.size, 10);
});

test('пустой пул отвечает out_of_stock и ничего не списывает', async () => {
  await resetDatabase();
  const total = await count('provider_keys', "provider = 'B' AND sku = 'KEY-EFT'");

  for (let index = 0; index < total; index += 1) {
    const issued = await issueCode({ provider: 'B', sku: 'KEY-EFT', orderId: `o${index}`, requestId: `r${index}` });
    assert.equal(issued.status, 'ok');
  }

  const overflow = await issueCode({ provider: 'B', sku: 'KEY-EFT', orderId: 'o_last', requestId: 'r_last' });
  assert.equal(overflow.status, 'error');
  assert.equal(overflow.reason, 'out_of_stock');
  assert.equal(await count('provider_issues', "request_id = 'r_last'"), 0);
});
