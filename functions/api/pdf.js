import { requireAuth, json } from '../../lib/auth.js';

const ALLOWED_HOSTS = new Set([
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
]);
const MAX_BYTES = 25 * 1024 * 1024;

// Google Forms file-upload answers arrive as drive.google.com/open?id=<ID>, but
// that URL serves an HTML viewer, and for some files a "virus scan warning"
// interstitial. drive.usercontent.google.com/download with confirm=t skips both
// and returns raw bytes — verified against all 97 report cards in this batch.
function directDownloadUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!ALLOWED_HOSTS.has(u.hostname)) return null;

  const id = u.searchParams.get('id') || (u.pathname.match(/\/d\/([\w-]+)/) || [])[1];
  if (id) {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  // A Google Doc rather than an uploaded file: ask Docs to render it as PDF.
  if (u.hostname === 'docs.google.com' && /\/document\//.test(u.pathname)) {
    return u.href.replace(/\/(edit|view).*$/, '/export?format=pdf');
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ error: 'Missing url parameter.' }, { status: 400 });

  const direct = directDownloadUrl(target);
  if (!direct) {
    return json({ error: 'Link is not a recognized Google Drive file URL.' }, { status: 400 });
  }

  let upstream;
  try {
    upstream = await fetch(direct, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
  } catch {
    return json({ error: 'Could not reach Google Drive.' }, { status: 502 });
  }
  if (!upstream.ok) {
    return json({ error: `Drive returned ${upstream.status}. The file may not be shared publicly.` }, { status: 502 });
  }

  const size = Number(upstream.headers.get('Content-Length') || 0);
  if (size > MAX_BYTES) return json({ error: 'File is larger than 25 MB.' }, { status: 413 });

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return json({ error: 'File is larger than 25 MB.' }, { status: 413 });

  // Drive hands back an HTML page instead of an error status when a file is
  // private or still behind an interstitial. Catch that here so the browser
  // never tries to parse HTML as a PDF.
  const magic = String.fromCharCode(...bytes.slice(0, 5));
  if (magic !== '%PDF-') {
    return json({
      error: 'Drive did not return a PDF — the file is probably not shared publicly, or it is not a PDF.',
    }, { status: 422 });
  }

  return new Response(bytes, {
    headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' },
  });
}
