CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  host            TEXT,
  kind            TEXT,            -- local | cloud
  cloud_url       TEXT,
  cwd             TEXT,
  project         TEXT,
  branch          TEXT,
  model           TEXT,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'idle', -- working | waiting | idle | ended
  current_tool    TEXT,
  current_detail  TEXT,
  tool_running    INTEGER NOT NULL DEFAULT 0,
  last_prompt     TEXT,
  last_message    TEXT,
  started_at      INTEGER NOT NULL,
  last_event_at   INTEGER NOT NULL,
  turn_started_at INTEGER,
  turn_tool_calls INTEGER NOT NULL DEFAULT 0,
  ended_at        INTEGER,
  turns           INTEGER NOT NULL DEFAULT 0,
  tool_calls      INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  subagents       INTEGER NOT NULL DEFAULT 0,
  todos           TEXT,            -- JSON array, see src/todos.ts
  todos_started_at INTEGER,
  usage           TEXT,            -- JSON {input,output,cache_read,cache_write}
  hidden          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last_event ON sessions(last_event_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,        -- start | prompt | tool | tool_error | notify | stop | subagent | end | compact
  tool       TEXT,
  summary    TEXT
);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

-- Completed turns, used as history for time-left estimates.
CREATE TABLE IF NOT EXISTS turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
CREATE INDEX IF NOT EXISTS turns_project ON turns(project, ended_at);
