// Placeholder substitution for bulk mail. No DOM, so scripts/test-scoring.mjs
// can exercise it: getting a name wrong in fifty emails at once is exactly the
// kind of mistake worth a test.

import { statusFor } from './scoring.js';
import { reasonsFor, notesFor, REASON_LABEL } from './review.js';

// Shown as clickable chips in the compose panel, so this list is the
// documentation as well as the implementation.
export const TEMPLATE_VARS = [
  ['name', 'Full name as submitted'],
  ['first', 'First name only'],
  ['email', 'Their email address'],
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
];

export const VAR_NAMES = new Set(TEMPLATE_VARS.map(([k]) => k));

// `settings` supplies the one value that does not come from the applicant: the
// term the chapter is asking for. It matters most in exactly the case where the
// card could not be read, so {term} is empty and {requiredTerm} is all you have.
export function varsFor(a, settings = {}) {
  const status = statusFor(a);
  const required = settings.requiredTerm;
  const reasons = [...reasonsFor(a)].map(k => REASON_LABEL.get(k) ?? k);
  return {
    name: a.name ?? '',
    // Falls back to the whole name rather than an empty greeting, which is the
    // failure a reader would actually notice.
    first: String(a.name ?? '').trim().split(/\s+/)[0] || (a.name ?? ''),
    email: a.email ?? '',
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
