// Wiring for the eligibility portal: auth, CSV intake, batch extraction, review.
import { parseCsv, toCsv, scoreApplicant, normalizeGrade, checkSubmission, statusFor, DEFAULT_SETTINGS } from './scoring.js';
import { extractCourses } from './extract.js';

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

function categorySelect(value, onChange) {
  const sel = document.createElement('select');
  sel.className = 'sm';
  for (const c of CATEGORIES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c; o.selected = c === value;
    sel.append(o);
  }
  sel.onchange = () => onChange(sel.value);
  sel.onclick = e => e.stopPropagation();
  return sel;
}

$('#rules-search').addEventListener('input', renderRules);

$('#rules-add').addEventListener('click', async () => {
  const name = prompt('Course name, exactly as it appears on the report card:');
  if (!name?.trim()) return;
  await saveRules([{ display: name.trim(), value: 'Regular' }]);
  renderRules(); rescoreAll();
});

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

  return {
    name: findHeader(/enter your name/, /full name/, /^name/),
    id: findHeader(/id number/, /student id/),
    email: findHeader(/school email/, /email/),
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
    ['email', 'Email'],
    ['level', 'Grade level'],
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
  $('#run-hint').textContent = state.mapping.card < 0
    ? 'No report card column detected — pick one above.' : '';
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
    email: cell(row, m.email),
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
        problems.push(body.error || `Download failed (${res.status})`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out = await extractCourses(bytes);
      if (out.school) schools.push(out.school);
      if (out.term) terms.push(out.term);

      if (!out.courses.length) {
        problems.push(out.sawText
          ? 'No Aeries grade table found — wrong document?'
          : 'PDF has no readable text (a screenshot?) — enter grades by hand');
      }
      courses.push(...out.courses);
    } catch (e) {
      problems.push(e.message || 'Could not read this PDF');
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
  }
  renderResults();
}

function notesFor(a) {
  const notes = [...a.problems];
  if (a.check?.termReason) notes.push(a.check.termReason);
  if (a.check?.schoolReason) notes.push(a.check.schoolReason);
  if (a.unknown?.length) notes.push(`${a.unknown.length} unlisted course${a.unknown.length > 1 ? 's' : ''}`);
  if (a.links.length > 1) notes.push('two cards merged');
  if (/fresh/i.test(a.level)) notes.push('freshman — cannot apply');
  if (a.result?.reason) notes.push(a.result.reason);
  if (a.result?.flags?.length) notes.push(...a.result.flags.filter(f => f !== 'D/F' && f !== 'no-courses'));
  return notes;
}

// One status decision, used by both the table and the export, so they cannot
// disagree. The rule itself lives in scoring.js where it is unit-tested.
const statusOf = a => statusFor(a);

// Wants a human's attention, which is broader than the status: an applicant can
// be comfortably QUALIFIED and still have an unlisted course worth classifying.
const needsReview = a =>
  a.problems.length > 0 || (a.unknown?.length ?? 0) > 0 || statusOf(a) === 'NEEDS REVIEW';

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

  const shown = all.filter(a => {
    if (q && !a.name.toLowerCase().includes(q)) return false;
    if (mode === 'qualified') return statusOf(a) === 'QUALIFIED';
    if (mode === 'not') return statusOf(a) === 'NOT QUALIFIED';
    if (mode === 'flagged') return needsReview(a);
    return true;
  });

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
  push(notes.join(' · '), 'muted');

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
    tdCat.append(categorySelect(course.category, async next => {
      await saveRules([{ display: course.name, value: next }]);
      renderRules(); rescoreAll();
    }));
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
    warn.textContent = a.problems.join(' · ');
    td.append(warn);
  }
  td.append(summary, table, add);
  tr.append(td);
  return tr;
}

$('#search').addEventListener('input', renderResults);
$('#filter').addEventListener('change', renderResults);

/* -------------------------------------------------------------- export --- */

$('#export').addEventListener('click', () => {
  const rows = [[
    'Name', 'Student ID', 'Email', 'Grade level', 'Points', 'Status',
    'School', 'Term', 'Courses counted', 'All courses', 'Notes', 'Report card',
  ]];
  for (const a of state.applicants.filter(Boolean)) {
    rows.push([
      a.name, a.studentId, a.email, a.level,
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
