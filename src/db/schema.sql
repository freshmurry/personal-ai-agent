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
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  provider TEXT,
  access_token  TEXT    NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  created       INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  status        TEXT DEFAULT 'active', -- active | paused | completed | failed
  priority      INTEGER DEFAULT 5,
  created       INTEGER NOT NULL,
  last_updated  INTEGER,
  completed     INTEGER
);


CREATE TABLE IF NOT EXISTS plans (
  id        TEXT PRIMARY KEY,
  goal_id   TEXT NOT NULL,
  step_no   INTEGER NOT NULL,
  action    TEXT NOT NULL,
  status    TEXT DEFAULT 'pending', -- pending | running | done | failed
  result    TEXT,
  created   INTEGER NOT NULL,
  updated   INTEGER,
  FOREIGN KEY(goal_id) REFERENCES goals(id)
);


CREATE TABLE IF NOT EXISTS tool_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name  TEXT NOT NULL,
  input      TEXT,
  output     TEXT,
  success    INTEGER DEFAULT 1,
  error      TEXT,
  ts         INTEGER NOT NULL
);


CREATE TABLE IF NOT EXISTS reflections (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  context   TEXT NOT NULL,
  insight   TEXT NOT NULL,
  ts        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  status TEXT,
  created INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_ts   ON memory(ts);
CREATE INDEX IF NOT EXISTS idx_conv_ts     ON conversations(ts);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
