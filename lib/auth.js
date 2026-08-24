// Session handling shared by every API route.
//
// The admin password lives in a Cloudflare secret, so it can only ever be
// checked server-side. On success we hand back a cookie carrying
// "<expiry>.<HMAC(expiry)>" — no password material, and unforgeable without
// SESSION_SECRET.

const COOKIE = 'csf_session';
const TTL_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Length-independent comparison, so a wrong password can't be discovered by timing.
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function issueCookie(env) {
  const expiry = String(Date.now() + TTL_MS);
  const token = `${expiry}.${await hmac(env.SESSION_SECRET, expiry)}`;
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const raw = request.headers.get('Cookie') || '';
  const hit = raw.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
  if (!hit) return false;
  const [expiry, sig] = hit.slice(COOKIE.length + 1).split('.');
  if (!expiry || !sig) return false;
  if (Number(expiry) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, expiry));
}

export const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

// Guard for routes that must never serve data to an anonymous caller.
export async function requireAuth(request, env) {
  return (await isAuthed(request, env)) ? null : json({ error: 'unauthorized' }, { status: 401 });
}
