// Integration test for the bulk send route. Google and D1 are both stubbed, so
// this runs offline and asserts the things that are expensive to get wrong in
// production: that one bad address does not cost the rest of the batch, that a
// dead token stops the run instead of failing fifty times, that every attempt is
// logged, and that nothing a reviewer types into a subject line can forge a
// header.
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/gmail/send.js';
import { seal } from '../lib/secretbox.js';
import { clearTokenCache } from '../lib/gmail.js';

const SECRET = 'test-session-secret';
const enc = new TextEncoder();

async function cookie() {
  const expiry = String(Date.now() + 3600e3);
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(expiry));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `csf_session=${expiry}.${b64}`;
}

function makeDb(sealedToken) {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        sql, args: [],
        bind(...args) { return { ...stmt, args }; },
        async first() {
          if (/FROM oauth_tokens/.test(sql)) {
            return sealedToken
              ? { email: 'adviser@school.org', refresh_token: sealedToken, connected_at: 'now' }
              : null;
          }
          return null;
        },
        async run() { return { success: true }; },
      };
      return stmt;
    },
    async batch(stmts) { inserted.push(...stmts.map(s => s.args)); return []; },
  };
}

// Stubbed Google. `behavior` decides what the send endpoint does per call.
function stubFetch(behavior) {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at-123', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('gmail.googleapis.com')) {
      const raw = JSON.parse(opts.body).raw;
      const mime = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
      const to = /^To: (.*)$/m.exec(mime)?.[1];
      sent.push({ to, mime });
      return behavior(sent.length, to);
    }
    throw new Error('unexpected fetch to ' + u);
  };
  return sent;
}

const okSend = () => new Response(JSON.stringify({ id: 'msg-1' }), { headers: { 'Content-Type': 'application/json' } });
const failSend = msg => new Response(JSON.stringify({ error: { message: msg } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
const authFail = () => new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });

const msgs = n => Array.from({ length: n }, (_, i) => ({
  email: `student${i}@example.org`, name: `Student ${i}`, studentId: `90${i}`,
  subject: 'CSF application', body: 'Hi Student, please resend your card.',
}));

async function run({ messages, behavior, sealed = true }) {
  clearTokenCache();
  const token = sealed ? await seal(SECRET, 'refresh-abc') : null;
  const db = makeDb(token);
  const sent = stubFetch(behavior);
  const request = new Request('https://portal.test/api/gmail/send', {
    method: 'POST',
    headers: { Cookie: await cookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'Needs review · No Aeries grade table', template: 'Missing grade report', messages }),
  });
  const res = await onRequestPost({ request, env: { SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', DB: db } });
  return { res, body: await res.json(), db, sent };
}

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); }
};

console.log('send loop');

await t('a clean batch sends everyone and logs every one as sent', async () => {
  const { body, db, sent } = await run({ messages: msgs(3), behavior: okSend });
  assert.equal(body.results.length, 3);
  assert.ok(body.results.every(r => r.ok));
  assert.deepEqual(sent.map(s => s.to), ['student0@example.org', 'student1@example.org', 'student2@example.org']);
  assert.equal(db.inserted.length, 3);
  // [sent_at, email, name, student_id, template, subject, audience, status, error]
  assert.equal(db.inserted[0][1], 'student0@example.org');
  assert.equal(db.inserted[0][3], '900');
  assert.equal(db.inserted[0][4], 'Missing grade report');
  assert.equal(db.inserted[0][6], 'Needs review · No Aeries grade table');
  assert.ok(db.inserted.every(r => r[7] === 'sent' && r[8] === null));
});

await t('one bad recipient does not abort the rest of the batch', async () => {
  const { body, db, sent } = await run({
    messages: msgs(4),
    behavior: n => (n === 2 ? failSend('Invalid to header') : okSend()),
  });
  assert.equal(sent.length, 4, 'all four were still attempted');
  assert.deepEqual(body.results.map(r => r.ok), [true, false, true, true]);
  assert.equal(body.results[1].error, 'Invalid to header');
  assert.equal(db.inserted.filter(r => r[7] === 'failed').length, 1);
  assert.equal(db.inserted[1][8], 'Invalid to header');
});

await t('a revoked token stops the batch instead of burning through the list', async () => {
  const { body, sent, db } = await run({
    messages: msgs(5),
    behavior: n => (n === 1 ? okSend() : authFail()),
  });
  assert.equal(body.reconnect, true);
  assert.equal(sent.length, 2, 'stopped after the failure rather than trying all five');
  assert.equal(body.results.filter(r => r.ok).length, 1);
  assert.match(body.results[2].error, /Not attempted/);
  // Only the two real attempts are logged; the unattempted three are not.
  assert.equal(db.inserted.length, 2);
});

await t('no connected account is a 409 and writes nothing', async () => {
  const { res, body, db } = await run({ messages: msgs(2), behavior: okSend, sealed: false });
  assert.equal(res.status, 409);
  assert.equal(body.reconnect, true);
  assert.equal(db.inserted.length, 0);
});

await t('the From header names the chapter and uses the connected account', async () => {
  const { sent } = await run({ messages: msgs(1), behavior: okSend });
  assert.match(sent[0].mime, /^From: "ANHS CSF" <adviser@school\.org>$/m);
});

await t('an accented body survives the round trip to Gmail', async () => {
  const { sent } = await run({
    messages: [{ email: 'a@b.org', name: 'José', studentId: '1', subject: 'Héllo', body: 'Hi José — ¿bien?' }],
    behavior: okSend,
  });
  const b64body = sent[0].mime.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64body), ch => ch.charCodeAt(0)));
  assert.equal(decoded, 'Hi José — ¿bien?');
  assert.match(sent[0].mime, /^Subject: =\?UTF-8\?B\?/m);
});

await t('a header injection attempt is flattened, not honored', async () => {
  const { sent } = await run({
    messages: [{ email: 'a@b.org', name: 'x', studentId: '1', subject: 'Hi\r\nBcc: sneak@evil.org', body: 'b' }],
    behavior: okSend,
  });
  const headers = sent[0].mime.split('\r\n\r\n')[0];
  // The text survives, but only as part of the Subject value: what matters is
  // that no line *starts* a new header.
  assert.ok(!/^Bcc:/mi.test(headers), 'no Bcc header was smuggled in');
  assert.match(headers, /^Subject: Hi Bcc: sneak@evil\.org$/m);
  assert.equal(headers.split('\r\n').length, 6, 'no extra header lines appeared');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
