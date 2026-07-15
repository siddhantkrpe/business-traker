-- Client tracker schema
-- Matches the data model used by client-tracker.html
-- Works as-is in SQLite; minor type tweaks needed for Postgres/MySQL (noted below)

CREATE TABLE clients (
  id          TEXT PRIMARY KEY,           -- Postgres: use UUID or SERIAL instead
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',  -- hotel, clinic, restaurant, salon, gym, retail, other
  phone       TEXT,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'in progress', -- not started, in progress, delivered, needs update
  notes       TEXT,
  created_at  DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('charge', 'payment')),
  amount      NUMERIC(10,2) NOT NULL,
  description TEXT,
  date        DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE followups (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  due_date    DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done'))
);

-- Indexes for the lookups the app does most often
CREATE INDEX idx_payments_client   ON payments(client_id);
CREATE INDEX idx_followups_client  ON followups(client_id);
CREATE INDEX idx_clients_category  ON clients(category);
CREATE INDEX idx_followups_due     ON followups(due_date) WHERE status = 'pending';

-- Handy views, since the app computes these on the fly today

-- Running balance per client
CREATE VIEW client_balances AS
SELECT
  c.id AS client_id,
  c.name,
  COALESCE(SUM(CASE WHEN p.type = 'charge'  THEN p.amount END), 0) AS total_charged,
  COALESCE(SUM(CASE WHEN p.type = 'payment' THEN p.amount END), 0) AS total_paid,
  COALESCE(SUM(CASE WHEN p.type = 'charge'  THEN p.amount END), 0)
    - COALESCE(SUM(CASE WHEN p.type = 'payment' THEN p.amount END), 0) AS balance_due
FROM clients c
LEFT JOIN payments p ON p.client_id = c.id
GROUP BY c.id, c.name;

-- Open follow-ups, oldest due date first (this is your dashboard's main feed)
CREATE VIEW open_followups AS
SELECT f.id, f.client_id, c.name AS client_name, f.description, f.due_date
FROM followups f
JOIN clients c ON c.id = f.client_id
WHERE f.status = 'pending'
ORDER BY f.due_date ASC;