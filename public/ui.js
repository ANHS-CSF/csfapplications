// Wiring for the eligibility portal: auth, CSV intake, batch extraction, review.
import { parseCsv, toCsv, scoreApplicant, normalizeGrade, checkSubmission, statusFor, DEFAULT_SETTINGS } from './scoring.js';
import { extractCourses } from './extract.js';
import {
  REVIEW_REASONS, REASON_LABEL, reasonsFor, needsReview, notesFor,
  RETURNING, classifyReturning, wasMember, isTransfer,
} from './review.js';
import { TEMPLATE_VARS, renderMessage } from './email.js';

const $ = sel => document.querySelector(sel);
const CATEGORIES = ['AP', 'Honors', 'Regular', 'Inapplicable'];
const CONCURRENCY = 4;
const normalize = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

const state = {
  rows: [],          // raw CSV rows (no header)
  headers: [],
  mapping: {},
  applicants: [],    // scored results
  rules: new Map(),  // normalized course name -> { display, value }
  settings: { ...DEFAULT_SETTINGS },
  shown: [],         // applicants the table is currently displaying
  templates: [],     // saved message templates
  gmail: { configured: false, connected: false, email: null },
  contacted: new Set(),  // lowercased addresses already in the send log
  picks: new Map(),      // applicant index -> included in this send
};

/* ------------------------------------------------------------- session --- */

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  const type = res.headers.get('Content-Type') || '';
  const body = type.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#login-error');
  err.classList.add('hidden');
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#pw').value }),
    });
    await enterApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hidden');
    $('#pw').select();
  }
});

$('#signout').addEventListener('click', async () => {
  await api('/api/login', { method: 'DELETE' }).catch(() => {});
  location.reload();
});

async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  await Promise.all([loadRules(), loadSettings()]);
  // Email setup is not needed to score anyone, so a failure here (no Gmail
  // client configured yet, say) must not keep the portal from opening.
  await Promise.all([loadGmail(), loadTemplates(), loadLog()]).catch(() => {});
  reportOauthOutcome();
}

(async function boot() {
  try {
    const { ok } = await api('/api/login');
    if (ok) await enterApp();
  } catch { /* stay on the login screen */ }
})();

/* --------------------------------------------------------------- tabs --- */

document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b =>
      b.setAttribute('aria-selected', String(b === btn)));
    for (const name of ['applicants', 'rules', 'settings']) {
      $(`#tab-${name}`).classList.toggle('hidden', name !== btn.dataset.tab);
    }
  });
});

$('#strict-df').addEventListener('change', e => {
  saveSettings({ dfAnywhereDisqualifies: e.target.checked })
    .catch(err => { alert(err.message); e.target.checked = !e.target.checked; });
});

/* ----------------------------------------------------------- settings --- */

async function loadSettings() {
  const { settings } = await api('/api/settings');
  state.settings = settings;
  renderSettings();
}

async function saveSettings(patch) {
  const next = { ...state.settings, ...patch };
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: patch }),
  });
  state.settings = next;
  renderSettings();
  rescoreAll();
}

function renderSettings() {
  const { allowedSchools, requiredTerm, dfAnywhereDisqualifies } = state.settings;
  $('#strict-df').checked = !!dfAnywhereDisqualifies;
  $('#schools').value = (allowedSchools || []).join('\n');
  $('#term-season').value = requiredTerm?.term ?? 'Spring';
  $('#term-year').value = requiredTerm?.year ?? new Date().getFullYear();
  $('#term-echo').textContent =
    `Cards must be from ${requiredTerm?.term} ${requiredTerm?.year} — ` +
    `the ${requiredTerm?.term === 'Fall' ? '1st' : '2nd'} semester grade report.`;
}

$('#save-schools').addEventListener('click', async () => {
  const list = $('#schools').value.split('\n').map(s2 => s2.trim()).filter(Boolean);
  const msg = $('#schools-msg');
  try {
    await saveSettings({ allowedSchools: list });
    msg.textContent = `Saved ${list.length} school(s).`;
  } catch (e) { msg.textContent = e.message; }
});

$('#save-term').addEventListener('click', async () => {
  const msg = $('#term-msg');
  try {
    await saveSettings({
      requiredTerm: { term: $('#term-season').value, year: Number($('#term-year').value) },
    });
    msg.textContent = 'Saved.';
  } catch (e) { msg.textContent = e.message; }
});

/* -------------------------------------------------------- course rules --- */

async function loadRules() {
  const { courses } = await api('/api/courses');
  state.rules = new Map(courses.map(c => [c.name, { display: c.display, value: c.value }]));
  renderRules();
}

function categoryOf(courseName) {
  return state.rules.get(normalize(courseName))?.value ?? 'Regular';
}
function isKnown(courseName) {
  return state.rules.has(normalize(courseName));
}

async function saveRules(courses) {
  await api('/api/courses', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courses }),
  });
  for (const c of courses) state.rules.set(normalize(c.display), { display: c.display, value: c.value });
}

function renderRules() {
  const q = normalize($('#rules-search').value || '');
  const all = [...state.rules.entries()].sort((a, b) => a[1].display.localeCompare(b[1].display));
  const shown = q ? all.filter(([k]) => k.includes(q)) : all;
  $('#rules-count').textContent = `${all.length} courses`;

  const tbody = $('#rules-rows');
  tbody.textContent = '';
  for (const [key, { display, value }] of shown) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = display;
    tr.append(tdName);

    const tdCat = document.createElement('td');
    tdCat.append(categorySelect(value, async next => {
      await saveRules([{ display, value: next }]);
      rescoreAll();
    }));
    tr.append(tdCat);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'sm'; del.textContent = 'Remove';
    del.onclick = async () => {
      await api(`/api/courses?name=${encodeURIComponent(display)}`, { method: 'DELETE' });
      state.rules.delete(key);
      renderRules(); rescoreAll();
    };
    tdDel.append(del);
    tr.append(tdDel);

    tbody.append(tr);
  }
}

// `value` of null means the course has no rule yet: a placeholder sits in front
// of the categories so that picking "Regular" — which is what an unlisted course
// already scores as — still fires a change and writes the rule.
function categorySelect(value, onChange, placeholder) {
  const sel = document.createElement('select');
  sel.className = 'sm';
  if (placeholder) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = placeholder; o.selected = value == null;
    sel.append(o);
  }
  for (const c of CATEGORIES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c; o.selected = value != null && c === value;
    sel.append(o);
  }
  sel.onchange = () => { if (sel.value) onChange(sel.value); };
  sel.onclick = e => e.stopPropagation();
  return sel;
}

$('#rules-search').addEventListener('input', renderRules);

$('#bulk-save').addEventListener('click', async () => {
  const msg = $('#bulk-msg');
  const parsed = [];
  const bad = [];
  for (const line of $('#bulk').value.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.lastIndexOf(',');
    const display = (idx < 0 ? line : line.slice(0, idx)).trim();
    const value = (idx < 0 ? '' : line.slice(idx + 1)).trim();
    const match = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
    if (!display || !match) { bad.push(line.trim()); continue; }
    parsed.push({ display, value: match });
  }
  if (bad.length) {
    msg.textContent = `Couldn't read ${bad.length} line(s): ${bad.slice(0, 2).join(' / ')}`;
    return;
  }
  if (!parsed.length) { msg.textContent = 'Nothing to save.'; return; }
  await saveRules(parsed);
  $('#bulk').value = '';
  msg.textContent = `Saved ${parsed.length} course(s).`;
  renderRules(); rescoreAll();
});

/* ---------------------------------------------------------- csv intake --- */

const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  const file = e.dataTransfer?.files?.[0];
  if (file) readCsvFile(file);
});
$('#file').addEventListener('change', e => {
  if (e.target.files[0]) readCsvFile(e.target.files[0]);
});

async function readCsvFile(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) { alert('That CSV has no data rows.'); return; }
  state.headers = rows[0];
  state.rows = rows.slice(1);
  buildMapper();
}

// Guess which columns hold what. Link columns are found by looking at the data
// rather than the header text, which is what makes this survive a reworded form.
function guessMapping() {
  const H = state.headers.map(h => h.toLowerCase());
  const findHeader = (...res) => H.findIndex(h => res.some(re => re.test(h)));

  const linkCols = state.headers.map((_, i) => i).filter(i =>
    state.rows.filter(r => /drive\.google\.com|docs\.google\.com/.test(r[i] || '')).length >= 2);

  // Two email columns, and they are not interchangeable: the district school
  // accounts have no inbox, so the personal address is the one mail goes to.
  const emailCols = H.map((h, i) => [h, i]).filter(([h]) => /e-?mail/.test(h)).map(([, i]) => i);
  const schoolEmail = findHeader(/school e-?mail/, /district e-?mail/);
  const personalEmail = (() => {
    const named = findHeader(/personal e-?mail/, /private e-?mail/, /non-?school e-?mail/);
    if (named > -1) return named;
    // A form with only one email column means that column is the usable one,
    // whatever it is called.
    return emailCols.find(i => i !== schoolEmail) ?? -1;
  })();

  return {
    name: findHeader(/enter your name/, /full name/, /^name/),
    id: findHeader(/id number/, /student id/),
    emailPersonal: personalEmail,
    emailSchool: schoolEmail,
    csf: findHeader(/csf last year/, /in csf/, /member last year/, /last year/),
    level: findHeader(/what grade are you in/, /grade level/),
    card: linkCols[0] ?? -1,
    card2: linkCols[1] ?? -1,
  };
}

function buildMapper() {
  state.mapping = guessMapping();
  const fields = [
    ['name', 'Applicant name'],
    ['id', 'Student ID'],
    ['emailPersonal', 'Personal email (mail goes here)'],
    ['emailSchool', 'School email (optional)'],
    ['level', 'Grade level'],
    ['csf', 'In CSF last year (optional)'],
    ['card', 'Report card link'],
    ['card2', 'Second report card (optional)'],
  ];

  const host = $('#map-fields');
  host.textContent = '';
  for (const [key, label] of fields) {
    const wrap = document.createElement('div');
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.style.cssText = 'display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px';
    const sel = document.createElement('select');
    sel.style.maxWidth = '210px';

    const none = document.createElement('option');
    none.value = '-1'; none.textContent = '— none —';
    sel.append(none);
    state.headers.forEach((h, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = h.replace(/\s+/g, ' ').slice(0, 60) || `Column ${i + 1}`;
      o.selected = state.mapping[key] === i;
      sel.append(o);
    });
    sel.onchange = () => { state.mapping[key] = Number(sel.value); };
    wrap.append(lab, sel);
    host.append(wrap);
  }

  $('#map-summary').textContent = `${state.rows.length} applicants loaded`;
  $('#mapping').classList.remove('hidden');
  // Both are warnings, not blockers: scoring works without an email column, it
  // just means nobody can be emailed afterwards.
  const hints = [];
  if (state.mapping.card < 0) hints.push('No report card column detected — pick one above.');
  if (state.mapping.emailPersonal < 0) hints.push('No personal email column detected — you can score, but not email.');
  $('#run-hint').textContent = hints.join(' ');
}

/* ------------------------------------------------------- batch process --- */

$('#run').addEventListener('click', run);

async function run() {
  const m = state.mapping;
  if (m.card < 0) { alert('Choose the report card link column first.'); return; }

  $('#run').disabled = true;
  $('#progress').classList.remove('hidden');
  $('#results').classList.add('hidden');

  const cell = (row, i) => (i >= 0 ? (row[i] || '').trim() : '');
  const queue = state.rows.map((row, i) => ({
    index: i,
    name: cell(row, m.name) || `Row ${i + 2}`,
    studentId: cell(row, m.id),
    personalEmail: cell(row, m.emailPersonal),
    schoolEmail: cell(row, m.emailSchool),
    // The address mail is actually sent to. Kept as its own field so the send
    // path, the log and the contacted set all read one place.
    email: cell(row, m.emailPersonal),
    returningRaw: cell(row, m.csf),
    level: cell(row, m.level),
    links: [cell(row, m.card), cell(row, m.card2)].filter(Boolean),
  }));

  const results = new Array(queue.length);
  let done = 0;
  const tick = () => {
    const pct = Math.round((++done / queue.length) * 100);
    $('#prog-bar').style.width = pct + '%';
    $('#prog-text').textContent = `${done} of ${queue.length}`;
  };

  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      results[job.index] = await processApplicant(job);
      tick();
    }
  }));

  state.applicants = results;
  $('#progress').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#run').disabled = false;
  rescoreAll();
}

async function processApplicant(job) {
  const courses = [];
  const problems = [];
  const schools = [], terms = [];

  for (const link of job.links) {
    try {
      const res = await fetch(`/api/pdf?url=${encodeURIComponent(link)}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        problems.push({ code: 'download', text: body.error || `Download failed (${res.status})` });
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out = await extractCourses(bytes);
      if (out.school) schools.push(out.school);
      if (out.term) terms.push(out.term);

      if (!out.courses.length) {
        // Two very different failures that used to read as one. The distinction
        // matters: a wrong document needs a different email than a screenshot.
        problems.push(out.sawText
          ? { code: 'no-grade-table', text: 'No Aeries grade table found — wrong document?' }
          : { code: 'no-text', text: 'PDF has no readable text (a screenshot?) — enter grades by hand' });
      }
      courses.push(...out.courses);
    } catch (e) {
      problems.push({ code: 'read-error', text: e.message || 'Could not read this PDF' });
    }
  }

  return { ...job, courses, problems, schools, terms, open: false };
}

/* -------------------------------------------------------------- render --- */

function rescoreAll() {
  for (const a of state.applicants) {
    if (!a) continue;
    a.scored = a.courses.map(c => ({ ...c, category: categoryOf(c.name) }));
    a.result = scoreApplicant(a.scored, {
      dfAnywhereDisqualifies: !!state.settings.dfAnywhereDisqualifies,
    });
    a.unknown = a.courses.filter(c => !isKnown(c.name)).map(c => c.name);
    a.check = checkSubmission({ schools: a.schools, terms: a.terms }, state.settings);
    a.returning = classifyReturning(a.returningRaw);
  }
  renderResults();
}

// One status decision, used by both the table and the export, so they cannot
// disagree. The rule itself lives in scoring.js where it is unit-tested; the
// review taxonomy (needsReview, reasonsFor, notesFor) lives in review.js.
const statusOf = a => statusFor(a);

function renderResults() {
  const q = ($('#search').value || '').toLowerCase();
  const mode = $('#filter').value;
  const all = state.applicants.filter(Boolean);

  const qualified = all.filter(a => statusOf(a) === 'QUALIFIED').length;
  const rejected = all.filter(a => statusOf(a) === 'NOT QUALIFIED').length;
  const flagged = all.filter(needsReview).length;
  $('#stats').textContent = '';
  for (const [label, val] of [
    ['Applicants', all.length], ['Qualified', qualified],
    ['Not qualified', rejected], ['Needs review', flagged],
  ]) {
    const d = document.createElement('div');
    d.className = 'stat';
    const b = document.createElement('b'); b.textContent = val;
    const s = document.createElement('span'); s.textContent = label;
    d.append(b, s); $('#stats').append(d);
  }

  const note = $('#review-note');
  note.classList.toggle('hidden', flagged === 0);
  if (flagged) {
    note.textContent = `${flagged} applicant(s) need a look — an unreadable card, the wrong semester, an unrecognized school, or a course that isn't in the course rules. Filter to "Needs review only" to work through them.`;
  }

  const reason = renderReasonFilter(all, mode);

  const shown = all.filter(a => {
    if (q && !a.name.toLowerCase().includes(q)) return false;
    if (mode === 'qualified') return statusOf(a) === 'QUALIFIED';
    if (mode === 'not') return statusOf(a) === 'NOT QUALIFIED';
    if (mode === 'flagged') {
      if (!needsReview(a)) return false;
      return reason === 'any' || reasonsFor(a).has(reason);
    }
    return true;
  });

  // Remembered so the compose panel can offer "just what's in the table".
  state.shown = shown;

  const tbody = $('#rows');
  tbody.textContent = '';
  for (const a of shown) {
    tbody.append(applicantRow(a));
    if (a.open) tbody.append(detailRow(a));
  }
}

function applicantRow(a) {
  const tr = document.createElement('tr');
  tr.className = 'app-row';
  tr.onclick = () => { a.open = !a.open; renderResults(); };

  const cells = [];
  const push = (content, cls, align) => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (align) td.style.textAlign = align;
    if (content instanceof Node) td.append(content); else td.textContent = content;
    cells.push(td);
  };

  push(a.open ? '▾' : '▸', 'muted');
  push(a.name);
  push(a.studentId, 'mono muted');
  push(a.level, 'muted');
  const status = statusOf(a);
  // Points are withheld for anything needing review: a wrong-term card has real
  // points, but they answer the wrong semester's question and must not be shown
  // as though they were this semester's result.
  push(status === 'NEEDS REVIEW' ? '—' : String(a.result.total), 'pts', 'right');

  const pill = document.createElement('span');
  pill.className = 'pill ' + (status === 'QUALIFIED' ? 'ok' : status === 'NOT QUALIFIED' ? 'no' : 'warn');
  pill.textContent = status;
  push(pill);

  const notes = notesFor(a);
  if (wasEmailed(a)) {
    const cell = document.createElement('span');
    const sent = document.createElement('span');
    sent.className = 'pill ok';
    sent.textContent = 'Emailed';
    cell.append(sent);
    if (notes.length) {
      const rest = document.createElement('span');
      rest.className = 'muted';
      rest.textContent = ' ' + notes.join(' · ');
      cell.append(rest);
    }
    push(cell);
  } else {
    push(notes.join(' · '), 'muted');
  }

  const link = document.createElement('a');
  link.href = a.links[0] || '#'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = 'Open';
  link.onclick = e => e.stopPropagation();
  push(a.links[0] ? link : '—');

  tr.append(...cells);
  return tr;
}

function detailRow(a) {
  const tr = document.createElement('tr');
  tr.className = 'detail';
  const td = document.createElement('td');
  td.colSpan = 8;

  const counted = new Set(a.result?.chosen ?? []);
  const table = document.createElement('table');
  table.className = 'courses';
  table.innerHTML =
    '<thead><tr><th>Course</th><th style="width:90px">Grade</th>' +
    '<th style="width:170px">Category</th><th style="width:90px">Points</th>' +
    '<th style="width:110px">Counted</th><th style="width:70px"></th></tr></thead>';
  const tb = document.createElement('tbody');

  a.scored?.forEach((course, i) => {
    const row = document.createElement('tr');
    const used = [...counted].some(c => c.name === course.name && c.grade === course.grade);
    row.className = course.category === 'Inapplicable' ? 'excluded' : (used ? 'counted' : '');

    const tdName = document.createElement('td');
    tdName.textContent = course.name;
    if (!isKnown(course.name)) {
      const tag = document.createElement('span');
      tag.className = 'pill warn'; tag.style.marginLeft = '8px'; tag.textContent = 'not in rules';
      tdName.append(tag);
    }
    row.append(tdName);

    const tdGrade = document.createElement('td');
    const gsel = document.createElement('select');
    gsel.className = 'sm';
    for (const g of ['A', 'B', 'C', 'D', 'F']) {
      const o = document.createElement('option');
      o.value = g; o.textContent = g; o.selected = g === course.grade;
      gsel.append(o);
    }
    gsel.onchange = () => { a.courses[i].grade = gsel.value; rescoreAll(); };
    tdGrade.append(gsel);
    row.append(tdGrade);

    const tdCat = document.createElement('td');
    const known = isKnown(course.name);
    tdCat.append(categorySelect(known ? course.category : null, async next => {
      await saveRules([{ display: course.name, value: next }]);
      renderRules(); rescoreAll();
    }, known ? null : '— add to rules as… —'));
    row.append(tdCat);

    const tdPts = document.createElement('td');
    tdPts.className = 'pts';
    tdPts.textContent = course.category === 'Inapplicable' ? '—' : String({ A: 3, B: 1, C: 0 }[course.grade] ?? 0);
    row.append(tdPts);

    const tdUsed = document.createElement('td');
    tdUsed.className = 'muted';
    tdUsed.textContent = course.category === 'Inapplicable' ? 'excluded' : (used ? 'yes' : 'no');
    row.append(tdUsed);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'sm'; del.textContent = 'Delete';
    del.onclick = () => { a.courses.splice(i, 1); rescoreAll(); };
    tdDel.append(del);
    row.append(tdDel);

    tb.append(row);
  });
  table.append(tb);

  const summary = document.createElement('p');
  summary.className = 'muted';
  summary.style.marginBottom = '10px';
  if (a.check?.termOk === false) {
    summary.textContent =
      `${a.check.termReason}. Ask the applicant to resubmit — the grades below are ` +
      `from the wrong term and do not count.`;
  } else if (a.result && !a.result.flags?.includes('no-courses')) {
    summary.textContent = a.result.reason
      ? a.result.reason
      : `${a.result.base} points from grades + ${a.result.bonus} AP/Honors bonus = ${a.result.total}. Needs 10.`;
  } else {
    summary.textContent = 'No courses were read from this report card. Add them by hand below.';
  }

  const add = document.createElement('button');
  add.className = 'sm';
  add.textContent = 'Add a course';
  add.onclick = () => {
    const name = prompt('Course name (as printed on the report card):');
    if (!name?.trim()) return;
    const grade = normalizeGrade(prompt('Letter grade (A, B, C, D or F):') || '');
    if (!grade) { alert('That is not a letter grade.'); return; }
    a.courses.push({ name: name.trim(), grade, raw: grade });
    rescoreAll();
  };

  if (a.problems.length) {
    const warn = document.createElement('p');
    warn.className = 'note';
    warn.style.marginBottom = '10px';
    warn.textContent = a.problems.map(p => p.text).join(' · ');
    td.append(warn);
  }
  td.append(summary, table, add);
  tr.append(td);
  return tr;
}

// Second-level filter, only meaningful inside the review pile. Rebuilt on every
// render so the counts follow the data, and so a reason that no longer applies
// (the last unlisted course got classified) cannot leave the table empty.
function renderReasonFilter(all, mode) {
  const sel = $('#reason');
  sel.classList.toggle('hidden', mode !== 'flagged');
  if (mode !== 'flagged') return 'any';

  const flagged = all.filter(needsReview);
  const counts = new Map(REVIEW_REASONS.map(([key]) => [key, 0]));
  for (const a of flagged) {
    for (const key of reasonsFor(a)) counts.set(key, counts.get(key) + 1);
  }

  const available = REVIEW_REASONS.filter(([key]) => counts.get(key) > 0);
  const wanted = available.some(([key]) => key === sel.value) ? sel.value : 'any';

  sel.textContent = '';
  const any = document.createElement('option');
  any.value = 'any'; any.textContent = `Any reason (${flagged.length})`;
  any.selected = wanted === 'any';
  sel.append(any);
  for (const [key, label] of available) {
    const o = document.createElement('option');
    o.value = key; o.textContent = `${label} (${counts.get(key)})`;
    o.selected = key === wanted;
    sel.append(o);
  }
  sel.value = wanted;
  return wanted;
}

$('#search').addEventListener('input', renderResults);
$('#filter').addEventListener('change', renderResults);
$('#reason').addEventListener('change', renderResults);

/* --------------------------------------------------------------- email --- */

const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());
const wasEmailed = a => !!a.emailed || state.contacted.has(String(a.email ?? '').trim().toLowerCase());

// Gmail's own per-user limits are generous, but a Worker request may only make
// 50 subrequests on the free plan and each send is one, so a batch is split
// across several calls. 20 leaves headroom for the token refresh.
const CHUNK = 20;

async function loadGmail() {
  try {
    state.gmail = await api('/api/gmail');
  } catch {
    state.gmail = { configured: false, connected: false, email: null };
  }
  renderGmail();
}

async function loadTemplates() {
  const { templates } = await api('/api/templates');
  state.templates = templates;
  renderTemplateList();
}

async function loadLog() {
  const { log } = await api('/api/gmail/log?limit=200');
  state.contacted = new Set(
    log.filter(r => r.status === 'sent').map(r => String(r.email).trim().toLowerCase())
  );
  renderLog(log);
}

function renderGmail() {
  const { configured, connected, email } = state.gmail;
  const status = $('#gmail-status');
  const note = $('#gmail-note');

  $('#gmail-connect').classList.toggle('hidden', connected);
  $('#gmail-connect').disabled = !configured;
  $('#gmail-disconnect').classList.toggle('hidden', !connected);

  status.textContent = !configured ? 'Not set up'
    : connected ? `Connected as ${email || 'unknown account'}` : 'Not connected';

  note.classList.toggle('hidden', configured);
  if (!configured) {
    note.textContent =
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on this deployment. ' +
      'Add them with `wrangler pages secret put` before connecting an account.';
  }
}

function renderLog(log) {
  const tbody = $('#log-rows');
  tbody.textContent = '';
  $('#log-empty').classList.toggle('hidden', log.length > 0);

  for (const r of log) {
    const tr = document.createElement('tr');
    for (const [text, cls] of [
      [new Date(r.sent_at).toLocaleString(), 'muted'],
      [r.name || '', ''],
      [r.email, 'mono muted'],
      [r.subject || '', 'muted'],
    ]) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      tr.append(td);
    }
    const td = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill ' + (r.status === 'sent' ? 'ok' : 'no');
    pill.textContent = r.status === 'sent' ? 'Sent' : 'Failed';
    pill.title = r.error || '';
    td.append(pill);
    tr.append(td);
    tbody.append(tr);
  }
}

$('#log-refresh').addEventListener('click', () => {
  loadLog().then(renderResults).catch(e => alert(e.message));
});

$('#gmail-connect').addEventListener('click', () => {
  // A plain navigation rather than fetch: the session cookie is SameSite=Strict,
  // which a same-site top-level navigation still carries, and Google's consent
  // screen has to be driven by the browser anyway.
  location.href = '/api/gmail/connect';
});

$('#gmail-disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect Gmail? You will have to authorize the account again to send.')) return;
  try {
    await api('/api/gmail', { method: 'DELETE' });
    await loadGmail();
  } catch (e) { alert(e.message); }
});

// The OAuth callback can only talk back through the URL, so translate its
// verdict once and then scrub it — a stale ?gmail=error surviving a refresh
// would look like a fresh failure.
function reportOauthOutcome() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('gmail');
  if (!outcome) return;

  const detail = params.get('detail');
  const messages = {
    connected: null,
    denied: 'Gmail was not connected: the authorization was declined.',
    state: 'Gmail was not connected: that sign-in did not match this session. Try again.',
    error: `Gmail was not connected. ${detail || ''}`.trim(),
  };
  const message = messages[outcome] ?? null;
  if (message) alert(message);
  history.replaceState(null, '', location.pathname);
}

/* ------------------------------------------------------ compose: audience --- */

// Each entry is [key, label, predicate]. Reason buckets come straight from the
// review taxonomy, so a new reason shows up here without any extra wiring.
function audiences() {
  const inShown = new Set(state.shown);
  return [
    ['review', 'Everyone needing review', needsReview],
    ...REVIEW_REASONS.map(([key, label]) =>
      [`reason:${key}`, `Needs review · ${label}`, a => needsReview(a) && reasonsFor(a).has(key)]),
    ['qualified', 'Qualified applicants', a => statusOf(a) === 'QUALIFIED'],
    ['not', 'Not qualified applicants', a => statusOf(a) === 'NOT QUALIFIED'],
    // Only ever non-empty once the "in CSF last year" column is mapped, and
    // renderAudiences drops empty buckets, so these disappear on a form that
    // never asked.
    ['returning', 'Returning members (any school)', a => wasMember(a.returning)],
    ['new-member', 'New applicants', a => a.returning === 'no' || a.returning === 'transfer-new'],
    ['transfer', 'Transfers from another school', a => isTransfer(a.returning)],
    ['shown', "Whatever the table is showing right now", a => inShown.has(a)],
    ['all', 'Everyone in the CSV', () => true],
  ];
}

const audienceFor = key => audiences().find(([k]) => k === key);

function renderAudiences() {
  const sel = $('#email-audience');
  const all = state.applicants.filter(Boolean);
  const list = audiences();

  // A bucket nobody is in would only produce an empty recipient list, so it is
  // dropped — the same reason the table's reason filter drops empty reasons.
  const usable = list.filter(([key, , match]) =>
    key === 'shown' || key === 'all' || all.some(match));

  const wanted = usable.some(([k]) => k === sel.value) ? sel.value : (usable[0]?.[0] ?? 'all');
  sel.textContent = '';
  for (const [key, label, match] of usable) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${label} (${all.filter(match).length})`;
    sel.append(o);
  }
  sel.value = wanted;
  return wanted;
}

function recipients() {
  const entry = audienceFor($('#email-audience').value);
  const match = entry?.[2] ?? (() => false);
  return state.applicants.filter(Boolean).filter(match);
}

/* ------------------------------------------------------ compose: panel --- */

$('#compose').addEventListener('click', openCompose);
$('#email-close').addEventListener('click', () => $('#email-panel').classList.add('hidden'));
$('#email-panel').addEventListener('click', e => {
  if (e.target === $('#email-panel')) $('#email-panel').classList.add('hidden');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $('#email-panel').classList.add('hidden');
});

function openCompose() {
  if (!state.applicants.filter(Boolean).length) {
    alert('Run a batch first — there is nobody to email yet.');
    return;
  }
  $('#email-panel').classList.remove('hidden');
  $('#email-result').classList.add('hidden');
  $('#email-retry').classList.add('hidden');
  $('#email-bar-wrap').classList.add('hidden');

  renderVarChips();
  renderAudiences();
  if (!$('#email-subject').value && !$('#email-body').value) applyTemplate($('#email-template').value);
  resetPicks();
  renderCompose();
}

function renderVarChips() {
  const box = $('#email-vars');
  if (box.childElementCount) return;
  for (const [key, help] of TEMPLATE_VARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `{${key}}`;
    b.title = help;
    b.onclick = () => insertVar(`{${key}}`);
    box.append(b);
  }
}

// Inserts at the caret in whichever of the two fields was last focused, so the
// chips work for the subject as well as the body.
let lastField = null;
for (const id of ['#email-subject', '#email-body']) {
  $(id).addEventListener('focus', e => { lastField = e.target; });
  $(id).addEventListener('input', renderCompose);
}

function insertVar(token) {
  const el = lastField ?? $('#email-body');
  const at = el.selectionStart ?? el.value.length;
  const to = el.selectionEnd ?? at;
  el.value = el.value.slice(0, at) + token + el.value.slice(to);
  el.focus();
  el.selectionStart = el.selectionEnd = at + token.length;
  renderCompose();
}

/* --------------------------------------------------- compose: templates --- */

function renderTemplateList() {
  const sel = $('#email-template');
  const keep = sel.value;
  sel.textContent = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = state.templates.length ? '— pick a template —' : '— no saved templates —';
  sel.append(blank);

  for (const t of state.templates) {
    const o = document.createElement('option');
    o.value = t.name;
    o.textContent = t.name;
    sel.append(o);
  }
  sel.value = state.templates.some(t => t.name === keep) ? keep : '';
}

function applyTemplate(name) {
  const t = state.templates.find(x => x.name === name);
  if (!t) return;
  $('#email-subject').value = t.subject;
  $('#email-body').value = t.body;
  renderCompose();
}

$('#email-template').addEventListener('change', e => applyTemplate(e.target.value));

async function saveTemplate(name) {
  if (!name) return;
  try {
    await api('/api/templates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: { name, subject: $('#email-subject').value, body: $('#email-body').value },
      }),
    });
    await loadTemplates();
    $('#email-template').value = name;
  } catch (e) { alert(e.message); }
}

$('#email-save').addEventListener('click', () => {
  const current = $('#email-template').value;
  saveTemplate(current || prompt('Name this template:', '')?.trim());
});

$('#email-save-as').addEventListener('click', () => {
  saveTemplate(prompt('Name for the new template:', '')?.trim());
});

$('#email-delete').addEventListener('click', async () => {
  const name = $('#email-template').value;
  if (!name) { alert('Pick a saved template first.'); return; }
  if (!confirm(`Delete the "${name}" template?`)) return;
  try {
    await api(`/api/templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadTemplates();
  } catch (e) { alert(e.message); }
});

/* -------------------------------------------------- compose: recipients --- */

// Anyone without a usable address, or already contacted, starts unchecked. Both
// stay visible and re-checkable: the reviewer, not the app, decides who is a
// duplicate.
function resetPicks() {
  state.picks = new Map();
  for (const a of recipients()) {
    state.picks.set(a.index, validEmail(a.email) && !wasEmailed(a));
  }
}

$('#email-audience').addEventListener('change', () => { resetPicks(); renderCompose(); });
$('#email-all').addEventListener('click', () => {
  for (const a of recipients()) if (validEmail(a.email)) state.picks.set(a.index, true);
  renderCompose();
});
$('#email-none').addEventListener('click', () => {
  for (const key of state.picks.keys()) state.picks.set(key, false);
  renderCompose();
});

const chosen = () => recipients().filter(a => state.picks.get(a.index) && validEmail(a.email));

function renderCompose() {
  renderPicks();
  renderSummary();
}

function renderPicks() {
  const list = recipients();
  const picks = $('#email-picks');
  picks.textContent = '';

  for (const a of list) {
    const row = document.createElement('label');
    row.className = 'pick';

    const box = document.createElement('input');
    box.type = 'checkbox';
    const usable = validEmail(a.email);
    box.checked = usable && !!state.picks.get(a.index);
    box.disabled = !usable;
    // Only the counts and the preview depend on this, so the list itself is
    // left alone — rebuilding it would drop focus mid-way through tabbing
    // down a long list of checkboxes.
    box.onchange = () => { state.picks.set(a.index, box.checked); renderSummary(); };

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = a.name;

    const addr = document.createElement('span');
    addr.className = 'mono muted';
    // Says "personal" explicitly: the school address is no help here, so an
    // applicant with one and no personal address still needs chasing.
    addr.textContent = usable ? a.email
      : a.email ? `${a.email} — not an address`
      : a.schoolEmail ? 'no personal email — only a school address'
      : 'no email in the CSV';

    const why = document.createElement('span');
    why.className = 'why';
    const labels = [...reasonsFor(a)].map(k => REASON_LABEL.get(k) ?? k);
    if (wasEmailed(a)) labels.unshift('already emailed');
    why.textContent = labels.join(' · ');

    if (!usable) row.classList.add('off');
    row.append(box, who, addr, why);
    picks.append(row);
  }
}

function renderSummary() {
  const list = recipients();
  const picked = chosen();
  const skipped = list.length - picked.length;
  $('#email-count').textContent =
    `${picked.length} of ${list.length} selected` + (skipped ? ` · ${skipped} skipped` : '');

  renderPreview(picked[0]);

  const ready = picked.length > 0
    && state.gmail.connected
    && !!$('#email-subject').value.trim()
    && !!$('#email-body').value.trim();
  $('#email-send').disabled = !ready;
  $('#email-send').textContent = picked.length
    ? `Send to ${picked.length} applicant${picked.length > 1 ? 's' : ''}`
    : 'Send';

  const warn = $('#email-gmail-warn');
  warn.classList.toggle('hidden', state.gmail.connected);
  if (!state.gmail.connected) {
    warn.textContent = state.gmail.configured
      ? 'No Gmail account is connected. Connect one on the Settings tab first.'
      : 'Gmail is not set up on this deployment yet — see the Gmail card on the Settings tab.';
  }
  $('#email-sender').textContent = state.gmail.connected ? `Sending as ${state.gmail.email}` : '';
}

function renderPreview(a) {
  const box = $('#email-preview');
  const unknownNote = $('#email-unknown');
  box.textContent = '';

  if (!a) {
    box.textContent = 'Nobody selected.';
    unknownNote.classList.add('hidden');
    $('#email-preview-who').textContent = '';
    return;
  }

  const { subject, body, unknown } = renderMessage(
    { subject: $('#email-subject').value, body: $('#email-body').value }, a, state.settings
  );

  $('#email-preview-who').textContent = `as ${a.name} will see it`;
  const subj = document.createElement('span');
  subj.className = 'subj';
  subj.textContent = subject || '(no subject)';
  box.append(subj, document.createTextNode(body));

  unknownNote.classList.toggle('hidden', !unknown.length);
  if (unknown.length) {
    unknownNote.textContent =
      `Not a variable, so it will be sent literally: ${unknown.map(u => `{${u}}`).join(', ')}. ` +
      'Check the spelling against the list above.';
  }
}

/* -------------------------------------------------------- compose: send --- */

$('#email-send').addEventListener('click', () => sendBatch(chosen()));
$('#email-retry').addEventListener('click', e => sendBatch(e.target._failed ?? []));

async function sendBatch(list) {
  if (!list.length) return;

  const audience = $('#email-audience').selectedOptions[0]?.textContent ?? '';
  const template = $('#email-template').value;
  const subject = $('#email-subject').value;
  const body = $('#email-body').value;

  if (!confirm(`Send this message to ${list.length} applicant(s)? This cannot be undone.`)) return;

  const send = $('#email-send');
  send.disabled = true;
  $('#email-retry').classList.add('hidden');
  $('#email-bar-wrap').classList.remove('hidden');
  $('#email-bar').style.width = '0%';

  const byEmail = new Map(list.map(a => [String(a.email).trim().toLowerCase(), a]));
  const messages = list.map(a => {
    const rendered = renderMessage({ subject, body }, a, state.settings);
    return {
      email: String(a.email).trim(),
      name: a.name,
      studentId: a.studentId,
      subject: rendered.subject,
      body: rendered.body,
    };
  });

  const failures = [];
  let sent = 0, stopped = null;

  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK);
    let out;
    try {
      out = await api('/api/gmail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience, template, messages: slice }),
      });
    } catch (e) {
      // The whole chunk is unaccounted for. Stop rather than press on: if the
      // token died, every later chunk fails the same way.
      stopped = e.message;
      for (const m of slice) failures.push({ email: m.email, error: e.message });
      break;
    }

    for (const r of out.results) {
      const a = byEmail.get(String(r.email).trim().toLowerCase());
      if (r.ok) {
        sent++;
        state.contacted.add(String(r.email).trim().toLowerCase());
        if (a) a.emailed = true;
      } else {
        failures.push({ email: r.email, error: r.error });
      }
    }

    $('#email-bar').style.width =
      Math.round(Math.min(i + CHUNK, messages.length) / messages.length * 100) + '%';

    if (out.reconnect) {
      stopped = 'Gmail needs reconnecting — the rest of the batch was not attempted.';
      break;
    }
  }

  send.disabled = false;
  renderResults();
  renderCompose();

  const result = $('#email-result');
  result.classList.remove('hidden');
  result.className = failures.length ? 'note' : 'ok-note';
  result.textContent = [
    `${sent} sent`,
    failures.length ? `${failures.length} failed` : '',
    stopped || '',
  ].filter(Boolean).join(' · ');

  if (failures.length) {
    result.textContent += '\n' + failures.map(f => `${f.email}: ${f.error}`).join('\n');
    result.style.whiteSpace = 'pre-wrap';
    const retry = $('#email-retry');
    const stillThere = new Set(failures.map(f => String(f.email).trim().toLowerCase()));
    retry._failed = list.filter(a => stillThere.has(String(a.email).trim().toLowerCase()));
    retry.classList.remove('hidden');
  }

  // The server wrote log rows for every attempt; pull them so the Settings tab
  // and the "already emailed" marks agree with what just happened.
  loadLog().catch(() => {});
  if (state.gmail.connected && stopped) loadGmail().catch(() => {});
}

/* -------------------------------------------------------------- export --- */

$('#export').addEventListener('click', () => {
  const rows = [[
    'Name', 'Student ID', 'Personal email', 'School email', 'Grade level',
    'In CSF last year', 'Points', 'Status',
    'School', 'Term', 'Courses counted', 'All courses', 'Notes', 'Report card',
  ]];
  for (const a of state.applicants.filter(Boolean)) {
    rows.push([
      a.name, a.studentId, a.personalEmail ?? '', a.schoolEmail ?? '', a.level,
      a.returningRaw ?? '',
      statusOf(a) === 'NEEDS REVIEW' ? '' : (a.result?.total ?? ''),
      statusOf(a),
      (a.schools ?? []).join(' + '),
      (a.terms ?? []).map(t => t.label).join(' + '),
      (a.result?.chosen ?? []).map(c => `${c.name} ${c.grade}`).join('; '),
      (a.scored ?? []).map(c => `${c.name} ${c.grade} (${c.category})`).join('; '),
      notesFor(a).join('; '),
      a.links[0] || '',
    ]);
  }
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'csf-eligibility-results.csv';
  link.click();
  URL.revokeObjectURL(url);
});
