// Placeholder substitution for bulk mail. No DOM, so scripts/test-scoring.mjs
// can exercise it: getting a name wrong in fifty emails at once is exactly the
// kind of mistake worth a test.

import { statusFor } from './scoring.js';
import { reasonsFor, notesFor, REASON_LABEL, RETURNING } from './review.js';

// Shown as clickable chips in the compose panel, so this list is the
// documentation as well as the implementation.
export const TEMPLATE_VARS = [
  ['name', 'Full name, in reading order'],
  ['first', 'First name only'],
  ['email', 'Address this message is going to'],
  ['personalEmail', 'Personal email'],
  ['schoolEmail', 'School email'],
  ['studentId', 'Student ID'],
  ['level', 'Grade level'],
  ['status', 'QUALIFIED / NOT QUALIFIED / NEEDS REVIEW'],
  ['points', 'Point total, blank while under review'],
  ['reasons', 'Why they need review, comma separated'],
  ['problems', 'What went wrong with their report card'],
  ['notes', 'Everything in the Notes column'],
  ['courses', 'Courses read from the card, with grades'],
  ['school', 'School name read from the card'],
  ['term', 'Semester read from the card'],
  ['requiredTerm', 'Semester you are asking them for'],
  ['returning', 'Whether they were in CSF last year'],
  ['returningRaw', 'Their exact answer about last year'],
];

export const VAR_NAMES = new Set(TEMPLATE_VARS.map(([k]) => k));

// Rosters hand out names as "Last, First Middle" — the Google Forms export and
// Aeries both do it, and some surnames are two words ("Bacellar Ahmadi, Lucas").
// Splitting on whitespace would greet that student as "Hi Bacellar", so the
// comma decides which half is which. Without a comma the name is already in
// reading order.
export function splitName(raw) {
  const full = String(raw ?? '').trim();
  if (!full) return { natural: '', first: '' };

  const comma = full.indexOf(',');
  if (comma === -1) return { natural: full, first: full.split(/\s+/)[0] };

  const last = full.slice(0, comma).trim();
  const given = full.slice(comma + 1).trim();
  return {
    // A trailing comma with nothing after it leaves the surname standing alone,
    // which is still better than an empty greeting.
    natural: [given, last].filter(Boolean).join(' '),
    first: given.split(/[\s,]+/).filter(Boolean)[0] || last,
  };
}

// `settings` supplies the one value that does not come from the applicant: the
// term the chapter is asking for. It matters most in exactly the case where the
// card could not be read, so {term} is empty and {requiredTerm} is all you have.
export function varsFor(a, settings = {}) {
  const status = statusFor(a);
  const required = settings.requiredTerm;
  const { natural, first } = splitName(a.name);
  const reasons = [...reasonsFor(a)].map(k => REASON_LABEL.get(k) ?? k);
  return {
    // Reading order, not the roster's "Last, First": these go into a sentence
    // addressed to the student. The table still shows the name as submitted, so
    // a reviewer can match it against the CSV.
    name: natural,
    first,
    // {email} is the address the message is actually going to, which is the
    // personal one — the school accounts have no inbox. The other two are here
    // for when the text needs to name a specific address.
    email: a.email ?? '',
    personalEmail: a.personalEmail ?? '',
    schoolEmail: a.schoolEmail ?? '',
    studentId: a.studentId ?? '',
    level: a.level ?? '',
    status,
    // Withheld under review for the same reason the table withholds it: the
    // number is real but answers the wrong question.
    points: status === 'NEEDS REVIEW' ? '' : String(a.result?.total ?? ''),
    reasons: reasons.join(', '),
    problems: (a.problems ?? []).map(p => p.text).join('; '),
    notes: notesFor(a).join('; '),
    courses: (a.scored ?? []).map(c => `${c.name} (${c.grade})`).join(', '),
    school: (a.schools ?? []).join(' + '),
    term: (a.terms ?? []).map(t => t.label).join(' + '),
    requiredTerm: required ? `${required.term} ${required.year}` : '',
    // The short label, not the four-line questionnaire answer. {returningRaw}
    // is there for anyone who does want to quote it back.
    returning: RETURNING[a.returning] ?? '',
    returningRaw: a.returningRaw ?? '',
  };
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

// Unknown placeholders are left exactly as written and reported back, rather
// than silently becoming an empty string. A typo'd {frist} that quietly vanished
// would ship a broken greeting to the whole list.
export function renderTemplate(text, vars) {
  const unknown = new Set();
  const out = String(text ?? '').replace(PLACEHOLDER, (whole, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      unknown.add(key);
      return whole;
    }
    return vars[key];
  });
  return { text: out, unknown: [...unknown] };
}

// Convenience for the send path: renders both halves and pools the complaints.
export function renderMessage({ subject, body }, a, settings = {}) {
  const vars = varsFor(a, settings);
  const s = renderTemplate(subject, vars);
  const b = renderTemplate(body, vars);
  return {
    subject: s.text,
    body: b.text,
    unknown: [...new Set([...s.unknown, ...b.unknown])],
  };
}
