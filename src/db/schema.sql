-- Каталог витрины.
CREATE TABLE IF NOT EXISTS products (
  sku            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,
  price_minor    INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  image          TEXT,
  position       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  sku                TEXT NOT NULL REFERENCES products(sku),
  status             TEXT NOT NULL,
  base_amount_minor  INTEGER NOT NULL,
  discount_minor     INTEGER NOT NULL DEFAULT 0,
  amount_minor       INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  promo_code         TEXT,
  steam_login        TEXT,
  -- Двойной клик "Купить" приходит с одним ключом идемпотентности -> один заказ.
  idempotency_key    TEXT UNIQUE,
  delivery_attempts  INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  lease_until        INTEGER,
  lease_token        TEXT,
  pending_provider   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Журнал вебхуков. PRIMARY KEY по event_id даёт идемпотентность приёма:
-- повторная доставка того же события физически не может примениться дважды.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id      TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  amount_minor  INTEGER,
  currency      TEXT,
  created_at    TEXT,
  received_at   TEXT NOT NULL,
  applied_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_pending ON payment_events(applied_at);

-- Пул кодов на стороне заглушек-поставщиков.
-- request_id UNIQUE: код физически не может быть привязан к двум запросам.
CREATE TABLE IF NOT EXISTS provider_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  sku         TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  request_id  TEXT UNIQUE,
  issued_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_pool ON provider_keys(provider, sku, request_id);

-- Журнал поставщика: повтор с тем же request_id обязан вернуть тот же код.
CREATE TABLE IF NOT EXISTS provider_issues (
  request_id  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  sku         TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- Факт выдачи покупателю. PRIMARY KEY по order_id: ровно одна выдача на заказ.
CREATE TABLE IF NOT EXISTS deliveries (
  order_id    TEXT PRIMARY KEY REFERENCES orders(id),
  code        TEXT NOT NULL UNIQUE,
  provider    TEXT NOT NULL,
  request_id  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promocodes (
  code        TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  value       INTEGER NOT NULL,
  currency    TEXT,
  max_uses    INTEGER NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0,
  CHECK (used_count >= 0 AND used_count <= max_uses)
);

-- Слот использования промокода занимается в той же транзакции, что и заказ.
CREATE TABLE IF NOT EXISTS promo_redemptions (
  order_id        TEXT PRIMARY KEY REFERENCES orders(id),
  code            TEXT NOT NULL REFERENCES promocodes(code),
  discount_minor  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  released_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promo_redemptions(code);
