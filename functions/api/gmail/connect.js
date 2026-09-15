import { requireAuth, json } from '../../../lib/auth.js';
import { authUrl } from '../../../lib/gmail.js';

// Kicks off the OAuth dance. Reached by a same-site top-level navigation from
// the portal, so the session cookie still rides along despite SameSite=Strict.
export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured.' },
      { status: 500 });
  }

  // Double-submit CSRF token: the same value goes in the URL and in a cookie,
  // and the callback refuses to proceed unless they match. Only an authenticated
  // caller can get one issued, so a stranger cannot start a flow that ends with
  // their mailbox wired into this portal. SameSite=Lax rather than Strict,
  // because the cookie has to survive Google's cross-site redirect back here.
  const state = crypto.randomUUID();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl(request, env, state),
      'Set-Cookie': `csf_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/gmail; Max-Age=600`,
      'Cache-Control': 'no-store',
    },
  });
}
