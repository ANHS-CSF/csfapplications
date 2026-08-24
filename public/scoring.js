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
