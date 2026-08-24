import { safeEqual, issueCookie, clearCookie, isAuthed, json } from '../../lib/auth.js';

// Failed attempts per IP, held in the isolate. Not a hardened rate limiter —
// just enough to make online guessing against the page tedious.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooMany(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) return false;
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: 'Server is missing ADMIN_PASSWORD or SESSION_SECRET.' }, { status: 500 });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if (tooMany(ip)) {
    return json({ error: 'Too many attempts. Wait 15 minutes.' }, { status: 429 });
  }

  let password = '';
  try { ({ password } = await request.json()); } catch { /* falls through to failure */ }

  if (!password || !(await safeEqual(password, env.ADMIN_PASSWORD))) {
    recordFailure(ip);
    return json({ error: 'Incorrect password.' }, { status: 401 });
  }

  attempts.delete(ip);
  return json({ ok: true }, { headers: { 'Set-Cookie': await issueCookie(env) } });
}

// GET /api/login doubles as the session check the page runs on load.
export async function onRequestGet({ request, env }) {
  return json({ ok: await isAuthed(request, env) });
}

export async function onRequestDelete() {
  return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie() } });
}
