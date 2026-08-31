import { db } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';

export const resetDatabase = () => {
  for (const table of ['deliveries', 'promo_redemptions', 'payment_events', 'orders',
    'provider_issues', 'provider_keys', 'promocodes', 'products']) {
    db.exec(`DELETE FROM ${table}`);
  }
  seed();
};

export { db };
