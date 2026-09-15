import { requireAuth, json } from '../../../lib/auth.js';
import { loadAccount, forgetAccount, clearTokenCache } from '../../../lib/gmail.js';

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const configured = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const row = configured ? await loadAccount(env) : null;
  return json({
    configured,
    connected: !!row,
    email: row?.email ?? null,
    connectedAt: row?.connected_at ?? null,
  });
}

export async function onRequestDelete({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  await forgetAccount(env);
  clearTokenCache();
  return json({ ok: true });
}
