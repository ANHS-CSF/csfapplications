import { requireAuth, json } from '../../lib/auth.js';
import { NeedsReconnect } from '../../lib/gmail.js';
import { readSheet } from '../../lib/drive.js';

// Returns a Google Sheet tab as rows of strings — the same shape parseCsv
// produces — so the browser can treat it exactly like an uploaded CSV.
export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const url = params.get('url');
  if (!url) return json({ error: 'Missing url parameter.' }, { status: 400 });

  try {
    return json(await readSheet(env, url, params.get('tab')));
  } catch (e) {
    if (e instanceof NeedsReconnect) return json({ error: e.message, reconnect: true }, { status: 401 });
    return json({ error: e.message }, { status: e.status && e.status < 500 ? e.status : 502 });
  }
}
