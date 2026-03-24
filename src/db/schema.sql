-- SuperAgent D1 Schema
-- Run: wrangler d1 execute superagent-db --file=src/db/schema.sql --remote

CREATE TABLE IF NOT EXISTS memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  val         TEXT    NOT NULL,
  type        TEXT    DEFAULT 'fact',
  freq        INTEGER DEFAULT 1,
  ts          INTEGER NOT NULL,
  last_access INTEGER
);

CREATE TABLE IF NOT EXISTS conversations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT    NOT NULL,
  content TEXT    NOT NULL,
  ts      INTEGER NOT NULL,
  summary INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  path     TEXT    NOT NULL UNIQUE,
  folder   TEXT    NOT NULL,
  ext      TEXT,
  size     INTEGER,
  r2_key   TEXT,
  modified INTEGER NOT NULL,
  indexed  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS automations (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  instructions TEXT    NOT NULL,
  cron         TEXT    NOT NULL,
  notify       TEXT    DEFAULT 'chat',
  active       INTEGER DEFAULT 1,
  runs         INTEGER DEFAULT 0,
  successes    INTEGER DEFAULT 0,
  failures     INTEGER DEFAULT 0,
  created      INTEGER NOT NULL,
  last_run     INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  service       TEXT    PRIMARY KEY,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  created       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_ts   ON memory(ts);
CREATE INDEX IF NOT EXISTS idx_conv_ts     ON conversations(ts);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
