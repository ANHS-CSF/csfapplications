// Gmail sending over OAuth. The portal holds a refresh token for one mailbox
// (the adviser's) and mints short-lived access tokens from it as needed.

import { seal, open } from './secretbox.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const PROVIDER = 'gmail';

// gmail.send is the narrowest scope that can send: it grants no read access to
// the mailbox at all. openid+email are only there so the callback can show which
// account got connected.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');

// Raised when the refresh token no longer works — revoked, expired after the
// 7-day window that Google applies to unpublished "Testing" apps, or sealed
// under a SESSION_SECRET that has since been rotated. Callers turn this into a
// "reconnect Gmail" prompt rather than a generic failure, because retrying
// cannot possibly help.
export class NeedsReconnect extends Error {
  constructor(message = 'Gmail access has expired. Reconnect the account.') {
    super(message);
    this.name = 'NeedsReconnect';
  }
}

export function redirectUri(request) {
  return new URL('/api/gmail/callback', request.url).toString();
}

export function authUrl(request, env, state) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(request));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  // offline + consent is what makes Google hand back a refresh token. Without
  // prompt=consent a returning user gets an access token only, because they have
  // already granted the scope, and the portal would have nothing to store.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(env, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body.error || `HTTP ${res.status}`;
    if (code === 'invalid_grant') throw new NeedsReconnect();
    throw new Error(`Google rejected the token request: ${body.error_description || code}`);
  }
  return body;
}

// The id_token arrived over TLS straight from Google's token endpoint in
// response to our own client_secret, so the signature adds nothing here — we
// only want the email claim for display.
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json).email || null;
  } catch {
    return null;
  }
}

export async function exchangeCode(request, env, code) {
  const body = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(request),
  });
  if (!body.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove this app at ' +
      'myaccount.google.com/permissions and connect again.'
    );
  }
  return { refreshToken: body.refresh_token, email: emailFromIdToken(body.id_token) };
}

export async function storeAccount(env, { refreshToken, email }) {
  const sealed = await seal(env.SESSION_SECRET, refreshToken);
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (provider, email, refresh_token, connected_at)
     VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         email = excluded.email,
         refresh_token = excluded.refresh_token,
         connected_at = excluded.connected_at`
  ).bind(PROVIDER, email, sealed, new Date().toISOString()).run();
}

export function loadAccount(env) {
  return env.DB.prepare(
    'SELECT email, refresh_token, connected_at FROM oauth_tokens WHERE provider = ?'
  ).bind(PROVIDER).first();
}

export function forgetAccount(env) {
  return env.DB.prepare('DELETE FROM oauth_tokens WHERE provider = ?').bind(PROVIDER).run();
}

// Access tokens last an hour, and a send batch is many requests, so cache in the
// isolate. This is a best-effort cache: isolates come and go, and a miss costs
// one extra token call, never a wrong result.
let cached = null;

export async function accessToken(env) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const row = await loadAccount(env);
  if (!row) throw new NeedsReconnect('No Gmail account is connected.');

  let refreshToken;
  try {
    refreshToken = await open(env.SESSION_SECRET, row.refresh_token);
  } catch {
    throw new NeedsReconnect('The stored Gmail credential could not be read. Reconnect the account.');
  }

  const body = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
  cached = {
    token: body.access_token,
    expires: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

export function clearTokenCache() {
  cached = null;
}

/* ------------------------------------------------------------------ MIME --- */

const enc = new TextEncoder();

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// btoa() throws on anything outside Latin-1, and a student's name routinely has
// an accent in it, so everything goes through TextEncoder first.
const b64utf8 = text => b64(enc.encode(text));

// A header value has to be pure ASCII on the wire. RFC 2047 encoded-words are
// the escape hatch; plain ASCII is left alone so ordinary subjects stay readable
// in the raw message.
const header = value =>
  /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${b64utf8(value)}?=`;

// Newlines in a header would let a crafted template inject extra headers, so
// they are stripped rather than encoded.
const oneLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export function buildMime({ from, to, subject, body }) {
  const lines = [
    `From: ${oneLine(from)}`,
    `To: ${oneLine(to)}`,
    `Subject: ${header(oneLine(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    // Base64 sidesteps the whole quoted-printable/line-length question, and
    // 76-char chunks keep the message within the SMTP line limit.
    (b64utf8(String(body ?? '').replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g) || []).join('\r\n'),
  ];
  return b64(enc.encode(lines.join('\r\n')))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sendMessage(token, raw) {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.error?.message || `Gmail returned ${res.status}`;
    if (res.status === 401) {
      clearTokenCache();
      throw new NeedsReconnect('Gmail rejected the access token. Reconnect the account.');
    }
    throw new Error(message);
  }
  return body.id || null;
}
