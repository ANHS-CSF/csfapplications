// Aeries report-card reading, isolated because it is the only part that needs pdf.js.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import { normalizeGrade } from './scoring.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

// Rebuild visual lines from pdf.js text items. getTextContent() returns items in
// content-stream order, which on an Aeries card interleaves the header block,
// the GPA block and the course table — so grouping by y and sorting by x is what
// makes the table readable at all.
function toLines(items) {
  const rows = new Map();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5] / 3) * 3;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: it.transform[4], s: it.str.trim() });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x));
}

/**
 * Pull course rows out of an Aeries semester grade report.
 *
 * Aeries emits every table cell as its own text item at a fixed x, so the
 * header row ("Per | Course | Teacher | 2nd | Credit | ...") gives exact column
 * boundaries. Slicing by those x ranges beats regex-splitting the line: it
 * survives multi-word course names and two-word teacher surnames alike.
 */
export async function extractCourses(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const courses = [];
  const allLines = [];
  let sawText = false;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const lines = toLines((await page.getTextContent()).items);
    if (lines.length) sawText = true;
    allLines.push(...lines.map(cells => cells.map(c => c.s).join(' ')));

    const headerIdx = lines.findIndex(l => {
      const joined = l.map(c => c.s).join(' ');
      return /\bCourse\b/.test(joined) && /\bTeacher\b/.test(joined) && /Credit/.test(joined);
    });
    if (headerIdx < 0) continue;

    const header = lines[headerIdx];
    const xOf = label => header.find(c => c.s === label)?.x ?? null;
    const xCourse = xOf('Course'), xTeacher = xOf('Teacher'), xCredit = xOf('Credit');
    if (xCourse == null || xTeacher == null || xCredit == null) continue;

    // The grade column carries no fixed label — it is the semester ordinal
    // ("1st" / "2nd"), so it is located by position rather than by name. That is
    // what lets the same parser read a 1st-semester card in the spring cycle and
    // a 2nd-semester card in the fall cycle without changing anything.
    const gradeCol = header
      .filter(c => c.x > xTeacher && c.x < xCredit)
      .sort((a, b) => a.x - b.x)[0];
    const xGrade = gradeCol?.x ?? xTeacher + (xCredit - xTeacher) / 2;

    for (const line of lines.slice(headerIdx + 1)) {
      const slice = (from, to) =>
        line.filter(c => c.x >= from - 4 && c.x < to - 4).map(c => c.s).join(' ').trim();

      const name = slice(xCourse, xTeacher);
      const gradeRaw = slice(xGrade, xCredit);
      const credit = slice(xCredit, xCredit + 26);

      // The credit value is the anchor that separates real course rows from the
      // mark legend ("A = Excellent", "B = Above Average"), the GPA block and
      // the school address — all of which contain bare grade letters.
      if (!name || !gradeRaw || !/^\d+\.\d{2}$/.test(credit)) continue;

      const grade = normalizeGrade(gradeRaw);
      if (!grade) continue;
      courses.push({ name, grade, raw: gradeRaw });
    }
  }

  return { courses, sawText, ...readHeading(allLines) };
}

// Every Aeries card prints its term as e.g. "2nd Semester Grade Report 1/5/2026
// 6/4/2026". The end date carries the year, which the ordinal alone does not:
// "2nd Semester" is Spring of whichever year the term ended.
const TERM_RE = /\b([1-4])(?:st|nd|rd|th)\s+Semester\s+Grade\s+Report\b(?:\s+(\d{1,2}\/\d{1,2}\/\d{4}))?\s*-?\s*(\d{1,2}\/\d{1,2}\/\d{4})?/i;

function readHeading(lines) {
  let term = null;
  for (const line of lines) {
    const m = line.match(TERM_RE);
    if (!m) continue;
    const semesterNo = Number(m[1]);
    const endDate = m[3] || m[2] || null;
    term = {
      semesterNo,
      // Semester 1 runs Aug-Dec (Fall); semester 2 runs Jan-Jun (Spring).
      season: semesterNo === 1 ? 'Fall' : 'Spring',
      year: endDate ? Number(endDate.split('/')[2]) : null,
      label: `${m[1]}${semesterNo === 1 ? 'st' : 'nd'} Semester${endDate ? ' ending ' + endDate : ''}`,
    };
    break;
  }

  // The school name is the card's first line. Keep a couple of candidates so a
  // rejected card can tell the reviewer what it actually said.
  const school = lines.find(l => /\b(school|academy|college)\b/i.test(l)) || null;

  return { term, school, headingLines: lines.slice(0, 6) };
}
