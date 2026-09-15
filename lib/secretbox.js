// Symmetric sealing for the one long-lived secret the portal has to store: the
// Gmail refresh token. A refresh token is as good as the mailbox, and unlike the
// session cookie it cannot be made short-lived, so it does not go into D1 in the
// clear. The key is derived from SESSION_SECRET, which already has to be present
// for any authenticated route to work.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function keyFor(secret) {
  if (!secret) throw new Error('SESSION_SECRET is not configured.');
  const material = await crypto.subtle.digest('SHA-256', enc.encode(String(secret)));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Returns "<iv>.<ciphertext>", both base64. A fresh IV per call, as AES-GCM
// requires — reusing one across two seals would leak the plaintext difference.
export async function seal(secret, plaintext) {
  const key = await keyFor(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `${toB64(iv)}.${toB64(new Uint8Array(box))}`;
}

// Throws if the payload was tampered with or the secret has changed, which is
// the intended behavior: callers treat a failure as "not connected" and ask for
// a fresh authorization rather than guessing.
export async function open(secret, sealed) {
  const [ivPart, boxPart] = String(sealed).split('.');
  if (!ivPart || !boxPart) throw new Error('Stored credential is malformed.');
  const key = await keyFor(secret);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivPart) }, key, fromB64(boxPart)
  );
  return dec.decode(plain);
}
