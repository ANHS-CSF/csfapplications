import { requireAuth, json } from '../../lib/auth.js';

const VALUES = new Set(['AP', 'Honors', 'Regular', 'Inapplicable']);
const normalize = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    'SELECT name, display, value FROM courses ORDER BY display COLLATE NOCASE'
  ).all();
  return json({ courses: results });
}

// Upsert a batch: the UI sends one row when a reviewer reclassifies a course,
// and many when they bulk-paste a list.
export async function onRequestPut({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  let courses;
  try { ({ courses } = await request.json()); } catch { courses = null; }
  if (!Array.isArray(courses) || !courses.length) {
    return json({ error: 'Expected a non-empty courses array.' }, { status: 400 });
  }

  const rows = [];
  for (const c of courses) {
    const display = String(c?.display ?? c?.name ?? '').trim();
    const value = String(c?.value ?? '').trim();
    if (!display) return json({ error: 'A course is missing a name.' }, { status: 400 });
    if (!VALUES.has(value)) {
      return json({ error: `"${value}" is not a valid category for ${display}.` }, { status: 400 });
    }
    rows.push({ name: normalize(display), display, value });
  }

  const stmt = env.DB.prepare(
    `INSERT INTO courses (name, display, value) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value, display = excluded.display`
  );
  await env.DB.batch(rows.map(r => stmt.bind(r.name, r.display, r.value)));
  return json({ ok: true, saved: rows.length });
}

export async function onRequestDelete({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const name = new URL(request.url).searchParams.get('name');
  if (!name) return json({ error: 'Missing name parameter.' }, { status: 400 });

  await env.DB.prepare('DELETE FROM courses WHERE name = ?').bind(normalize(name)).run();
  return json({ ok: true });
}
