-- CSF eligibility portal: course classification rules.
-- `name` is the normalized match key (lowercased, whitespace collapsed) so that
-- "AP Calc BC" and "ap  calc bc" resolve to the same rule; `display` keeps the
-- original casing for the UI.
CREATE TABLE IF NOT EXISTS courses (
  name    TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  value   TEXT NOT NULL CHECK (value IN ('AP', 'Honors', 'Regular', 'Inapplicable'))
);

-- Portal configuration shared by everyone who reviews. Kept in the database
-- rather than each reviewer's browser so two officers can't score the same
-- batch against different rules.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL          -- JSON
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('allowedSchools', '["Aliso Niguel High School","California Preparatory Academy"]'),
  ('requiredTerm',   '{"term":"Spring","year":2026}'),
  ('dfAnywhereDisqualifies', 'false');

-- Gmail OAuth. One row, provider = 'gmail'. The refresh token is sealed with
-- AES-GCM under a key derived from SESSION_SECRET, so a database dump alone
-- does not hand over the ability to send mail as the chapter adviser.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  email         TEXT,
  refresh_token TEXT NOT NULL,
  connected_at  TEXT NOT NULL
);

-- Reusable message bodies. `{name}`-style placeholders are filled in per
-- recipient in the browser; see public/email.js.
CREATE TABLE IF NOT EXISTS email_templates (
  name       TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who has been contacted. Every attempt is recorded, including failures, so a
-- half-finished batch can be told apart from one that never ran. This is the
-- only applicant data the portal keeps; see the Privacy card in index.html.
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at    TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT,
  student_id TEXT,
  template   TEXT,
  subject    TEXT,
  audience   TEXT,
  status     TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error      TEXT
);
CREATE INDEX IF NOT EXISTS email_log_email ON email_log (email);
CREATE INDEX IF NOT EXISTS email_log_sent_at ON email_log (sent_at DESC);
