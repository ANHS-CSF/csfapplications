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
