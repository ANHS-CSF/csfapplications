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
failure. Filter to **Needs review only** to work through them, or use
[**Email applicants**](#emailing-applicants) to ask the whole bucket for a
resubmission at once.

Every card an applicant submits is checked, not just the first — a student with a
concurrent-enrollment card alongside their main one has two, and a wrong-term
second card disqualifies just as a first one would. Either check reports
*undecided* rather than *failed* when nothing could be read, so an unreadable PDF
is never mistaken for a rule violation.

## Setup

```bash
npm install
npm run db:create              # put the printed database_id into wrangler.toml
npm run db:init                # local database: schema + course seed
```

Create `.dev.vars` for local development:

```
ADMIN_PASSWORD=pick-something
SESSION_SECRET=any-long-random-string
# Only needed to send email; see "Connecting Gmail" below.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
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
  hosts so it can't be used as an open proxy. With a Google account connected it
  reads through the Drive API, so the files needn't be public.

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

## Emailing applicants

**Email…** on the Results card opens a compose panel that sends personalized mail
through the Gmail API, as the connected account, with copies landing in its Sent
folder.

Pick an audience — everyone needing review, one specific reason such as *No
Aeries grade table*, or one membership group (*Returning members*, *New
applicants*, *Transfers from another school*) — write the message once with
`{name}`-style placeholders,
and uncheck anyone you don't want to contact. Anyone with no email address in the
CSV, or already emailed, starts unchecked. The preview shows the message as the
first recipient will see it, and names any placeholder you misspelled before it
goes out. Templates are saved in D1 and shared between reviewers.

Available placeholders: `{name}` `{first}` `{email}` `{personalEmail}`
`{schoolEmail}` `{studentId}` `{level}` `{status}` `{points}` `{reasons}`
`{problems}` `{notes}` `{courses}` `{school}` `{term}` `{requiredTerm}`
`{returning}` `{returningRaw}`.

`{term}` is the semester read off the card; `{requiredTerm}` is the one Settings
asks for. Use `{requiredTerm}` when telling someone what to resend — if their
card couldn't be read, `{term}` is empty by definition.

`{name}` and `{first}` understand the roster's `Last, First Middle` format, so
`Bacellar Ahmadi, Lucas` greets as *Lucas*, not *Bacellar*, and `{name}` renders
in reading order. The Results table still shows the name exactly as the CSV has
it, so it stays easy to match against the export.

### The two email columns

The application collects a school address and a personal one, and they are not
interchangeable: **the district school accounts have no real inbox, so mail is
only ever sent to the personal address.** `{email}` is therefore always the
personal one; `{schoolEmail}` and `{personalEmail}` are there for when the text
needs to name a specific address.

An applicant who gave a school address but no personal one cannot be reached.
They appear in the recipient list, unchecked, labelled *no personal email — only
a school address*, so it is obvious who needs chasing by hand. Both columns are
in the CSV export.

### Prior membership

The application asks whether they were in CSF last year, with four answers: yes,
no, and two sentences covering transfers who either were or were not members at
their previous school. `{returning}` renders a short label (*Returning member*,
*New applicant*, *Transfer, was a member*, *Transfer, new applicant*) and
`{returningRaw}` gives the answer verbatim.

Membership carries across schools for semester counts, so *Returning members
(any school)* includes a transfer who was a member elsewhere. An answer the app
doesn't recognize — a reworded form option — becomes *Unrecognized answer*
rather than being quietly filed under *No*, so a form edit shows up instead of
silently mis-addressing people.

### Connecting Gmail

`gmail.send` is a Google *restricted* scope, which makes one step in the setup
non-obvious — do not skip step 4.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project and enable the **Gmail API**, **Google Drive API** and
   **Google Sheets API**.
2. Under **APIs & Services → OAuth consent screen**, set the audience to
   **External** (the only option for an `@gmail.com` account; a Workspace
   account may use **Internal** instead and can skip step 4). Add the scopes
   `https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/drive.readonly`.
3. Create an **OAuth client ID** of type *Web application* with these authorized
   redirect URIs — add all three, since the callback has to match whichever
   host the reviewer is actually on:
   - `https://apps.anhscsf.com/api/gmail/callback`
   - `https://csfeligibility.pages.dev/api/gmail/callback`
   - `http://localhost:8788/api/gmail/callback` (for `npm run dev`)
4. **Click "Publish app" so the status reads *In production*.** An External app
   left in *Testing* expires its refresh token after **7 days**, so sending
   would break every week. Publishing does not require verification: because
   both scopes are restricted, Google shows an *unverified app* warning on the
   consent screen — click **Advanced → Go to (unsafe)** to proceed. Verification
   only matters for distributing the app to strangers, and the 100-user cap on
   unverified apps is irrelevant for one adviser's mailbox.
5. Store the credentials:

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID
npx wrangler pages secret put GOOGLE_CLIENT_SECRET
```

6. Open **Settings → Gmail → Connect Gmail** and complete the consent screen.

For local development, add the same two values to `.dev.vars`. Until they are
set, the Gmail card reads *Not set up* and sending stays disabled — nothing else
in the portal is affected.

### Reading from Google instead of public links

The same connection reads Google Drive. Once an account is connected:

* **The responses sheet** — paste its link under *Load the application CSV* and
  click **Load sheet**. The link is remembered in Settings for every reviewer. A
  sheet with several tabs gets a picker; a link carrying `#gid=` opens that tab.
* **Report cards** — `/api/pdf` downloads them through the Drive API as the
  connected account, so the upload folder can be restricted to that account.
  With no account connected it falls back to the anonymous download, which
  still needs the files shared publicly.

The connected account must be able to open the files — the form owner's
account is the simplest choice, since Forms uploads land in its Drive.
`drive.readonly` can read but never modify or delete anything. An account
connected before this was added holds a send-only token: disconnect and connect
again to grant Drive access, and the portal says so if you forget.

A published app's refresh token persists, but it is not immortal. It dies if the
account's Google password is changed, if access is revoked at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions), or
if nothing sends for six months. The portal handles all of these the same way:
sending stops with *Reconnect Gmail* rather than a cryptic failure, and one
trip through step 6 fixes it.

The refresh token is sealed with AES-GCM under a key derived from
`SESSION_SECRET` before it goes into D1, so rotating `SESSION_SECRET` also
invalidates it and you reconnect once.

Batches are split into groups of 20 because a Worker request may make only 50
subrequests on the free plan and each send is one. A send that fails partway
reports which addresses failed and offers to retry just those; a token that dies
mid-batch stops the run rather than failing the rest of the list one by one.

## Privacy

Report cards are streamed through the proxy and parsed in the browser. No PDFs
are cached, and no grades or scores are written to the database — those live in
the browser until it reloads. Course rules and message templates persist.
Exports save to the reviewer's own machine.

The one exception is email. Sending records the recipient's name, email address,
student ID and the subject line in the `email_log` table, so the portal can show
who has already been contacted across sessions. Grades are never part of that
record, and clearing the table erases it.

**Application CSVs are never committed.** `.gitignore` excludes `*.csv` and
`*.pdf`, so the Google Forms export stays on whoever's machine is doing the
review. Keep it that way — those files carry students' names, ID numbers, email
addresses and links to their report cards.

## Tests

```bash
npm test
```

`scripts/test-scoring.mjs` covers the scoring rules (point values, the D/F rule,
the best-5 selection, the 2-course bonus cap), the school and term checks, the
review-reason taxonomy, template placeholder rendering, and the CSV parser. One
test runs against a real application export if you have one in the project root,
and skips otherwise — the export itself isn't committed.

`scripts/test-send.mjs` drives the bulk send route with Google and D1 both
stubbed, so it runs offline. It pins down the things that are expensive to get
wrong on a live list: one bad address doesn't cost the rest of the batch, a dead
token stops the run instead of failing fifty times, every attempt is logged, and
nothing typed into a subject line can forge a mail header.
