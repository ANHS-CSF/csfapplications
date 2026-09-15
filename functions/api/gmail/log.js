import { requireAuth, json } from '../../../lib/auth.js';

const MAX = 500;

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const asked = Number(new URL(request.url).searchParams.get('limit')) || 200;
  const limit = Math.min(Math.max(asked, 1), MAX);

  const { results } = await env.DB.prepare(
    `SELECT sent_at, email, name, student_id, template, subject, audience, status, error
       FROM email_log ORDER BY sent_at DESC, id DESC LIMIT ?`
  ).bind(limit).all();
  return json({ log: results });
}
