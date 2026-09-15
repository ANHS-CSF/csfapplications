import { requireAuth, json } from '../../lib/auth.js';

const MAX_NAME = 120;
const MAX_SUBJECT = 400;
const MAX_BODY = 20000;

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const { results } = await env.DB.prepare(
    'SELECT name, subject, body, updated_at FROM email_templates ORDER BY name COLLATE NOCASE'
  ).all();
  return json({ templates: results });
}

export async function onRequestPut({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  let template;
  try { ({ template } = await request.json()); } catch { template = null; }

  const name = String(template?.name ?? '').trim();
  const subject = String(template?.subject ?? '').trim();
  const body = String(template?.body ?? '');

  if (!name) return json({ error: 'Give the template a name.' }, { status: 400 });
  if (name.length > MAX_NAME) return json({ error: 'That name is too long.' }, { status: 400 });
  if (!subject) return json({ error: 'Give the template a subject.' }, { status: 400 });
  if (subject.length > MAX_SUBJECT) return json({ error: 'That subject is too long.' }, { status: 400 });
  if (!body.trim()) return json({ error: 'The template body is empty.' }, { status: 400 });
  if (body.length > MAX_BODY) return json({ error: 'That body is too long.' }, { status: 400 });

  await env.DB.prepare(
    `INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`
  ).bind(name, subject, body, new Date().toISOString()).run();

  return json({ ok: true, name });
}

export async function onRequestDelete({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const name = new URL(request.url).searchParams.get('name');
  if (!name) return json({ error: 'Missing name parameter.' }, { status: 400 });

  await env.DB.prepare('DELETE FROM email_templates WHERE name = ?').bind(name.trim()).run();
  return json({ ok: true });
}
