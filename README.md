# Leads CRM

Cold outreach CRM built on Next.js (App Router), TypeScript, Tailwind CSS and Supabase.

Contains the database schema, row-level security, authentication, the lead importer, and
the full application interface: dashboard, leads table with search and filters, lead
detail, email logs, replies, analytics and settings.

> **This file has drifted.** Campaigns and templates were deleted in migration 0025, and the
> pipeline stage was redefined as the first unmet gate. `GUIDE.md` is the current document -
> read section 12 there before trusting anything below about the data model.

AI draft generation and scheduling are deliberately **not** implemented — those actions
exist as clearly-labelled placeholders.

> **Modifying the code?** Read [GUIDE.md](GUIDE.md) first. It covers the architecture, the
> security model, the conventions to follow, and the traps. This README covers setup and
> usage.

---

## Contents

- [Stack](#stack)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Authentication and roles](#authentication-and-roles)
- [The security model](#the-security-model)
- [The interface](#the-interface)
- [Integrations](#integrations)
- [Design system](#design-system)
- [Importing leads](#importing-leads)
- [What the workbook contains](#what-the-workbook-contains)
- [Folder structure](#folder-structure)
- [Verifying it works](#verifying-it-works)
- ["Exposed via API" warnings](#exposed-via-api-warnings)
- [Deploying to Vercel](#deploying-to-vercel)
- [Not built yet](#not-built-yet)

---

## Stack

| Concern     | Choice                                          |
| ----------- | ----------------------------------------------- |
| Framework   | Next.js 16 (App Router, Turbopack)              |
| Language    | TypeScript 6 (strict)                           |
| Styling     | Tailwind CSS 4                                  |
| Database    | Supabase (Postgres + Auth + RLS)                |
| Auth        | `@supabase/ssr` cookie sessions                 |
| Spreadsheet | ExcelJS                                         |
| Scripts     | `tsx`                                           |

Node 20.9+ required.

---

## Quick start

1. **Install**

   ```bash
   npm install
   ```

2. **Create the database.** Open your Supabase project → **SQL Editor** → **New query**,
   paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql), press **Run**.
   That one file builds every table, view, policy and trigger. Safe to run twice.

3. **Create your account.** Supabase Dashboard → **Authentication → Users → Add user** →
   *Create new user*, and tick **Auto Confirm User**.

4. **Make yourself an admin.** Back in the SQL Editor, run this with your own email:

   ```sql
   insert into public.profiles (id, role, full_name)
   select u.id, 'admin', coalesce(u.raw_user_meta_data ->> 'full_name', u.email)
   from auth.users u
   where lower(u.email) = lower('you@example.com')
   on conflict (id) do update set role = 'admin';
   ```

5. **Lock the door.** Authentication → **Sign In / Providers → Email** → turn off
   *Allow new users to sign up*. There is no sign-up page in the app, so from here on
   accounts can only be created by you from the dashboard.

6. **Configure and import**

   ```bash
   cp .env.example .env.local     # fill in your Supabase URL + keys
   npm run import:leads:dry       # validate the workbook, write nothing
   npm run import:leads           # import for real
   npm run dev                    # http://localhost:3000
   ```

---

## Environment variables

Copy `.env.example` to `.env.local`. From **Supabase Dashboard → Project Settings → API**:

| Variable                        | Where it is used         | Notes                                        |
| ------------------------------- | ------------------------ | -------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | browser + server         | Safe to expose.                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server         | Safe to expose — RLS still applies.          |
| `SUPABASE_SERVICE_ROLE_KEY`     | server only              | **Bypasses RLS.** Never expose to a browser. Required by the integrations. |
| `APP_ENCRYPTION_KEY`            | server only              | **Required for integrations.** 32 random bytes, base64. Encrypts stored credentials. |
| `LEADS_XLSX_PATH`               | `npm run import:leads`   | Defaults to `Leads.xlsx`.                    |
| `LEADS_XLSX_SHEET`              | `npm run import:leads`   | Defaults to `Sheet2`.                        |

`.env.local` is gitignored. The service role key must never be given a `NEXT_PUBLIC_`
prefix — `src/lib/env.ts` throws if it is ever read in a browser context.

---

## Database

**The easy way — one file.** [`supabase/schema.sql`](supabase/schema.sql) contains the
whole schema in a single script. Paste it into the Supabase SQL Editor and run it. It is
generated by concatenating the migrations below in order, so the two never disagree, and
every statement is idempotent — running it again changes nothing.

Migrations also live individually in `supabase/migrations/`, ordered by filename, for when
you start using the Supabase CLI:

| File                                    | What it creates                                              |
| --------------------------------------- | ------------------------------------------------------------ |
| `…090000_init_enums_and_helpers.sql`     | Enums (`app_role`, `lead_status`, …), `set_updated_at()`      |
| `…090100_profiles.sql`                   | `profiles`, role helpers, new-user trigger, escalation guard   |
| `…090200_leads.sql`                      | `leads` + indexes + full-text search column                    |
| `…090300_templates_and_campaigns.sql`    | `templates`, `campaigns`, `leads.campaign_id`                  |
| `…090400_email_logs_and_replies.sql`     | `email_logs`, `replies`                                        |
| `…090500_settings.sql`                   | `settings` + seeded default configuration                      |
| `…090600_dashboard_views.sql`            | The `dashboard_*` views viewers read                           |
| `…090700_rls_policies.sql`               | RLS enabled + policies on every table                          |

### Applying them

**Dashboard (no tooling needed):** paste `supabase/schema.sql` into the SQL Editor and Run.

**Already applied `schema.sql` once?** Run `supabase/schema-update-2-integrations.sql`
instead — it contains only migrations 0009 and 0010 (viewer lockdown + integration tables).
Re-running the full `schema.sql` is also safe; every statement is idempotent.

**Hosted project via CLI:**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Local stack** (needs Docker):

```bash
supabase start
supabase db reset       # runs every migration, then supabase/seed.sql
```

If you edit a migration, regenerate the single-file version so the two stay in sync.

> This SQL has not been executed against a live database from this repo — there was no
> Postgres available at build time. Run it against a scratch project first and read the
> output before pointing it at anything you care about.

### Schema at a glance

```
profiles     id, role(admin|viewer), full_name, timestamps
leads        identity (business_name, website, email, phone, city, country, niche,
             category, source), status, campaign_id,
             research (research_summary, website_observations,
             automation_opportunities, ai_chatbot_opportunities,
             website_improvement_opportunities, personalization,
             interesting_facts, outreach_angle, social_links),
             outreach (subject_line, draft_email), notes,
             last_contacted_at, next_followup_at,
             dedupe_key UNIQUE, import provenance, timestamps
templates    name, subject, body, variables[], is_active
campaigns    name, active, daily_limit, template_id, window, timestamps
email_logs   lead_id, campaign_id, status, provider, message_id, sent_at, error
replies      lead_id, reply_text, sentiment, confidence, is_handled, received_at
settings     key -> jsonb value, is_sensitive
```

`lead_status` supports: `new`, `researching`, `ready`, `approved`, `sending`, `sent`,
`replied`, `bounced`, `invalid`, `archived`.

### Types

`src/lib/supabase/database.types.ts` is hand-maintained to match the migrations. Once you
have a live project you can regenerate it instead:

```bash
npm run types:gen                                    # local stack
supabase gen types typescript --project-id <ref> > src/lib/supabase/database.types.ts
```

If you change a migration, change that file in the same commit.

---

## Authentication and roles

Email/password via Supabase Auth, with the session held in cookies by `@supabase/ssr`.

There are exactly two roles, stored in `profiles.role`:

| Capability                | admin | viewer |
| ------------------------- | :---: | :----: |
| Dashboards, graphs, stats |   ✅   |   ✅    |
| Campaign statistics       |   ✅   |   ✅    |
| Reply statistics          |   ✅   |   ✅    |
| Full lead detail          |   ✅   |   ❌    |
| Email addresses           |   ✅   |   ❌    |
| Research / personalization|   ✅   |   ❌    |
| Generated drafts          |   ✅   |   ❌    |
| Templates                 |   ✅   |   ❌    |
| Settings                  |   ✅   |   ❌    |
| Edit / send / import      |   ✅   |   ❌    |

A new auth user gets a `profiles` row automatically via the `on_auth_user_created`
trigger, defaulting to **`viewer`**. The role can only be raised from `app_metadata.role`,
which **only the service role can set** — so even with sign-ups enabled, nobody can
register themselves as an admin. A `prevent_role_escalation` trigger separately blocks
non-admins from changing any role.

### Accounts

There is **no sign-up page** — by design. Accounts are created by you in the Supabase
Dashboard (**Authentication → Users → Add user**, tick *Auto Confirm User*), and every new
one starts as a `viewer`. Promote with the SQL in step 4 of the
[Quick start](#quick-start), or find it at the bottom of `supabase/schema.sql`.

To see who has what:

```sql
select p.role, u.email, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
order by p.role, u.email;
```

Once your admin account exists, turn off *Allow new users to sign up* under
**Authentication → Sign In / Providers → Email**. After that the only way in is an account
you created.

---

## The security model

Three independent layers. Each one alone would be a bug; together they fail closed.

**1. Middleware — `src/proxy.ts`**

Runs before every non-static request. Redirects signed-out users to `/login`, and blocks
non-admins from `/admin`, `/leads`, `/research`, `/drafts`,
`/settings`, `/import` and `/api/admin`. Also refreshes the Supabase session cookie.

> Next 16 renamed the middleware file convention from `middleware.ts` /
> `export function middleware` to `proxy.ts` / `export function proxy`. Same edge hook,
> same `config.matcher` — the old name still works but logs a deprecation warning.

**2. Page and action guards — `src/lib/auth/session.ts`**

`requireAdmin()` in pages, `assertAdmin()` in Server Actions. This matters because
middleware does not run on every code path — a Server Action invoked directly does not
pass through it. Call one of these at the top of every admin page, action and route
handler you add.

**3. Row Level Security — `…090700_rls_policies.sql`**

The backstop. Every table has RLS enabled; every policy requires `public.is_admin()`.
A viewer who somehow reaches an admin query gets zero rows, not a leak.

### Why viewers read views, not tables

RLS is *row*-level. It cannot express "this role may read `leads.status` but not
`leads.email`". So viewers get **no row access to `leads` at all** — and to `templates`,
`replies`, `email_logs` and `settings` either. Statistics reach them through the
`dashboard_*` views, which are aggregate-only and column-allow-listed:

```
dashboard_overview               headline KPI counters
dashboard_lead_status_counts     pipeline breakdown
dashboard_leads_by_country       geography
dashboard_leads_by_niche         vertical
dashboard_leads_by_category      qualification buckets
dashboard_leads_created_daily    intake over time
dashboard_campaign_stats         per-campaign counts, reply + bounce rates
dashboard_email_activity_daily   sending activity
dashboard_reply_stats            replies by sentiment (never reply_text)
dashboard_reply_activity_daily   replies over time
dashboard_leads_safe             per-lead list, contact/research/drafts stripped
```

These views run with their owner's privileges so they can read past RLS — which is
precisely why **adding a column to one of them is a security decision**. None of them
uses `select *`, on purpose.

Two consequences worth knowing:

- The migrations deliberately do **not** use `FORCE ROW LEVEL SECURITY`. Forcing it would
  subject the views' owner to RLS, and since every policy requires `is_admin()`, every
  viewer dashboard would silently return zero rows.
- Supabase's linter will flag these as "security definer views". That is intended here.

---

## The interface

| Route         | Access         | What it does                                                              |
| ------------- | -------------- | ------------------------------------------------------------------------- |
| `/dashboard`  | admin + viewer | 8 metric cards, emails/replies trend charts, status + country + niche breakdowns, campaign stats |
| `/leads`      | admin          | Data table: global search, status filters, sorting, pagination, row selection, bulk actions |
| `/leads/[id]` | admin          | Full detail, inline editing, approve/archive, email + reply history, timeline |
| `/email-logs` | admin          | Recipient, subject, status, provider, date, error                         |
| `/replies`    | admin          | Business, preview, sentiment, date                                        |
| `/settings`   | admin          | Google Sheets and email provider config; credentials; sync/test triggers |
| `/login`      | public         | Email + password                                                          |

**Viewers currently see nothing.** `/dashboard` renders a "limited access" state for any
non-admin, and migration 0009 gates every `dashboard_*` view on `is_admin()` so the
restriction holds at the database level too, not just in the UI. What a viewer should be
allowed to see is not yet defined — when it is, add a purpose-built view for that role
rather than relaxing the admin ones.

**Leads list state lives in the URL** (`?q=&status=&sort=&dir=&page=&size=`), so any view is
shareable and the back button works. Search covers business name, email, website, phone,
city, country, category and niche — pasting an email address jumps straight to that lead.

Press `/` anywhere on the leads page to focus search. Drag a column edge to resize;
double-click it to reset. Widths persist per browser.

### Placeholder actions

- **Regenerate draft** — writes nothing and says so; needs the AI layer.

**Send email** is real — see [Integrations](#integrations). **Start / Pause / Resume / Stop**
on campaigns write `campaigns.active`, the flag a future sending worker will read; no
scheduler exists yet, so nothing is dispatched automatically.

## Integrations

Two services, both server-side. **The UI never calls an external API directly** — it calls
a Server Action, which calls a service in `src/lib/services/`. That keeps credentials off
the client and gives one place to record run history.

**Sync Data** appears under Settings → Integrations → Actions and on the Leads toolbar. It
shows **Running / Success / Failed** plus the last run time and duration, read from the
`integration_runs` table — so status survives a reload, and a run triggered from another
tab (or later, a cron job) shows up here too.

### Google Sheets

The sheet is the ingestion layer. Sync reads every row and upserts into Supabase.

| Reported  | Meaning                                              |
| --------- | ---------------------------------------------------- |
| Imported  | Inserted on this run                                 |
| Updated   | Already existed and at least one field changed       |
| Skipped   | Already existed, nothing changed                     |
| Invalid   | Failed validation — never sent to the database       |
| Dupes     | A second row in the sheet resolving to an identity already seen |

Invalid rows are listed with their **sheet row number**, so a failure points at a real line
you can go and fix.

Identity and validation are **not reimplemented** here — the sync calls the same
`src/lib/import/` code the workbook importer uses, so the two can never disagree and create
duplicates of each other's rows:

```
email:<address>     preferred
site:<host+path>    when there is no usable email
name:<name>|<city>  last resort
```

`leads.sheet_row_number` records where each lead came from, and is kept current when rows
move (the sheet gets sorted or edited above). A blank cell never erases data already in the
CRM — an operator may have filled it in by hand.

Two auth modes: **API key** (sheet shared as "anyone with the link can view") or **service
account** (private sheets — share the sheet with the service account's `client_email`).
Neither needs the `googleapis` package; the service-account JWT is signed with `node:crypto`.

Nothing polls. Sync runs when a button is pressed. `syncFromGoogleSheet()` is a plain
function of (sheet, database), so a cron job or route handler can call it identically.

### Write-back: CRM edits → the sheet

Off by default. Enable it under Settings → Integrations → Google Sheets.

**It requires service-account auth with Editor access on the sheet.** A Google API key is
read-only and can never authorise a write; the settings form refuses that combination
rather than letting every save fail with a 403.

With it on, saving a lead updates the row it came from (`leads.sheet_row_number`). Fields
are matched to columns by header name — a column that is not in the sheet is skipped, and
**no columns are ever created**. Values are written as `RAW`, so a draft beginning with `=`
lands as text rather than being evaluated as a formula.

Write-back is best-effort: the CRM is the system of record, so a Sheets outage never makes
a save look like it failed. The result is appended to the save confirmation, so a silent
failure is impossible.

### Email providers

`EmailProvider` is a two-method interface — `verify()` and `send()`. Exactly one provider is
active, chosen by the `email.provider` setting.

| Provider | Transport                          | Credential                        |
| -------- | ---------------------------------- | --------------------------------- |
| SMTP     | any relay (Mailgun, Postmark, …)   | password                          |
| Gmail    | `smtp.gmail.com:465`               | App Password (needs 2-Step Verification) |

Gmail uses an App Password over SMTP rather than the Gmail REST API with OAuth2: no consent
screen, no client id/secret, no refresh-token rotation, for sending from one owned mailbox.
Moving to the REST API later means one new class against the same interface — no caller
changes.

**Test Connection** authenticates without sending. **Send Test Email** delivers a fixed
message. Both record a run.

### Sending a lead's draft

Lead detail → **Send Email**:

1. Validates the lead has an address, a subject and a draft.
2. Writes the `email_logs` row as `queued` **before** sending — a crash or timeout mid-send
   still leaves evidence. A log written only on success loses exactly the cases you need to
   investigate.
3. Sets the lead to `sending`, so a second click cannot double-send.
4. Sends, then records `sent`/`failed`, the provider **message id**, and the error text.
5. Moves the lead to `sent` with `last_contacted_at`, or back to `approved` on failure —
   never stranded in `sending`.

`{{business_name}}`, `{{city}}`, `{{website}}`, `{{industry}}`, `{{personalization}}` and
`{{signature}}` are substituted at send time.

### Where credentials live

Configuration splits in two:

- **`public.settings`** — non-secret config: hosts, ports, URLs, sheet id, from address.
- **`public.integration_secrets`** — credentials, AES-256-GCM encrypted by the application
  before they reach Postgres, so a database dump alone discloses nothing.

That table has **every grant revoked from both `anon` and `authenticated`** and RLS enabled
with zero policies. No browser token can read it, even an admin's. Server code reaches it
through the service-role client after its own `assertAdmin()`.

Secrets are write-only in the UI: you can set or replace one, but the stored value is never
sent back — only a "configured" flag and a masked `••••abcd` hint.

> Losing `APP_ENCRYPTION_KEY` makes stored credentials unreadable and they must be
> re-entered. Back it up with your other production secrets, and use a different value per
> environment.

## Design system

Generated with the `ui-ux-pro-max` skill in `.claude/Skills`, resolved to its
**Data-Dense Dashboard** profile — the Linear / Vercel / GitHub register.

| Token             | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Sidebar / header  | 240px / 56px                                              |
| Table row height  | 36px                                                      |
| Primary           | `#2563EB` light, `#3B82F6` dark                           |
| Typeface          | Inter, self-hosted via `next/font` (no runtime CDN call)   |
| Icons             | Lucide — no emoji used as UI icons                        |

All colour is expressed as semantic CSS variables (`--surface`, `--muted-foreground`,
`--danger`) defined once in `globals.css` for both themes, then mapped into Tailwind via
`@theme inline`. Components never hardcode a hex value, so the dark palette is a
single-file change.

Accessibility decisions that are load-bearing rather than decorative:

- Status is never colour alone — every badge pairs a colour with an icon and a text label.
- Charts ship a visually-hidden `<table>` of the same data; a chart alone is unreadable to
  a screen reader.
- Sortable headers set `aria-sort`; the current nav item sets `aria-current="page"`.
- A skip link is the first tab stop. Focus rings are global and never removed.
- `prefers-reduced-motion` is honoured globally in `globals.css`.
- Theme toggle offers light / dark / **system**, and an inline script applies the stored
  choice before first paint so dark-mode users never see a white flash.

Charts are hand-rolled SVG with no charting dependency — a library would add bundle weight
and a React-19 compatibility risk for what these views need (one trend line, ranked bars).

## Importing leads

```bash
npm run import:leads:dry     # validate everything, write nothing
npm run import:leads         # import
npm run import:leads -- --help
```

| Flag                  | Effect                                                        |
| --------------------- | ------------------------------------------------------------- |
| `--file=<path>`       | Workbook path (default `Leads.xlsx`)                          |
| `--sheet=<name\|idx>` | Worksheet (default `Sheet2`)                                  |
| `--dry-run`           | Validate and report; no writes, no credentials needed         |
| `--update`            | Also refresh contact/research/draft fields on existing leads  |
| `--key-mode=email`    | Identity: email → website → name+city (**default**, per spec) |
| `--key-mode=business` | Identity: business name + city                                |
| `--limit=<n>`         | Process only the first n rows                                 |
| `--report-path=<p>`   | Where to write the JSON report (default `import-report.json`) |
| `--no-report`         | Skip the report file                                          |

### Idempotency

Every lead gets a `dedupe_key`, derived in this order:

```
email:<normalised email>        preferred
site:<host+path>                when there is no usable email
name:<business name>|<city>     last resort
```

That column is `UNIQUE`, and inserts use `ON CONFLICT DO NOTHING ... RETURNING`. So the
database itself returns exactly which rows were new — running the import twice imports
nothing the second time and reports everything as skipped. It is also safe against two
imports running concurrently.

`--update` refreshes only contact, research and draft fields. It never touches `status`,
`notes`, `campaign_id`, `last_contacted_at` or `next_followup_at`, so re-importing cannot
undo pipeline progress or overwrite an operator's work.

### The summary

```
  Rows read          703
  Imported           698
  Skipped (in DB)      0
  Duplicates           5
  Invalid rows         0
```

- **Imported** — inserted on this run
- **Skipped** — already in the database (this is what a second run looks like)
- **Duplicates** — a later row in the file resolved to an identity already seen
- **Invalid** — failed validation, never sent to the database

Every duplicate and every discarded field value is listed, and the full detail is written
to `import-report.json` (gitignored). Nothing is dropped silently.

---

## What the workbook contains

`Leads.xlsx` has two sheets. **Only `Sheet2` is imported by default** — it is the enriched
set (703 rows: research, personalization and generated drafts). `Sheet1` holds 687
Pakistan-based leads with no research or drafts; import it with `--sheet=Sheet1` if you
want it later. The two sheets barely overlap (9 rows), so importing both would roughly
double the lead count rather than merge.

Things the importer handles, found by inspecting the actual data:

- **Headers** carry stray leading spaces and inconsistent casing (`" Niche"`,
  `"Email draft Status"` vs `"Email sent status"`). Normalized before mapping.
- **Dates** mix three formats in one column: Excel serials (524 rows), `DD-MM-YYYY` text
  (179 rows), and real dates. `Date Added` becomes `created_at` so the intake charts show
  real history instead of one spike on import day. The serial converter handles Excel's
  phantom 1900 leap day.
- **Junk emails** — 19 rows carry scraper artefacts and placeholders
  (`…@sentry-next.wixpress.com`, `user@domain.com`, `youremail@gmail.com`). These are
  discarded and the lead falls back to website or name for its identity. Without this, the
  nine rows sharing one Wix error-reporting address would collapse into a single lead.
- **Social links** arrive as JSON, truncated JSON, or an English sentence. Valid JSON is
  parsed; anything else is preserved under `_raw` rather than thrown away.
- **Status** is inferred from the four status columns: reply → `replied`, sent → `sent`,
  draft present → `ready`, research done → `researching`, else `new`. Every Sheet2 row
  currently has a draft and none are sent, so they all import as `ready`.

### One thing to be aware of

Five pairs of rows are **genuinely different businesses that share one contact address** —
for example two Chiang Mai agencies both on `info@faranghomes.com`. Because the spec makes
email the identity, those collapse into 5 leads instead of 10 (703 rows → 698 leads).

That is the specified behaviour, not a bug, and every collapse is printed by name. If you
would rather keep them apart, run with `--key-mode=business` and you get all 703.

---

## Folder structure

```
.
├── Leads.xlsx                      source workbook
├── supabase/
│   ├── schema.sql                  ← paste this into the SQL Editor
│   ├── config.toml                 local CLI config
│   ├── seed.sql                    empty since 0025 (db reset)
│   └── migrations/                 the same schema as 8 ordered migrations
├── scripts/
│   └── import-leads.ts             import CLI
└── src/
    ├── proxy.ts                    route-protection middleware
    ├── app/
    │   ├── layout.tsx  page.tsx  globals.css
    │   ├── login/                  page, client form, server actions
    │   ├── unauthorized/
    │   └── (app)/                  authenticated shell (sidebar + topbar)
    │       ├── layout.tsx
    │       ├── dashboard/          admin + viewer — views only
    │       ├── leads/
    │       │   ├── (list)/         table, search, filters  [loading.tsx scoped here]
    │       │   └── [id]/           detail + inline editing
    │       ├── email-logs/  replies/  settings/
    ├── components/
    │   ├── ui/                     primitives: button, card, input, badge,
    │   │                           dialog, table, skeleton, toast
    │   ├── shell/                  app-shell, sidebar, topbar, nav-config
    │   ├── data-table.tsx          generic sortable/selectable/resizable table
    │   ├── search-bar.tsx          debounced, "/" to focus
    │   ├── filter-panel.tsx        multi-select status filter with counts
    │   ├── charts.tsx              dependency-free SVG charts
    │   ├── metric-card.tsx  status-badge.tsx  empty-state.tsx
    │   ├── confirm-dialog.tsx  pagination.tsx  theme-toggle.tsx
    └── lib/
        ├── env.ts                  lazy, guarded env access
        ├── utils.ts                cn() + formatters
        ├── use-persisted-state.ts  localStorage via useSyncExternalStore
        ├── auth/session.ts         requireUser / requireAdmin / assertAdmin
        ├── data/                   server-side queries (dashboard, leads, misc)
        ├── actions/                server actions — every one calls assertAdmin()
        ├── services/               integrations — the only code that talks outward
        │   ├── config.ts           typed reader for non-secret settings
        │   ├── secrets.ts          AES-256-GCM encrypted credential store
        │   ├── integration-runs.ts run history behind the status chips
        │   ├── google-sheets.ts    Sheets reader + OAuth token
        │   ├── sheet-sync.ts       sync engine (sheet → CRM), reuses lib/import
        │   ├── sheet-writer.ts     write-back (CRM → sheet row)
        │   └── email/              types · smtp · gmail · index · send-lead-email
        ├── supabase/
        │   ├── client.ts           browser client
        │   ├── server.ts           server component / action client
        │   ├── service-client.ts   service-role factory (scripts)
        │   ├── admin.ts            service-role for app code (server-only)
        │   ├── middleware.ts       session refresh + role lookup
        │   └── database.types.ts   schema types
        └── import/
            ├── workbook.ts         ExcelJS reader
            ├── normalize.ts        field normalizers + junk detection
            ├── dedupe.ts           identity keys
            ├── mapping.ts          header -> column mapping, validation
            └── importer.ts         reusable import engine
```

> `leads/(list)/loading.tsx` is inside a route group on purpose. A `loading.tsx` placed at
> `leads/` would wrap `leads/[id]` too, so that route would start streaming (committing
> HTTP 200) before `notFound()` could run — a missing lead would render the not-found page
> with a 200 status. The route group keeps the Suspense boundary on the list only.

The import engine is a plain function (`importLeads`) that takes a Supabase client, so a
future admin-triggered upload UI can reuse it without touching the CLI.

---

## Verifying it works

After the schema is applied and the leads are imported, run `npm run dev`.

**As your admin account:**

1. `/login` → lands on `/dashboard`, showing 698 total leads
2. The sidebar lists all seven destinations
3. `/leads` shows the table with email addresses; search for one to jump to that lead
4. Open a lead → research, draft and internal notes are all editable

**To prove the viewer restrictions work** (optional), add a second user in the Supabase
dashboard and leave it on the default `viewer` role:

1. `/login` → lands on `/dashboard`, also showing 698 — these come from the views
2. The sidebar shows **only** Dashboard
3. Typing `/leads` (or any admin URL) directly redirects to `/unauthorized`

Confirmed end to end against the live database:

| Check                                                        | Result |
| ------------------------------------------------------------ | ------ |
| Admin reaches all 7 routes                                     | 200    |
| Viewer reaches `/dashboard`                                    | 200    |
| Viewer on leads / campaigns / templates / logs / replies / settings | 307 → `/unauthorized` |
| Viewer dashboard renders real figures (698 leads, 31 countries) | yes    |
| Viewer `select` on `leads`, `templates`, `settings`             | 0 rows |
| Anonymous anon-key request to any table or view                 | 401    |
| Unknown lead id                                                 | 404    |

**Idempotency:** run `npm run import:leads` a second time. Expect `Imported 0`,
`Skipped 698`.

Checks:

```bash
npm run typecheck
npm run lint
npm run build
```

---

## "Exposed via API" warnings

Supabase shows an **"exposed via API"** note on tables in the `public` schema. That is
informational, not a vulnerability: PostgREST publishes every table in `public` at
`https://<ref>.supabase.co/rest/v1/<table>`, and it does so for **every** Supabase project.
The URL being reachable is not the same as the data being readable — RLS and grants decide
that.

Verified against this project with the public anon key and no login:

```
leads       401    profiles    401    campaigns   401
templates   401    email_logs  401    replies     401
settings    401    dashboard_* 401    INSERT      401
```

Not "empty array" — **401 Unauthorized**, because migration 0008 runs
`revoke all on <table> from anon` on top of RLS. An anonymous caller cannot even reach the
policy check.

**Two warnings you should expect to see, and can ignore:**

1. **"Table is exposed via API"** on the seven tables — expected, handled by RLS + grants.
2. **"Security Definer View"** on the eleven `dashboard_*` views — intentional. They run
   with their owner's privileges *specifically so* a viewer can read aggregate statistics
   without being granted access to the underlying `leads` rows. Removing it would blank
   every viewer dashboard. This trade-off is documented at the top of migration 0007.

**One warning you must never ignore:** *"RLS has not been enabled on public.<table>"*. That
is a real hole. Check with the Security Advisor (Dashboard → Advisors → Security), or:

```sql
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relrowsecurity, relname;
```

Every row must show `rls_enabled = true`. If you add a table later, enable RLS and write
its policies in the same migration — a new table with RLS off is readable by anyone holding
the anon key, which is shipped in the browser bundle by design.

If you want the warnings gone entirely rather than merely understood, move the tables to a
schema PostgREST does not publish (e.g. `app`) and set `db: { schema: 'app' }` on the
clients. That is a real change with real cost, and given the 401s above it buys defence in
depth rather than fixing an actual exposure.

## Deploying to Vercel

1. Push to GitHub and import the repo in Vercel.
2. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for all environments.
3. Add `SUPABASE_SERVICE_ROLE_KEY` **only** if a server-side job needs it. Nothing in the
   app currently does — the scripts run locally.
4. In Supabase → Authentication → URL Configuration, set the site URL and add your Vercel
   preview/production domains as redirect URLs.
5. Apply migrations to the production project (`supabase db push`) before the first deploy.

---

## Not built yet

Intentionally out of scope — the schema, guards and UI surfaces are in place for them:

- **What viewers are allowed to see.** Currently: nothing. Add a viewer-scoped view.
- **AI draft generation / regeneration.** `ai.default_model` is stored; "Regenerate draft"
  reports that it is not connected.
- **Ollama.** Not implemented, and deliberately not shown as a fake input.
- **Inbound reply ingestion and sentiment classification.** `replies` is ready.
- **Scheduling.** Sync runs on a button press only. `syncFromGoogleSheet()` is a plain
  function, so a cron route can call it unchanged.
- **Bulk / throttled sending.** One lead at a time from its detail page. The daily limit,
  working hours and pause switch in `settings` are stored but not yet enforced — that is
  the sending worker's job.
- **Delivery webhooks.** `email_logs` has a unique `(provider, message_id)` index ready for
  a webhook handler to upsert `delivered` / `opened` / `bounced` against.
- **Admin-triggered workbook import from the browser.** `importLeads()` already takes a
  Supabase client, so a route handler can reuse it as-is.

When you add any of them:

1. Guard the page with `requireAdmin()`.
2. Guard the Server Action with `assertAdmin()` — middleware does **not** run for actions.
3. Add the route prefix to `ADMIN_PREFIXES` in `src/proxy.ts`.
4. Add the nav entry to `src/components/shell/nav-config.ts` with its allowed roles.

Credentials (SMTP passwords, API keys) belong in environment variables, not in `settings`.
The `is_sensitive` flag exists so those rows are filtered out before settings ever reach
the client.
#   l e a d s - w e b s i t e  
 