import { scoreApplicant, normalizeGrade, parseCsv, toCsv, checkSubmission, statusFor, DEFAULT_SETTINGS } from '../public/scoring.js';
import { reasonsFor, needsReview, notesFor, REASON_LABEL, RETURNING, classifyReturning, wasMember, isTransfer } from '../public/review.js';
import { renderTemplate, renderMessage, varsFor, splitName } from '../public/email.js';
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); }
};

const c = (name, grade, category = 'Regular') => ({ name, grade, category });

console.log('grades');
t('plus/minus fold to the base letter', () => {
  assert.equal(normalizeGrade('A+'), 'A');
  assert.equal(normalizeGrade('A-'), 'A');
  assert.equal(normalizeGrade('B-'), 'B');
});
t('non-letter marks are not grades', () => {
  for (const m of ['NM', 'I', 'W', 'CR', 'NC', '', 'S', 'O']) assert.equal(normalizeGrade(m), null);
});

console.log('scoring');
t('four A + one B = 13, qualified', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','A'),c('e','B')]);
  assert.equal(r.total, 13); assert.equal(r.qualified, true);
});
t('exactly 10 qualifies', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','B')]);
  assert.equal(r.total, 10); assert.equal(r.qualified, true);
});
t('9 points does not qualify', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A')]);
  assert.equal(r.total, 9); assert.equal(r.qualified, false);
});
t('C is worth zero', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','C'),c('e','C')]);
  assert.equal(r.total, 9); assert.equal(r.qualified, false);
});
t('a D disqualifies regardless of total', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','A'),c('e','D')]);
  assert.equal(r.qualified, false); assert.match(r.reason, /D in e/);
});
t('an F disqualifies', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','A'),c('e','F')]);
  assert.equal(r.qualified, false);
});
t('only the best 5 courses count', () => {
  const r = scoreApplicant(Array.from({length:7},(_,i)=>c('c'+i,'A')));
  assert.equal(r.total, 15); assert.equal(r.chosen.length, 5);
});
t('athletics courses are excluded entirely', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('Ath Football','A','Inapplicable')]);
  assert.equal(r.total, 9);
  assert.ok(!r.chosen.some(x => x.name === 'Ath Football'));
});
t('a D in an athletics course does not disqualify by default', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','B'),c('Ath Golf G','D','Inapplicable')]);
  assert.equal(r.qualified, true); assert.equal(r.total, 10);
});
t('strict mode: a D anywhere disqualifies', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','B'),c('Ath Golf G','D','Inapplicable')],
    { dfAnywhereDisqualifies: true });
  assert.equal(r.qualified, false);
});
t('honors bonus caps at 2 courses', () => {
  const r = scoreApplicant([c('a','A','AP'),c('b','A','AP'),c('c','A','AP'),c('d','A','AP')]);
  assert.equal(r.total, 14); assert.equal(r.bonus, 2);
});
t('no bonus for a C in an AP class', () => {
  const r = scoreApplicant([c('a','C','AP'),c('b','A'),c('c','A'),c('d','A')]);
  assert.equal(r.total, 9); assert.equal(r.bonus, 0);
});
t('honors B beats regular B when a bonus slot is open', () => {
  const r = scoreApplicant([c('a','A'),c('b','A'),c('c','A'),c('d','A'),
                            c('reg','B'), c('hon','B','Honors')]);
  assert.equal(r.total, 14);
  assert.ok(r.chosen.some(x => x.name === 'hon'));
  assert.ok(!r.chosen.some(x => x.name === 'reg'));
});
t('empty course list is handled', () => {
  const r = scoreApplicant([]);
  assert.equal(r.qualified, false); assert.deepEqual(r.flags, ['no-courses']);
});

console.log('submission checks');
const SETTINGS = { ...DEFAULT_SETTINGS, requiredTerm: { term: 'Spring', year: 2026 } };
const spring26 = { semesterNo: 2, season: 'Spring', year: 2026, label: '2nd Semester ending 6/4/2026' };
const fall25   = { semesterNo: 1, season: 'Fall',   year: 2025, label: '1st Semester ending 12/18/2025' };

const sub = (schools, terms, st = SETTINGS) =>
  checkSubmission({ schools: [].concat(schools), terms: [].concat(terms) }, st);

t('the required term passes', () => {
  const r = sub('Aliso Niguel High School', spring26);
  assert.equal(r.termOk, true); assert.equal(r.schoolOk, true);
});
t('the previous fall is rejected', () => {
  const r = sub('Aliso Niguel High School', fall25);
  assert.equal(r.termOk, false);
  assert.match(r.termReason, /Fall 2025, expected Spring 2026/);
});
t('the right season in the wrong year is rejected', () => {
  assert.equal(sub('Aliso Niguel High School', { ...spring26, year: 2025 }).termOk, false);
});
t('both accepted schools match', () => {
  for (const name of ['Aliso Niguel High School', 'California Preparatory Academy']) {
    assert.equal(sub(name, spring26).schoolOk, true);
  }
});
t('school matching ignores case, punctuation and spacing', () => {
  for (const v of ['ALISO NIGUEL HIGH SCHOOL', 'aliso  niguel   high school',
                   'Aliso Niguel High School - Capistrano USD']) {
    assert.equal(sub(v, spring26).schoolOk, true);
  }
});
t('another school is flagged, not passed', () => {
  const r = sub('Silicon Valley High (Nevada)', spring26);
  assert.equal(r.schoolOk, false);
  assert.match(r.schoolReason, /Silicon Valley/);
});
t('an unread heading is undecided rather than a failure', () => {
  const r = sub([], []);
  assert.equal(r.schoolOk, null); assert.equal(r.termOk, null);
});
t('a Fall requirement accepts a fall card', () => {
  const r = sub('Aliso Niguel High School', fall25,
    { ...DEFAULT_SETTINGS, requiredTerm: { term: 'Fall', year: 2025 } });
  assert.equal(r.termOk, true);
});

console.log('submission checks: multiple cards');
t('an Aliso + Cal Prep pair both from the right term passes', () => {
  const r = sub(['Aliso Niguel High School', 'California Preparatory Academy'],
                [spring26, spring26]);
  assert.equal(r.schoolOk, true); assert.equal(r.termOk, true);
});
t('a wrong-term SECOND card is caught, not just the first', () => {
  const r = sub(['Aliso Niguel High School', 'California Preparatory Academy'],
                [spring26, fall25]);
  assert.equal(r.termOk, false);
  assert.match(r.termReason, /Fall 2025/);
});
t('an unrecognized SECOND school is caught', () => {
  const r = sub(['Aliso Niguel High School', 'Some Other High'], [spring26, spring26]);
  assert.equal(r.schoolOk, false);
  assert.match(r.schoolReason, /Some Other High/);
});
t('one unreadable card does not mask a bad sibling', () => {
  const r = sub(['Aliso Niguel High School'], [spring26, fall25]);
  assert.equal(r.termOk, false);
});

console.log('status');
const passing = { total: 13, qualified: true, flags: [] };
const short   = { total: 8,  qualified: false, flags: [] };
const clean   = { schoolOk: true, termOk: true };

t('enough points qualifies', () => {
  assert.equal(statusFor({ result: passing, check: clean }), 'QUALIFIED');
});
t('too few points is not qualified', () => {
  assert.equal(statusFor({ result: short, check: clean }), 'NOT QUALIFIED');
});
t('a wrong-semester card needs review, never not-qualified', () => {
  assert.equal(statusFor({ result: passing, check: { schoolOk: true, termOk: false } }), 'NEEDS REVIEW');
  assert.equal(statusFor({ result: short,   check: { schoolOk: true, termOk: false } }), 'NEEDS REVIEW');
});
t('an unrecognized school needs review', () => {
  assert.equal(statusFor({ result: passing, check: { schoolOk: false, termOk: true } }), 'NEEDS REVIEW');
});
t('an unreadable card needs review rather than failing the student', () => {
  assert.equal(statusFor({ result: { total: 0, qualified: false, flags: ['no-courses'] }, check: clean }),
    'NEEDS REVIEW');
  assert.equal(statusFor({}), 'NEEDS REVIEW');
});
t('undecided checks do not block a pass', () => {
  assert.equal(statusFor({ result: passing, check: { schoolOk: null, termOk: null } }), 'QUALIFIED');
});
t('a submission problem is never reported as an academic failure', () => {
  for (const check of [{ termOk: false }, { schoolOk: false }, { termOk: false, schoolOk: false }]) {
    assert.notEqual(statusFor({ result: short, check }), 'NOT QUALIFIED');
  }
});

console.log('review reasons');

// A whole applicant as rescoreAll leaves it, so the reason helpers are exercised
// against the real shape rather than a hand-tuned stub.
const applicant = (over = {}) => ({
  index: 0, name: 'Ana Ruiz', studentId: '900123', email: 'ana@example.org',
  level: 'Sophomore', links: ['https://drive.example/card'],
  courses: [], scored: [], problems: [], unknown: [],
  schools: ['Aliso Niguel High School'], terms: [spring26],
  result: { total: 13, base: 13, bonus: 0, chosen: [], qualified: true, flags: [] },
  check: { schoolOk: true, termOk: true, schoolReason: null, termReason: null },
  ...over,
});

const problem = code => ({ code, text: `text for ${code}` });

t('a clean applicant needs no review', () => {
  assert.equal(needsReview(applicant()), false);
  assert.deepEqual([...reasonsFor(applicant())], []);
});
t('a missing grade table is its own reason, not a generic file problem', () => {
  const a = applicant({ problems: [problem('no-grade-table')] });
  assert.deepEqual([...reasonsFor(a)], ['no-grade-table']);
  assert.equal(needsReview(a), true);
});
t('a scanned card is told apart from a wrong document', () => {
  assert.deepEqual([...reasonsFor(applicant({ problems: [problem('no-text')] }))], ['no-text']);
  assert.deepEqual([...reasonsFor(applicant({ problems: [problem('download')] }))], ['download']);
  assert.deepEqual([...reasonsFor(applicant({ problems: [problem('read-error')] }))], ['read-error']);
});
t('every problem code has a label to show in the audience list', () => {
  for (const code of ['no-grade-table', 'no-text', 'download', 'read-error']) {
    assert.ok(REASON_LABEL.get(code), `no label for ${code}`);
  }
});
t('one applicant can sit in several buckets at once', () => {
  const a = applicant({
    problems: [problem('no-grade-table')],
    unknown: ['Underwater Basketry'],
    check: { schoolOk: true, termOk: false, termReason: 'Fall 2025, expected Spring 2026' },
  });
  assert.deepEqual([...reasonsFor(a)].sort(), ['no-grade-table', 'term', 'unlisted']);
});
t('a qualified applicant with an unlisted course still needs a look', () => {
  const a = applicant({ unknown: ['Some New Elective'] });
  assert.equal(statusFor(a), 'QUALIFIED');
  assert.equal(needsReview(a), true);
});
t('notes read the text off each problem, not the object', () => {
  const notes = notesFor(applicant({ problems: [problem('no-grade-table')] }));
  assert.ok(notes.includes('text for no-grade-table'));
  assert.ok(!notes.some(n => typeof n !== 'string'));
});

console.log('prior CSF membership');

// The four answers the application actually offers, verbatim.
const ANSWERS = {
  yes: 'Yes',
  no: 'No',
  transferNew: 'I did not attend ANHS last year, and WAS NOT a member at a different school',
  transferMember: 'I did not attend ANHS last year, and WAS a member at a different school',
};

t('each of the four answers classifies distinctly', () => {
  assert.equal(classifyReturning(ANSWERS.yes), 'yes');
  assert.equal(classifyReturning(ANSWERS.no), 'no');
  assert.equal(classifyReturning(ANSWERS.transferNew), 'transfer-new');
  assert.equal(classifyReturning(ANSWERS.transferMember), 'transfer-member');
});
t('"WAS NOT a member" is not read as "WAS a member"', () => {
  // Both transfer answers contain "was a member" as a substring, so checking
  // the negative first is the whole trick. Getting this backwards would tell a
  // brand-new applicant we had them on last year's roster.
  assert.notEqual(classifyReturning(ANSWERS.transferNew), 'transfer-member');
  assert.equal(wasMember(classifyReturning(ANSWERS.transferNew)), false);
  assert.equal(wasMember(classifyReturning(ANSWERS.transferMember)), true);
});
t('membership carries across schools but transfer status does not', () => {
  assert.deepEqual(
    ['yes', 'no', 'transfer-new', 'transfer-member'].map(c => [wasMember(c), isTransfer(c)]),
    [[true, false], [false, false], [false, true], [true, true]]
  );
});
t('an unmapped or blank column is undecided, not a "no"', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(classifyReturning(v), null);
    assert.equal(wasMember(classifyReturning(v)), false);
  }
});
t('a reworded answer is flagged rather than silently bucketed', () => {
  assert.equal(classifyReturning('Not sure'), 'other');
  assert.ok(RETURNING.other);
});
t('classification tolerates case and spacing', () => {
  assert.equal(classifyReturning('  YES  '), 'yes');
  assert.equal(classifyReturning(ANSWERS.transferMember.toUpperCase()), 'transfer-member');
  assert.equal(classifyReturning(ANSWERS.transferNew.replace(/ /g, '   ')), 'transfer-new');
});
t('every code has a label for the audience list', () => {
  for (const code of ['yes', 'no', 'transfer-new', 'transfer-member', 'other']) {
    assert.ok(RETURNING[code], `no label for ${code}`);
  }
});

console.log('email addresses and membership as variables');
t('{email} is the personal address, never the school one', () => {
  const v = varsFor(applicant({
    email: 'me@gmail.com', personalEmail: 'me@gmail.com', schoolEmail: 'me@student.anhs.us',
  }));
  assert.equal(v.email, 'me@gmail.com');
  assert.equal(v.personalEmail, 'me@gmail.com');
  assert.equal(v.schoolEmail, 'me@student.anhs.us');
});
t('a missing school email renders blank, not "undefined"', () => {
  const v = varsFor(applicant({ schoolEmail: undefined }));
  assert.equal(v.schoolEmail, '');
});
t('{returning} is the short label and {returningRaw} the exact answer', () => {
  const v = varsFor(applicant({
    returningRaw: ANSWERS.transferMember,
    returning: classifyReturning(ANSWERS.transferMember),
  }));
  assert.equal(v.returning, 'Transfer, was a member');
  assert.equal(v.returningRaw, ANSWERS.transferMember);
});
t('an unanswered membership question renders blank', () => {
  const v = varsFor(applicant({ returningRaw: '', returning: null }));
  assert.equal(v.returning, '');
  assert.equal(v.returningRaw, '');
});

console.log('email templates');
t('placeholders are filled per recipient', () => {
  const out = renderTemplate('Hi {first}, your id is {studentId}.',
    varsFor(applicant({ name: 'Ana Ruiz' })));
  assert.equal(out.text, 'Hi Ana, your id is 900123.');
  assert.deepEqual(out.unknown, []);
});
t('a one-word name still yields a first name', () => {
  assert.equal(varsFor(applicant({ name: 'Prince' })).first, 'Prince');
});
t('a roster "Last, First" name is not greeted by its surname', () => {
  // The real shape of the Google Forms export, and a two-word surname at that:
  // splitting on whitespace would have addressed this student as "Bacellar".
  const v = varsFor(applicant({ name: 'Bacellar Ahmadi, Lucas' }));
  assert.equal(v.first, 'Lucas');
  assert.equal(v.name, 'Lucas Bacellar Ahmadi');
});
t('a two-word given name takes only the first word', () => {
  const v = varsFor(applicant({ name: 'Nguyen, Anh Thu' }));
  assert.equal(v.first, 'Anh');
  assert.equal(v.name, 'Anh Thu Nguyen');
});
t('a name already in reading order is left alone', () => {
  const v = varsFor(applicant({ name: 'Lucas Bacellar Ahmadi' }));
  assert.equal(v.first, 'Lucas');
  assert.equal(v.name, 'Lucas Bacellar Ahmadi');
});
t('a half-typed name never produces an empty greeting', () => {
  assert.equal(splitName('Smith,').first, 'Smith');
  assert.equal(splitName(', Lucas').first, 'Lucas');
  assert.equal(splitName('Smith, John, Jr').first, 'John');
});
t('a blank name yields blanks rather than throwing', () => {
  assert.deepEqual(splitName('   '), { natural: '', first: '' });
  assert.deepEqual(splitName(undefined), { natural: '', first: '' });
});
t('an unknown placeholder is reported and left alone, never blanked', () => {
  const out = renderTemplate('Hi {frist}', varsFor(applicant()));
  assert.equal(out.text, 'Hi {frist}');
  assert.deepEqual(out.unknown, ['frist']);
});
t('an unknown placeholder is only reported once however often it appears', () => {
  assert.deepEqual(renderTemplate('{x} {x} {x}', varsFor(applicant())).unknown, ['x']);
});
t('braces that are not placeholders survive untouched', () => {
  const out = renderTemplate('use {} or { name } or {9lives}', varsFor(applicant()));
  assert.equal(out.text, 'use {} or { name } or {9lives}');
  assert.deepEqual(out.unknown, []);
});
t('points are withheld under review, matching the table', () => {
  const under = applicant({ check: { schoolOk: true, termOk: false } });
  assert.equal(varsFor(under).points, '');
  assert.equal(varsFor(applicant()).points, '13');
});
t('{requiredTerm} comes from settings, not from the unreadable card', () => {
  // The case that matters: the card could not be read, so {term} is empty and
  // the only semester you can name is the one you are asking for.
  const a = applicant({ terms: [], problems: [problem('no-grade-table')] });
  const vars = varsFor(a, SETTINGS);
  assert.equal(vars.term, '');
  assert.equal(vars.requiredTerm, 'Spring 2026');
});
t('{requiredTerm} is blank rather than "undefined" with no settings', () => {
  assert.equal(varsFor(applicant()).requiredTerm, '');
});
t('{reasons} reads as a human list, not internal codes', () => {
  const a = applicant({ problems: [problem('no-grade-table')] });
  assert.equal(varsFor(a).reasons, 'No Aeries grade table');
});
t('subject and body pool their unknown placeholders', () => {
  const out = renderMessage({ subject: 'Hi {oops}', body: 'Bye {alsobad} {first}' }, applicant());
  assert.deepEqual(out.unknown.sort(), ['alsobad', 'oops']);
  assert.equal(out.body, 'Bye {alsobad} Ana');
});
t('a substituted value is never re-scanned for placeholders', () => {
  // A name of "{first}" must not recurse; replace() semantics guarantee it, and
  // this pins that guarantee down.
  const out = renderTemplate('Hi {name}', varsFor(applicant({ name: '{first}' })));
  assert.equal(out.text, 'Hi {first}');
  assert.deepEqual(out.unknown, []);
});
t('an empty template renders to nothing rather than throwing', () => {
  assert.equal(renderTemplate('', varsFor(applicant())).text, '');
  assert.equal(renderTemplate(undefined, varsFor(applicant())).text, '');
});

console.log('csv');
t('quoted commas and embedded newlines survive', () => {
  const rows = parseCsv('a,"b,c","d\ne"\n1,2,3\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd\ne']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});
t('escaped quotes survive', () => {
  assert.deepEqual(parseCsv('"say ""hi""",x')[0], ['say "hi"', 'x']);
});
t('round-trips through toCsv', () => {
  const rows = [['a', 'b,c', 'd"e'], ['1', '2', '3']];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
// The real export is deliberately not committed — it holds applicant data. When
// a copy is present locally, check the parser against it.
const REAL_CSV = 'CSF Fall 2026 Application Responses.csv';
if (existsSync(REAL_CSV)) {
  t('a real Google Forms export parses (header has newlines inside quoted cells)', () => {
    const rows = parseCsv(readFileSync(REAL_CSV, 'utf8'));
    assert.equal(rows[0].length, 13);
    assert.ok(rows.length > 1);
  });
} else {
  console.log('  skip the real application CSV (not present — see README)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
