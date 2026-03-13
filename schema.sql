CREATE TABLE IF NOT EXISTS credits (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      TEXT        NOT NULL,
  amount           INTEGER     NOT NULL,   -- positive = granted, negative = debited
  type             TEXT        NOT NULL,   -- 'GRANT' | 'HELD'
  idempotency_key  TEXT        UNIQUE NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credits_customer ON credits(customer_id);
