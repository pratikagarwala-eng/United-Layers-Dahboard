# UnitedLayer — Sequence & Email Activity Dashboard

Single-page dashboard covering four questions:

1. **Contacts added to sequences** — enrolments over time, by owner, with unique-contact de-duplication.
2. **Emails sent** — sends over time, with a first-email-of-sequence filter.
3. **Email performance overview** — account-wide funnel and delivery health for a date range, pulled live from the sending platform's reporting API.
4. **Overdue tasks by owner** — open tasks past their due date, one bar per owner, grouped by task type.

Charts 1, 2 and 4 read a Google Sheet directly in the browser. Chart 3 goes through a
server-side function so the API token never reaches the client.

---

## Running locally

```bash
cp .env.example .env          # then put your token in it
node reply-proxy.js
```

Open <http://127.0.0.1:8787>.

`reply-proxy.js` serves `index.html` and exposes `GET /api/emails-overview`, the
same route the deployed version uses, so local and production behave identically.

## Deploying to Vercel

1. Push this directory to its **own** GitHub repository.
2. Import the repo in Vercel. No build step or framework preset is needed — it is
   a static `index.html` plus one function in `api/`.
3. Add an environment variable in **Project → Settings → Environment Variables**:

   | Name | Value | Environments |
   |---|---|---|
   | `REPLY_API_TOKEN` | your API token | Production, Preview, Development |

4. Deploy. Changing the variable later requires a redeploy to take effect.

Never commit `.env` — it is git-ignored, and the token belongs only in Vercel's
environment variables.

---

## Layout

```
index.html              the whole dashboard (inline CSS/JS, no build step)
api/emails-overview.js  serverless function that calls the reporting API
reply-proxy.js          local dev server; mirrors the function's contract
vercel.json             security headers, no-store on the HTML
.env.example            template for the token
```

## How the data is joined

- **Owner** — the first roster name appearing anywhere in the sequence name. Names
  follow several conventions — person-first (`Rahul_US_Direct_July`), region-first
  (`US_BFSI_Akshay_New`, `Europe_DataCenter_Aryaman 2`) and status-prefixed
  (`STOP!!US_VAR(Indirect)_Arsh`, `India_VAR_Rahul_Inactive`) — so taking the leading
  token mislabelled a quarter of them as "Us", "Europe" or "Stopus". Scanning for a
  roster name handles all three, and words like Europe, VAR or Riyad (a city) can
  never be read as an owner because they are not on the roster. The roster is
  `OWNERS` near the top of `index.html`; add a first name to onboard someone.
  Sequences matching nobody show as **Unassigned** and are listed in the diagnostics
  card, so a missing name is visible rather than absorbed into a wrong bar.
  `ownerUserId` is joined from the *All Sequences* tab and kept on every row, but
  licence seats are shared between people, so it identifies a seat rather than a
  person. It is available as a column in every drill-down and export.
- **First email** — a row in *All Email Activities* counts as a first email when its
  `sequenceStepNumber` equals that sequence's `email_step_number` in *Campaign
  Structure*. Resolved per sequence; step 1 is never assumed.
- **Timezone** — sheet timestamps carry no offset and are treated as IST
  (Asia/Kolkata) wall-clock. All bucketing uses UTC getters over civil timestamps,
  so results do not shift with the viewer's browser timezone.
- **Overdue task due dates** — taken from `dueToRaw` (UTC) plus 5:30. The sheet's own
  `dueToIST` column is deliberately ignored: it is blank on most rows, and where it is
  filled the day and month are transposed (a task due `2026-05-03 09:49` appears as
  `2026-03-05 15:19` — the +5:30 is right, the date is not). Fixing that formula at
  source would let the column be used directly.
- **De-duplication** — contact email lowercased, falling back to contact ID. When
  "unique contacts only" is on, each contact is attributed to its earliest
  `addingDate` in range, so stacked segments always sum to the headline total.

Open **Data source & join diagnostics** at the foot of the page to see the loaded
row counts, the column mapping, the owner derived for every sequence, and the
first-email step resolved per sequence.

---

## Security notes

- The API token lives only in `REPLY_API_TOKEN`. It is never sent to the browser,
  never written into `index.html`, and is redacted from logs.
- `api/emails-overview.js` allow-lists the response fields, validates the date
  range, rate-limits per instance, rejects cross-origin callers, and caches
  identical ranges at the edge for 60s to protect the upstream quota.
- Security headers and `noindex` are set in `vercel.json`.

**This deployment has no authentication.** Anyone with the URL can view the
dashboard, and because charts 1 and 2 read the Google Sheet client-side, the sheet
ID is present in the page source — so a visitor can read the underlying sheet
directly, including contact names, work emails, companies and job titles. `noindex`
keeps it out of search results but does not restrict access. If that is not
intended, add authentication (a password gate, Vercel Deployment Protection, or
domain-restricted SSO) and move the sheet read server-side.
