-- SuperAgent D1 Database Schema v4

CREATE TABLE IF NOT EXISTS memory (
  key         TEXT PRIMARY KEY,
  val         TEXT NOT NULL,
  type        TEXT DEFAULT 'fact',
  freq        INTEGER DEFAULT 1,
  ts          INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,
  content TEXT NOT NULL,
  summary INTEGER DEFAULT 0,
  ts      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_role_ts ON conversations(role, ts);

CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  status       TEXT DEFAULT 'active',
  priority     INTEGER DEFAULT 5,
  created      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS automations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL,
  cron         TEXT NOT NULL,
  notify       TEXT DEFAULT 'chat',
  active       INTEGER DEFAULT 1,
  runs         INTEGER DEFAULT 0,
  successes    INTEGER DEFAULT 0,
  failures     INTEGER DEFAULT 0,
  last_run     INTEGER,
  created      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  created     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  service       TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT DEFAULT '',
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
