-- Migration number: 0001 	 2026-08-16T00:00:00.000Z

CREATE TABLE guild_settings (
  guild_id             TEXT    PRIMARY KEY,
  quorum               INTEGER NOT NULL DEFAULT 3,
  default_duration_min INTEGER NOT NULL DEFAULT 360,
  court_channel_id     TEXT,
  hub_message_id       TEXT,
  nickname_sync        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE cases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT    NOT NULL,
  channel_id TEXT    NOT NULL,
  message_id TEXT,
  kind       TEXT    NOT NULL CHECK (kind IN ('accuse', 'commend')),
  accuser_id TEXT    NOT NULL,
  accused_id TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  points     INTEGER NOT NULL,
  deadline   INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'passed', 'failed', 'dismissed', 'voided')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_cases_status_deadline ON cases (status, deadline);
CREATE INDEX idx_cases_guild_accuser_status ON cases (guild_id, accuser_id, status);
CREATE INDEX idx_cases_guild_accused_status ON cases (guild_id, accused_id, status);

CREATE TABLE votes (
  case_id  INTEGER NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  voter_id TEXT    NOT NULL,
  choice   TEXT    NOT NULL CHECK (choice IN ('yes', 'no')),
  PRIMARY KEY (case_id, voter_id)
);

CREATE TABLE scores (
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
