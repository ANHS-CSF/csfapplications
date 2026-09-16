import { requireAuth, json } from '../../../lib/auth.js';
import { accessToken, buildMime, sendMessage, loadAccount, NeedsReconnect } from '../../../lib/gmail.js';

// The browser chunks a batch to stay inside the Workers subrequest budget (50
// fetches per request on the free plan, and every send is one). This cap is the
// server half of that contract.
const MAX_PER_CALL = 25;
const GAP_MS = 150;

// Display name on the From line. SENDER_NAME overrides it per deployment.
const DEFAULT_SENDER_NAME = 'ANHS CSF';

// Deliberately permissive: the point is to catch a mangled CSV cell, not to
// adjudicate what Gmail will accept.
const looksLikeEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function onRequestPost({ request, env }) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  let payload;
  try { payload = await request.json(); } catch { payload = null; }

  const messages = payload?.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return json({ error: 'Expected a non-empty messages array.' }, { status: 400 });
  }
  if (messages.length > MAX_PER_CALL) {
    return json({ error: `Send at most ${MAX_PER_CALL} messages per request.` }, { status: 400 });
  }

  for (const m of messages) {
    if (!looksLikeEmail(m?.email)) {
      return json({ error: `"${m?.email ?? ''}" is not an email address.` }, { status: 400 });
    }
    if (!String(m?.subject ?? '').trim()) {
      return json({ error: `The message to ${m.email} has no subject.` }, { status: 400 });
    }
    if (!String(m?.body ?? '').trim()) {
      return json({ error: `The message to ${m.email} has no body.` }, { status: 400 });
    }
  }

  const audience = String(payload.audience ?? '').slice(0, 80) || null;
  const template = String(payload.template ?? '').slice(0, 120) || null;

  let token, account;
  try {
    [token, account] = await Promise.all([accessToken(env), loadAccount(env)]);
  } catch (e) {
    // Nothing was attempted, so nothing is logged — the batch can be retried
    // wholesale once the account is reconnected.
    if (e instanceof NeedsReconnect) return json({ error: e.message, reconnect: true }, { status: 409 });
    return json({ error: e.message }, { status: 502 });
  }

  const from = account?.email || undefined;
  const fromName = env.SENDER_NAME ?? DEFAULT_SENDER_NAME;
  const logRows = [];
  const results = [];
  let reconnect = false;

  for (const [i, m] of messages.entries()) {
    if (reconnect) {
      // The token died mid-batch. Every remaining send would fail the same way,
      // so report them as unattempted rather than burning through the list.
      results.push({ email: m.email, ok: false, error: 'Not attempted — Gmail needs reconnecting.' });
      continue;
    }

    if (i > 0) await sleep(GAP_MS);

    let ok = false, error = null;
    try {
      await sendMessage(token, buildMime({ from, fromName, to: m.email, subject: m.subject, body: m.body }));
      ok = true;
    } catch (e) {
      error = e.message;
      if (e instanceof NeedsReconnect) reconnect = true;
    }

    results.push({ email: m.email, ok, error });
    logRows.push({
      email: m.email,
      name: m.name ?? null,
      studentId: m.studentId ?? null,
      subject: m.subject,
      status: ok ? 'sent' : 'failed',
      error,
    });
  }

  // One batched write at the end rather than a row per send: D1 calls are not
  // subrequests, but a round trip between each message would double the time a
  // batch takes for no benefit.
  if (logRows.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO email_log
         (sent_at, email, name, student_id, template, subject, audience, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    try {
      await env.DB.batch(logRows.map(r => stmt.bind(
        now, r.email, r.name, r.studentId, template, r.subject, audience, r.status, r.error
      )));
    } catch (e) {
      // The mail is already gone; a logging failure must not be reported as a
      // send failure. Surface it alongside the results instead.
      return json({ results, logError: e.message, reconnect });
    }
  }

  return json({ results, reconnect });
}
