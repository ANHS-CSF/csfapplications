import { safeEqual } from '../../../lib/auth.js';
import { exchangeCode, storeAccount, clearTokenCache } from '../../../lib/gmail.js';

const CLEAR = 'csf_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/gmail; Max-Age=0';

// Google redirects the browser here. Note there is no requireAuth: a
// cross-site redirect does not carry the SameSite=Strict session cookie, so the
// state cookie issued by /api/gmail/connect is what proves this flow belongs to
// a signed-in reviewer.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const back = reason => new Response(null, {
    status: 302,
    headers: { Location: `/?gmail=${reason}`, 'Set-Cookie': CLEAR, 'Cache-Control': 'no-store' },
  });

  if (url.searchParams.get('error')) return back('denied');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookie = (request.headers.get('Cookie') || '')
    .split(/;\s*/).find(c => c.startsWith('csf_oauth_state='))?.slice('csf_oauth_state='.length);

  if (!code || !state || !cookie || !(await safeEqual(state, cookie))) return back('state');

  try {
    const account = await exchangeCode(request, env, code);
    await storeAccount(env, account);
    clearTokenCache();
    return back('connected');
  } catch (e) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/?gmail=error&detail=${encodeURIComponent(e.message)}`,
        'Set-Cookie': CLEAR,
        'Cache-Control': 'no-store',
      },
    });
  }
}
