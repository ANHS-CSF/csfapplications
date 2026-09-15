// What puts an applicant in the review pile, and how to name it. Kept apart
// from ui.js so it can be unit-tested, and apart from scoring.js because none of
// it is about points: these are the reasons a human still has to look.

import { statusFor } from './scoring.js';

// Codes attached to each entry in `applicant.problems`. The code is what the
// audience filters and the reason dropdown match on; the text is what a reviewer
// reads. Splitting these apart is what makes "email everyone whose card had no
// Aeries grade table" expressible — before, every file problem was one bucket.
export const PROBLEM = {
  'no-grade-table': 'No Aeries grade table',
  'no-text': 'Unreadable / scanned card',
  'download': 'Card could not be downloaded',
  'read-error': 'Could not read the PDF',
};

// One applicant can land in several buckets, so this is a set, not a label.
export const REVIEW_REASONS = [
  ['term', 'Wrong semester'],
  ['school', 'Unrecognized school'],
  ['no-grade-table', PROBLEM['no-grade-table']],
  ['no-text', PROBLEM['no-text']],
  ['download', PROBLEM.download],
  ['read-error', PROBLEM['read-error']],
  ['nocourses', 'No courses found'],
  ['unlisted', 'Course not in rules'],
];

export const REASON_LABEL = new Map(REVIEW_REASONS);

export function reasonsFor(a) {
  const set = new Set();
  if (a.check?.termOk === false) set.add('term');
  if (a.check?.schoolOk === false) set.add('school');
  for (const p of a.problems ?? []) if (p?.code) set.add(p.code);
  if (a.result?.flags?.includes('no-courses')) set.add('nocourses');
  if (a.unknown?.length) set.add('unlisted');
  return set;
}

// Wants a human's attention, which is broader than the status: an applicant can
// be comfortably QUALIFIED and still have an unlisted course worth classifying.
export const needsReview = a =>
  (a.problems?.length ?? 0) > 0 || (a.unknown?.length ?? 0) > 0 || statusFor(a) === 'NEEDS REVIEW';

export function notesFor(a) {
  const notes = (a.problems ?? []).map(p => p.text);
  if (a.check?.termReason) notes.push(a.check.termReason);
  if (a.check?.schoolReason) notes.push(a.check.schoolReason);
  if (a.unknown?.length) notes.push(`${a.unknown.length} unlisted course${a.unknown.length > 1 ? 's' : ''}`);
  if (a.links?.length > 1) notes.push('two cards merged');
  if (/fresh/i.test(a.level ?? '')) notes.push('freshman — cannot apply');
  if (a.result?.reason) notes.push(a.result.reason);
  if (a.result?.flags?.length) notes.push(...a.result.flags.filter(f => f !== 'D/F' && f !== 'no-courses'));
  return notes;
}
