// CSF scoring rules and CSV handling. No DOM or pdf.js here, so this module
// runs unchanged in Node for the test suite.
/* ---------------------------------------------------------------- rules --- */

export const GRADE_POINTS = { A: 3, B: 1, C: 0 };
const MAX_COUNTED_COURSES = 5;
const MAX_BONUS_COURSES = 2;
const QUALIFY_AT = 10;

// "A+", "A-" and "A" are all just an A for CSF purposes. Non-letter marks
// (NM = no mark, I = incomplete, W = withdrew, CR/NC = credit/no credit) are
// not graded courses and are dropped rather than scored.
export function normalizeGrade(raw) {
  const t = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = t.match(/^([ABCDF])[+-]?$/);
  return m ? m[1] : null;
}

/**
 * Score one applicant's course list.
 *
 * Brute-forces every subset of at most 5 countable courses rather than greedily
 * taking the best 5 grades. Greedy is wrong here: an Honors B is worth 2 points
 * (1 + bonus) and can beat a Regular B, but only while bonus slots remain, so
 * the best subset isn't determined by grade alone.
 */
export function scoreApplicant(courses, { dfAnywhereDisqualifies = false } = {}) {
  const counted = courses.filter(c => c.category !== 'Inapplicable');
  const flags = [];

  const dfPool = dfAnywhereDisqualifies ? courses : counted;
  const failing = dfPool.filter(c => c.grade === 'D' || c.grade === 'F');
  if (failing.length) {
    return {
      total: 0,
      chosen: [],
      qualified: false,
      reason: `Has a ${failing[0].grade} in ${failing[0].name}`,
      flags: ['D/F'],
    };
  }

  const gradable = counted.filter(c => c.grade in GRADE_POINTS);
  if (!gradable.length) {
    return { total: 0, chosen: [], qualified: false, reason: 'No gradable courses found', flags: ['no-courses'] };
  }

  // Keep the search small; anything past the 12 most valuable courses can never
  // make the best-5 subset.
  const pool = [...gradable]
    .sort((a, b) => value(b) - value(a))
    .slice(0, 12);

  let best = { total: -1, chosen: [] };
  for (let mask = 0; mask < (1 << pool.length); mask++) {
    const picked = [];
    for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) picked.push(pool[i]);
    if (picked.length > MAX_COUNTED_COURSES) continue;

    const base = picked.reduce((sum, c) => sum + GRADE_POINTS[c.grade], 0);
    const bonus = Math.min(MAX_BONUS_COURSES, picked.filter(isBonusEligible).length);
    const total = base + bonus;
    if (total > best.total) best = { total, chosen: picked, bonus, base };
  }

  if (gradable.length > MAX_COUNTED_COURSES) flags.push(`best ${MAX_COUNTED_COURSES} of ${gradable.length}`);

  return {
    total: best.total,
    base: best.base,
    bonus: best.bonus,
    chosen: best.chosen,
    qualified: best.total >= QUALIFY_AT,
    reason: null,
    flags,
  };
}

const isBonusEligible = c => (c.category === 'AP' || c.category === 'Honors') && (c.grade === 'A' || c.grade === 'B');
const value = c => (GRADE_POINTS[c.grade] ?? -1) + (isBonusEligible(c) ? 1 : 0);

/* ----------------------------------------------------- submission checks --- */

export const DEFAULT_SETTINGS = {
  allowedSchools: ['Aliso Niguel High School', 'California Preparatory Academy'],
  requiredTerm: { term: 'Spring', year: 2026 },
  dfAnywhereDisqualifies: false,
};

const loosen = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Check an applicant's report cards came from accepted schools and the required term.
 *
 * Takes every card the applicant submitted, not just the first: a student who
 * attaches a concurrent-enrollment card alongside their main one has two cards,
 * and a wrong-term second card is just as disqualifying as a wrong-term first one.
 *
 * The two failures are not equivalent and are not treated as such. A card from
 * the wrong semester is a disqualifying submission. An unrecognized school only
 * earns a flag — it may be a transfer, a concurrent enrollment, or a heading that
 * didn't read cleanly, and none of those should silently reject a student.
 *
 * Either check returns null when nothing could be read, which means "undecided",
 * not "failed".
 */
export function checkSubmission({ schools = [], terms = [] }, settings = DEFAULT_SETTINGS) {
  const allowed = settings.allowedSchools ?? DEFAULT_SETTINGS.allowedSchools;
  const required = settings.requiredTerm ?? DEFAULT_SETTINGS.requiredTerm;

  const seenSchools = schools.filter(Boolean);
  const badSchool = seenSchools.find(name => {
    const haystack = loosen(name);
    return !allowed.some(ok => haystack.includes(loosen(ok)));
  });

  const seenTerms = terms.filter(Boolean);
  const badTerm = seenTerms.find(t =>
    t.season !== required.term || (t.year != null && t.year !== required.year));

  return {
    schoolOk: seenSchools.length ? !badSchool : null,
    termOk: seenTerms.length ? !badTerm : null,
    schoolReason: badSchool ? `Unrecognized school: ${String(badSchool).slice(0, 60)}` : null,
    termReason: badTerm
      ? `Wrong semester: card is ${badTerm.year ? `${badTerm.season} ${badTerm.year}` : badTerm.season}` +
        `, expected ${required.term} ${required.year}`
      : null,
  };
}

/**
 * The final call on an applicant, kept here rather than in the UI because it is
 * the one decision that determines a student's outcome and so is worth testing.
 *
 * Three outcomes, and the distinction that matters most is between the second
 * and third: NOT QUALIFIED means "we read this card and the points fall short",
 * while NEEDS REVIEW means "we could not fairly judge this yet". A submission
 * problem — an unreadable PDF, an unrecognized school, the wrong semester — is
 * never allowed to read as an academic failure, because those are fixable by an
 * email and a resubmission.
 */
export function statusFor({ result, check } = {}) {
  if (!result || result.flags?.includes('no-courses')) return 'NEEDS REVIEW';
  if (check?.termOk === false || check?.schoolOk === false) return 'NEEDS REVIEW';
  return result.qualified ? 'QUALIFIED' : 'NOT QUALIFIED';
}

/* ------------------------------------------------------------------ csv --- */

// Full RFC-4180 parse. Required, not optional: the Google Forms export puts
// newlines inside quoted header cells, so a line-based split corrupts row 1.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim()));
}

export function toCsv(rows) {
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}
