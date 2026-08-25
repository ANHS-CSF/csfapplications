# CSF Eligibility Portal

A password-gated web app that reads CSF application CSVs, pulls each applicant's
Aeries report card from Google Drive, extracts their courses and letter grades,
and scores them against the chapter's eligibility rules.

Verified against the Fall 2026 batch: **91 of 95** report cards parse
automatically; the other 4 are flagged for manual entry (three were screenshots
saved as PDF, one was an Aeries *Transcripts* page rather than a grade report).

## Rules

| | |
|---|---|
| A | 3 points |
| B | 1 point |
| C | 0 points |
| D or F | disqualified |

* At most **5** courses count — the app picks the best combination, not just the top 5 grades.
* **+1** for an A or B in an AP or Honors course, for at most **2** courses.
* Athletics and PE courses (`Inapplicable`) are excluded entirely.
* **10 points or more qualifies.**

By default a D or F only disqualifies if it's in a course that counts, since
athletics courses don't count toward the total either. Flip that under
**Settings** if your chapter treats any D or F as disqualifying.

## Submission checks

Beyond grades, each card is checked against two rules configured under **Settings**
and stored in D1, so every reviewer scores a batch the same way.

**Term** — the card must be from the semester that just ended. Aeries prints this
as e.g. `2nd Semester Grade Report 1/5/2026 6/4/2026`; the end date supplies the
year, which the ordinal alone doesn't (`2nd Semester` is Spring of whichever year
it ended).

**School** — the card's heading must contain one of the accepted school names.
Matching ignores case, punctuation and spacing.

Both failures produce **Needs review**, never **Not qualified**. That distinction
is the point: *Not qualified* means the card was read and the points fall short,
while *Needs review* means it couldn't be judged fairly yet. A wrong-semester
upload, an unrecognized school and an unreadable PDF are all fixable with an
email and a resubmission, so none of them are allowed to read as an academic
failure. Filter to **Needs review only** to get the list to email.

Every card an applicant submits is checked, not just the first — a student with a
concurrent-enrollment card alongside their main one has two, and a wrong-term
second card disqualifies just as a first one would. Either check reports
*undecided* rather than *failed* when nothing could be read, so an unreadable PDF
is never mistaken for a rule violation.

## Setup

```bash
npm install
npx wrangler d1 create csf     # put the printed database_id into wrangler.toml
npm run db:init                # local database: schema + course seed
```

Create `.dev.vars` for local development:

```
ADMIN_PASSWORD=pick-something
SESSION_SECRET=any-long-random-string
```

Then:

```bash
npm run dev
```

## Deploying

```bash
npm run db:init:remote     # idempotent; safe to re-run after a schema change
npx wrangler pages secret put ADMIN_PASSWORD
npx wrangler pages secret put SESSION_SECRET
npm run deploy
```

`SESSION_SECRET` signs the session cookie — make it long and random, and don't
reuse the admin password for it. Rotating it signs everyone out.

## How it works

Two things can't happen in the browser, which is why there are Pages Functions
and not just a static page:

* **The password is a Cloudflare secret**, so it can only be checked server-side.
  `/api/login` verifies it and issues an HMAC-signed, HttpOnly session cookie.
* **Google Drive sends no CORS headers**, so page JavaScript can't fetch a report
  card directly. `/api/pdf` proxies it — authenticated, and restricted to Google
  hosts so it can't be used as an open proxy.

Everything else runs client-side. `public/extract.js` reads the PDF with pdf.js
(vendored in `public/vendor/`, no CDN) and `public/scoring.js` holds the rules.

### Reading an Aeries report card

Aeries emits every table cell as its own text item at a fixed x-coordinate, so
the parser rebuilds visual lines by grouping items on y, then slices columns
using the x-positions of the `Course` / `Teacher` / `Credit` headers. That beats
splitting the line on whitespace, which breaks on multi-word course names and
two-word teacher surnames.

Each row must carry a credit value like `5.00` to count. That's what rejects the
mark legend printed on every card — `A = Excellent`, `B = Above Average` — along
with the GPA block and the school address, all of which contain bare grade
letters that a naive regex would happily read as grades.

## Course rules

The `courses` table in D1 maps each course name to `AP`, `Honors`, `Regular`, or
`Inapplicable`. `seed.sql` is pre-populated with the 103 distinct course names
found across the Fall 2026 cards, classified by best guess from their titles.

**Review the seed before trusting a run.** These in particular are judgment calls:
`Strgth/Exercise`, `Power Walking`, `Pep Squad`, `Online PE-MED`, `Tennis`.

Edit them in the **Course Rules** tab, or bulk-paste `Course Name, Category`
lines. Reclassifying a course from an applicant's detail view saves it to D1 too,
so the next batch picks it up. Any course not in the table is treated as
`Regular` and flagged for review.

## Privacy

Report cards are streamed through the proxy and parsed in the browser. No PDFs
are cached and no applicant data is written to the database — only course rules
persist. Exports save to the reviewer's own machine.

**Application CSVs are never committed.** `.gitignore` excludes `*.csv` and
`*.pdf`, so the Google Forms export stays on whoever's machine is doing the
review. Keep it that way — those files carry students' names, ID numbers, email
addresses and links to their report cards.

## Tests

```bash
npm test
```

Covers the scoring rules (point values, the D/F rule, the best-5 selection, the
2-course bonus cap), the school and term checks, and the CSV parser. One test runs against a real application
export if you have one in the project root, and skips otherwise — the export
itself isn't committed.
