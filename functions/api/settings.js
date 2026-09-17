import { requireAuth, json } from '../../lib/auth.js';

const DEFAULTS = {
  allowedSchools: ['Aliso Niguel High School', 'California Preparatory Academy'],
  requiredTerm: { term: 'Spring', year: 2026 },
  dfAnywhereDisqualifies: false,
  sheetUrl: '',
};

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const { key, value } of results) {
    try { stored[key] = JSON.parse(value); } catch { /* fall back to the default */ }
  }
  return json({ settings: { ...DEFAULTS, ...stored } });
}

export async function onRequestPut({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  let settings;
  try { ({ settings } = await request.json()); } catch { settings = null; }
  if (!settings || typeof settings !== 'object') {
    return json({ error: 'Expected a settings object.' }, { status: 400 });
  }

  const invalid = validate(settings);
  if (invalid) return json({ error: invalid }, { status: 400 });

  const stmt = env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const rows = Object.entries(settings)
    .filter(([k]) => k in DEFAULTS)
    .map(([k, v]) => stmt.bind(k, JSON.stringify(v)));
  if (!rows.length) return json({ error: 'No recognized settings.' }, { status: 400 });

  await env.DB.batch(rows);
  return json({ ok: true });
}

function validate(s) {
  if ('allowedSchools' in s) {
    if (!Array.isArray(s.allowedSchools) || !s.allowedSchools.length) {
      return 'Add at least one school, or eligibility can never be confirmed.';
    }
    if (s.allowedSchools.some(x => typeof x !== 'string' || !x.trim())) {
      return 'School names cannot be blank.';
    }
  }
  if ('requiredTerm' in s) {
    const { term, year } = s.requiredTerm || {};
    if (term !== 'Spring' && term !== 'Fall') return 'Term must be Spring or Fall.';
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return 'Year looks wrong.';
  }
  if ('dfAnywhereDisqualifies' in s && typeof s.dfAnywhereDisqualifies !== 'boolean') {
    return 'dfAnywhereDisqualifies must be true or false.';
  }
  if ('sheetUrl' in s && typeof s.sheetUrl !== 'string') return 'sheetUrl must be a string.';
  return null;
}
