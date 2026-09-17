// Reading the application sheet and report cards through the connected Google
// account, so neither has to be shared publicly. Uses the same refresh token as
// sending; see SCOPES in gmail.js.

import { accessToken, clearTokenCache, NeedsReconnect } from './gmail.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// Accepts a bare ID or any of the URL shapes Google hands out:
// /spreadsheets/d/<ID>/edit#gid=0, /file/d/<ID>/view, open?id=<ID>, uc?id=<ID>.
export function fileIdFrom(raw) {
  const s = String(raw ?? '').trim();
  if (/^[\w-]{20,}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
  return u.searchParams.get('id') || (u.pathname.match(/\/d\/([\w-]+)/) || [])[1] || null;
}

export function gidFrom(raw) {
  const m = String(raw ?? '').match(/[#?&]gid=(\d+)/);
  return m ? Number(m[1]) : null;
}

async function google(env, url) {
  const token = await accessToken(env);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) return res;

  const body = await res.json().catch(() => ({}));
  const message = body.error?.message || `Google returned ${res.status}`;
  if (res.status === 401) {
    clearTokenCache();
    throw new NeedsReconnect('Google rejected the access token. Reconnect the account.');
  }
  // An account connected before Drive access was added holds a token that can
  // send mail but not read files. Only a fresh consent can widen it.
  if (res.status === 403 && /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(body))) {
    throw new NeedsReconnect('The connected Google account has not granted Drive access. Reconnect it in Settings.');
  }
  const err = new Error(res.status === 404
    ? 'File not found, or the connected Google account cannot open it.'
    : message);
  err.status = res.status;
  throw err;
}

export async function readSheet(env, idOrUrl, tabTitle) {
  const id = fileIdFrom(idOrUrl);
  if (!id) throw Object.assign(new Error('That does not look like a Google Sheets link.'), { status: 400 });

  const meta = await (await google(env,
    `${SHEETS}/${id}?fields=properties.title,sheets.properties(sheetId,title)`)).json();
  const tabs = (meta.sheets || []).map(s => s.properties);
  if (!tabs.length) throw Object.assign(new Error('That spreadsheet has no tabs.'), { status: 422 });

  const gid = gidFrom(idOrUrl);
  const tab = tabs.find(t => t.title === tabTitle)
    || tabs.find(t => t.sheetId === gid)
    || tabs[0];

  // Sheet names containing spaces ("Form Responses 1") must be quoted in A1
  // notation, with embedded quotes doubled.
  const range = `'${tab.title.replace(/'/g, "''")}'`;
  const values = await (await google(env,
    `${SHEETS}/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`)).json();

  // The API trims trailing empty cells, so rows come back ragged. Pad them to
  // the header width so column indexes line up the way they do in a CSV.
  const rows = (values.values || []).map(r => r.map(v => String(v ?? '')));
  const width = Math.max(0, ...rows.map(r => r.length));
  for (const r of rows) while (r.length < width) r.push('');

  return {
    title: meta.properties?.title || '',
    tabs: tabs.map(t => t.title),
    tab: tab.title,
    rows,
  };
}

// Returns a fetch Response carrying the file's bytes. A Google Doc has no bytes
// of its own and is exported to PDF instead.
export async function downloadFile(env, id) {
  const meta = await (await google(env,
    `${DRIVE}/${encodeURIComponent(id)}?fields=mimeType,size&supportsAllDrives=true`)).json();
  if (meta.mimeType?.startsWith('application/vnd.google-apps.')) {
    return google(env, `${DRIVE}/${encodeURIComponent(id)}/export?mimeType=application/pdf`);
  }
  return google(env, `${DRIVE}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
}
