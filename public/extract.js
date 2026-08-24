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
  let sawText = false;
  let semester = null;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const lines = toLines((await page.getTextContent()).items);
    if (lines.length) sawText = true;

    const headerIdx = lines.findIndex(l => {
      const joined = l.map(c => c.s).join(' ');
      return /\bCourse\b/.test(joined) && /\bTeacher\b/.test(joined) && /Credit/.test(joined);
    });
    if (headerIdx < 0) continue;

    const header = lines[headerIdx];
    const xOf = label => header.find(c => c.s === label)?.x ?? null;
    const xCourse = xOf('Course'), xTeacher = xOf('Teacher'), xCredit = xOf('Credit');
    if (xCourse == null || xTeacher == null || xCredit == null) continue;

    // The grade column has no fixed label — it's the semester ("1st"/"2nd"),
    // which also tells us which term this card covers.
    const gradeCol = header
      .filter(c => c.x > xTeacher && c.x < xCredit)
      .sort((a, b) => a.x - b.x)[0];
    const xGrade = gradeCol?.x ?? xTeacher + (xCredit - xTeacher) / 2;
    if (gradeCol && /^\d(st|nd|rd|th)$/.test(gradeCol.s)) semester = gradeCol.s;

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

  return { courses, sawText, semester };
}
