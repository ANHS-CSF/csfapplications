import { scoreApplicant, normalizeGrade, parseCsv, toCsv } from '../public/scoring.js';
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
