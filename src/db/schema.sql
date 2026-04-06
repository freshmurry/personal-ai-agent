-- ================================
-- SuperAgent D1 Schema
-- ================================

-- MEMORY
CREATE TABLE IF NOT EXISTS memory (
  key         TEXT PRIMARY KEY,
  val         TEXT NOT NULL,
  type        TEXT DEFAULT 'fact',
  freq        INTEGER DEFAULT 1,
  ts          INTEGER NOT NULL,
  last_access INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_ts   ON memory(ts);

-- CONVERSATIONS (chat history)
CREATE TABLE IF NOT EXISTS conversations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  summary INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_ts
  ON conversations(ts);

-- FILE METADATA
CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL UNIQUE,
  folder   TEXT NOT NULL,
  ext      TEXT,
  size     INTEGER,
  r2_key   TEXT,
  modified INTEGER NOT NULL,
  indexed  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);

-- AUTOMATIONS
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
  created      INTEGER NOT NULL,
  last_run     INTEGER
);

-- OAUTH TOKENS
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  provider TEXT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  created       INTEGER NOT NULL
);

-- GOALS
CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  priority      INTEGER DEFAULT 5,
  created       INTEGER NOT NULL,
  last_updated  INTEGER,
  completed     INTEGER
);

-- PLANS
CREATE TABLE IF NOT EXISTS plans (
  id        TEXT PRIMARY KEY,
  goal_id   TEXT NOT NULL,
  step_no   INTEGER NOT NULL,
  action    TEXT NOT NULL,
  status    TEXT DEFAULT 'pending',
  result    TEXT,
  created   INTEGER NOT NULL,
  updated   INTEGER,
  FOREIGN KEY(goal_id) REFERENCES goals(id)
);

-- TOOL RUNS
CREATE TABLE IF NOT EXISTS tool_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name  TEXT NOT NULL,
  input      TEXT,
  output     TEXT,
  success    INTEGER DEFAULT 1,
  error      TEXT,
  ts         INTEGER NOT NULL
);

-- REFLECTIONS
CREATE TABLE IF NOT EXISTS reflections (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  context   TEXT NOT NULL,
  insight   TEXT NOT NULL,
  ts        INTEGER NOT NULL
);

-- APPROVALS (Human-in-the-loop)
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  type TEXT,
  payload TEXT,
  status TEXT,
  created INTEGER
);
