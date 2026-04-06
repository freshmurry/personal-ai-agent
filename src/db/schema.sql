-- SuperAgent D1 Schema v6 — Base44-style agentic system
-- Run: wrangler d1 execute superagent-db --file=src/db/schema.sql

-- ── Core memory (tiered) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory (
  key         TEXT PRIMARY KEY,
  val         TEXT NOT NULL,
  type        TEXT DEFAULT 'fact',          -- fact|preference|goal|profile|project|system
  freq        INTEGER DEFAULT 1,            -- access frequency (boost for retrieval)
  ts          INTEGER NOT NULL,             -- last updated
  last_access INTEGER NOT NULL
);

-- ── Conversation history ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,                    -- user|assistant|tool|system
  content TEXT NOT NULL,
  summary INTEGER DEFAULT 0,               -- 1 = compressed summary
  ts      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_role_ts ON conversations(role, ts);

-- ── Goals (persistent across turns) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id           TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  status       TEXT DEFAULT 'active',       -- active|completed|abandoned|paused
  priority     INTEGER DEFAULT 5,           -- 1-10
  plan         TEXT,                        -- JSON structured plan attached to this goal
  progress     TEXT,                        -- free-text progress notes
  created      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── Plans (structured reasoning output) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,
  goal_id         TEXT,                     -- FK to goals
  goal            TEXT NOT NULL,            -- goal description
  assumptions     TEXT NOT NULL,            -- JSON array
  steps           TEXT NOT NULL,            -- JSON array of {tool, input, status, result}
  success_criteria TEXT NOT NULL,
  status          TEXT DEFAULT 'pending',   -- pending|running|completed|failed|cancelled
  current_step    INTEGER DEFAULT 0,
  reflection      TEXT,                     -- post-execution reflection
  created         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed       INTEGER
);

-- ── Tool execution log (audit trail) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_log (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT,
  tool_name   TEXT NOT NULL,
  input       TEXT NOT NULL,               -- JSON
  output      TEXT,                        -- JSON
  status      TEXT DEFAULT 'pending',      -- pending|success|error|skipped
  duration_ms INTEGER,
  error       TEXT,
  ts          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_tool_log_plan ON tool_log(plan_id);
CREATE INDEX IF NOT EXISTS idx_tool_log_ts   ON tool_log(ts DESC);

-- ── Performance / self-improvement tracking ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_events (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL,                  -- plan_created|tool_called|goal_completed|self_audit|error
  payload  TEXT NOT NULL,                  -- JSON
  ts       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_events_type ON agent_events(type);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON agent_events(ts DESC);

-- ── Automations (scheduled + triggered) ──────────────────────────────────────
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

-- ── Approval queue (human-in-the-loop) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,               -- linkedin_post|send_email|delete_data|external_api
  payload     TEXT NOT NULL,               -- JSON
  status      TEXT DEFAULT 'pending',      -- pending|approved|rejected
  context     TEXT,                        -- why the agent wants to do this
  created     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── OAuth tokens ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_tokens (
  service       TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT DEFAULT '',
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
