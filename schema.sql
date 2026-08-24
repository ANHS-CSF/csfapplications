-- CSF eligibility portal: course classification rules.
-- `name` is the normalized match key (lowercased, whitespace collapsed) so that
-- "AP Calc BC" and "ap  calc bc" resolve to the same rule; `display` keeps the
-- original casing for the UI.
CREATE TABLE IF NOT EXISTS courses (
  name    TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  value   TEXT NOT NULL CHECK (value IN ('AP', 'Honors', 'Regular', 'Inapplicable'))
);
