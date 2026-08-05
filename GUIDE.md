# GUIDE.md Leads CRM codebase guide

**Read this before changing anything. Update it before you finish.**

This is the internal guide: how the code works, why it is shaped this way, and the traps
that will bite you. `README.md` is the setup-and-usage document this one is for whoever
(human or AI agent) is about to modify the code.

> **Standing rule:** read this file at the start of a task, update it at the end. If you
> add a migration, a route, a service or a convention, it belongs here.
> Nver add the double dash, never.

---

## 1. What this is

A cold-outreach CRM. Leads are generated and enriched **outside** the CRM and land in a
Google Sheet; the CRM ingests them, lets an admin review and edit drafts, and sends email
through a pluggable provider. Edits can optionally be written back to the sheet.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 · Tailwind CSS 4 ·
Supabase (Postgres + Auth + RLS) · nodemailer · ExcelJS.

Node 20.9+. Windows dev box; PowerShell is the primary shell.

### Current state (2026-08-03)

| Area | Status |
| --- | --- |
| Schema, RLS, auth, middleware | Done |
| Workbook importer (`Leads.xlsx`) | Done 698 leads imported |
| Full UI (dashboard, leads, campaigns, templates, logs, replies, settings) | Done |
| Google Sheets sync (read) | Done |
| Google Sheets write-back (CRM edit → sheet row) | Done off by default, needs service account |
| Email providers (SMTP, Gmail) + real sending | Done |
| Encrypted credential storage | Done |
| n8n | **Removed** (migration 0011) the user does not want it |
| Admin review workflow (research/personalization/3 drafts/notes) | Done |
| Email versioning (`email_versions`) | Done nothing is ever overwritten |
| Outreach lifecycle (`lead_pipeline`, derived stage + next step) | Done |
| Draft generation (template generator + Ollama) | Done `ai.provider` setting |
| Automatic follow-ups (`/api/cron/outreach`) | Done needs `CRON_SECRET` |
| Public statistics page (`/stats`, no login) | Done anon reads 5 aggregate views |
| Analytics page | Done |
| Modular outbound sync layer | Done `lib/services/sync/` |
| What signed-in *viewers* may see | **Still deliberately nothing** `/stats` is the public answer |
| Reply ingestion (inbound parsing) | Not built `replies` is written by nothing yet |
| Email verification service | Not built `email_verified` is set by hand |

---

## 2. Migration status READ THIS FIRST

Migrations live in `supabase/migrations/`, applied in filename order.

| # | File | Applied to live DB? |
| --- | --- | --- |
| 0001 | `20260803090000_init_enums_and_helpers.sql` | ✅ yes |
| 0002 | `20260803090100_profiles.sql` | ✅ yes |
| 0003 | `20260803090200_leads.sql` | ✅ yes |
| 0004 | `20260803090300_templates_and_campaigns.sql` | ✅ yes |
| 0005 | `20260803090400_email_logs_and_replies.sql` | ✅ yes |
| 0006 | `20260803090500_settings.sql` | ✅ yes |
| 0007 | `20260803090600_dashboard_views.sql` | ✅ yes |
| 0008 | `20260803090700_rls_policies.sql` | ✅ yes |
| 0009 | `20260803100000_restrict_viewer_dashboards.sql` | ✅ yes |
| 0010 | `20260803100100_integrations.sql` | ✅ yes |
| 0011 | `20260803110000_remove_n8n_add_sheet_writeback.sql` | ✅ yes (verified 2026-08-03) |
| 0012 | `20260803120000_review_pipeline_and_versions.sql` | ✅ yes |
| 0013 | `20260803120100_public_stats_views.sql` | ✅ yes |
| 0014 | `20260803120200_analytics_views.sql` | ✅ yes |
| 0015 | `20260804120000_verification_versions_and_public_leads.sql` | ❌ **NOT YET** |
| 0016 | `20260804140000_inbound_messages.sql` | ❌ **NOT YET** |
| 0017 | `20260804160000_verify_on_send_and_board.sql` | ❌ **NOT YET** |
| 0018 | `20260804180000_schedule_followups_for_backfilled_sends.sql` | ❌ **NOT YET** |
| 0019 | `20260804200000_sheet_date_sent_is_authoritative.sql` | ❌ **NOT YET** |
| 0020 | `20260804220000_outreach_run_budget.sql` | ❌ **NOT YET** |
| 0021 | `20260805100000_research_complete_any_field.sql` | ❌ **NOT YET** |

**To apply 0015:** paste `supabase/schema-update-5-verification-and-public-leads.sql` into
the Supabase SQL editor and Run. Idempotent, includes both backfills.

**To apply 0016:** then paste `supabase/schema-update-6-inbound-mail.sql`. Without it the
Replies page errors, `/api/inbound/reply` cannot store anything, and the auto-reply trigger
bug below is still live.

**To apply 0017:** then paste `supabase/schema-update-7-verify-on-send.sql`. Without it the
Verified column and filter on the leads list are empty, and leads already emailed still
read as unverified.

**To apply 0018:** then paste `supabase/schema-update-8-schedule-followups.sql`.

**To apply 0019:** then paste `supabase/schema-update-9-date-sent-authoritative.sql`.

**To apply 0020:** then paste `supabase/schema-update-10-run-budget.sql`.

**To apply 0021:** then paste `supabase/schema-update-11-research-any-field.sql`.

### "Unverified" is not "has no address"

A lead with no email address counts as `unverified`, because there is nothing to verify. In
this dataset **every** unverified lead was that case: 308 with no address, 0 with an
unchecked one. So the Settings tile read 308 while the export produced 184, promising work
the download could not deliver.

`getVerificationCounts()` now returns them separately — `noAddress`, `exportable` (never
checked AND has an address) and `inconclusive` (catch-all + unknown). A tile that counts one
thing and a button that delivers another is worse than no tile.

**The export defaults to never-checked only.** It used to include `unknown` and `accept_all`
on the theory that a re-run might resolve them, which re-bills every one of those addresses
on every export — and a catch-all domain returns catch-all every single time. Re-checking is
now an explicit `?recheck=1` button.

Apply them in order. 0017 rewrites `pipeline_board`, which 0015 created.

### Two definitions of "approved" — do not add a third

`lead_pipeline.approved` is derived from `leads.status`. The scheduler, immediately before
an initial send, instead requires the **active `email_versions` row** to have
`status = 'approved'`.

They can disagree, and they did: 58 leads showed `pipeline.approved` while zero versions
were approved, so the dashboard would report leads as Ready to Send and the sender would
skip every one of them with "waiting for approval", with nothing on screen explaining it.

The rule: **approving a lead must set both.** `approveVersion()` already did.
`bulkSetStatus(ids, 'approved')` did not, and now routes to `bulkApproveDrafts()`, which
approves the version (whose trigger sets the pipeline flag) and then the lead status. The
`ready_to_send` view and the dashboard card both intersect the two conditions, so the number
cannot promise something the sender will not do.

### Who owns the send date

`leads.last_contacted_at` carries the sheet's **Date Sent**, and it is the anchor the entire
follow-up schedule hangs off. Two rules, set in 0019:

1. A send **this CRM** made — an `email_logs` row with a `sent_at` — is authoritative. The
   sheet may never move it.
2. Otherwise the **sheet wins**, because for an upstream send its Date Sent column is the
   only record that exists.

`followup1_due` is re-derived whenever the date moves, or correcting a send date would leave
the schedule pointing at the old one. It is never moved once the follow-up has actually gone.

`last_contacted_at` is therefore in `REFRESHABLE_FIELDS`, the one deliberate exception to
"pipeline state is excluded". Without it a corrected Date Sent syncs into nothing.
`diffFields()` skips blank cells, so an empty Date Sent cannot erase a send the CRM recorded.

The write-back sends **date only** (`YYYY-MM-DD`), not an ISO timestamp: the importer's
normalizer handles that form, Excel serials and `DD-MM-YYYY`, so the value round-trips.

**"Email draft Status" was removed from the sheet on 2026-08-04** and its mapping is gone
from both directions. Nothing read it — `deriveStatus()` uses the presence of a draft body,
which is a fact rather than a label someone has to remember to update.

### A send recorded outside the CRM must still schedule its follow-up

`followup1_due` is set by the `email_logs` trigger. Sends made upstream have no `email_logs`
row — 0015 writes `first_email_sent` directly — so their due date stayed NULL and
`compute_next_step()` parked them on `await_followup1` permanently while the cron reported
nothing to do. 0018 makes `sync_pipeline_from_lead()` schedule it too, and backfills.

Until then: `email_verification_status` does not exist, so `npm run emails:import` fails,
the dashboard's "Dead Addresses" card and the `awaiting_verification` view error, and the
public lead list and industry analytics keep their old behaviour.

There is no CLI on this machine (`supabase` and `psql` are both absent), so applying
migrations is a paste-into-the-SQL-editor job. That is the established workflow here.

### Applied migrations are immutable

0010 originally created the n8n keys. Once it had been applied to the live database it
could not be edited 0011 removes them instead. **Never edit a migration that has run.**
Add a follow-up; that file is the record of the change.

(0010 still carries a note pointing at 0011, so the pairing is obvious when reading it.)

### Four generated SQL files keep them in sync

- `supabase/schema.sql` every migration, for a fresh project.
- `supabase/schema-update-2-integrations.sql` 0009 + 0010.
- `supabase/schema-update-3-remove-n8n.sql` 0011 only.
- `supabase/schema-update-4-review-workflow.sql` 0012 + 0013 + 0014.

All **generated**. Add a migration → regenerate. Never hand-edit them.

### Verifying what is actually applied

Do not guess. Probe the live database:

```ts
// A HEAD request (`{ head: true }`) swallows the error and reports nothing —
// use a real select, and always include a known-bad control.
const { error } = await db.from('some_table').select('*').limit(1);
const exists = !error;
```

---

## 3. The security model the part you must not break

Three independent layers. Each alone would be a bug; together they fail closed.

**Layer 1 middleware (`src/proxy.ts`).**
Runs before every non-static request. Redirects anonymous users to `/login` (preserving
`?next=`), and blocks non-admins from `ADMIN_PREFIXES`.

> Next 16 renamed the convention: `proxy.ts` / `export function proxy`, not
> `middleware.ts` / `middleware`. Same edge hook, same `config.matcher`.

**Layer 2 page and action guards (`src/lib/auth/session.ts`).**
`requireAdmin()` in pages, `assertAdmin()` in Server Actions.
**Middleware does not run for Server Actions.** An action without `assertAdmin()` is
directly callable by any authenticated user. This is the layer people forget.

**Layer 3 Row Level Security.**
Every table has RLS enabled; every policy requires `public.is_admin()`. A viewer who
reaches an admin query gets zero rows.

### Why viewers read views, not tables

RLS is *row*-level. It cannot express "may read `leads.status` but not `leads.email`". So
viewers get **no row access** to `leads`, `templates`, `replies`, `email_logs` or
`settings`. Statistics reach them through the `dashboard_*` views, which run with their
owner's privileges (`security_invoker = false`) and therefore bypass the base tables' RLS.

**That is why adding a column to a `dashboard_*` view is a security decision.** None of
them uses `select *`, on purpose.

### Two traps in this design

1. **Never add `FORCE ROW LEVEL SECURITY`.** It would subject the views' owner to RLS, and
   since every policy requires `is_admin()`, every viewer dashboard would silently return
   zero rows. Documented at the top of migration 0008.
2. **Supabase's linter flags these as "Security Definer View".** That is intended. Ignore
   it. The warning you must *never* ignore is "RLS has not been enabled on public.X".

### The `/stats` exception anon can read exactly five views

Migration 0013 **deliberately breaks** the "anon gets nothing" invariant, for five views
and nothing else:

```
public_stats_overview        public_stats_stages     public_stats_statuses
public_stats_activity_daily  public_stats_campaigns
```

They carry no `is_admin()` gate and are granted `select` to `anon`. That is what makes the
login-free `/stats` page possible. Everything protecting the data now lives in **what
those views select**, so:

- Aggregates only. Never a lead id, business name, website, email, phone, city, note,
  research paragraph, draft, subject line or reply body. A count grouped by
  `business_name` is a list of business names with extra steps.
- Campaign **names** are the one identifier present. They are our labels for our
  campaigns, not prospect data, and "Campaign Performance" was explicitly in the brief.
- Column lists are written out. `select *` over a base table is how a column added later
  quietly becomes public.

**Adding a column to any `public_stats_*` view is a disclosure decision.** If you are not
certain it is aggregate-only, put it in a `dashboard_*` view instead, where `is_admin()`
applies.

#### The one view that can name businesses: `public_stats_leads`

Migration 0015 added a view that CAN publish individual businesses name, city, country,
industry and stage, and nothing else. It is **default-denied twice over**:

1. `public.show_leads` is `false`, and
2. `public.lead_stages` is `[]`.

Turning the switch on with an empty stage list still discloses nothing. Both are read
inside the view as inline sub-selects rather than through `setting_bool()`, because that
helper is SECURITY DEFINER and its EXECUTE grant is deliberately withheld from `anon`.

The control is Settings → Public page. Its stage checkboxes submit alongside a hidden
`public-stages-present` marker: an unticked checkbox is simply absent from FormData, so
without the marker, clearing the last box would be indistinguishable from "this form was
not on screen" and the stage would silently stay public.

#### `/` is the public front page

`src/app/page.tsx` renders `PublicStatsPage` (in `app/stats-page.tsx`) rather than
redirecting to `/dashboard`, so a visitor with no account sees the pipeline instead of a
login wall. `/stats` is kept as a redirect for old links. `'/'` is in `PUBLIC_PATHS`; the
matcher tests `pathname === p` first and `startsWith(p + '/')` second, and for `'/'` that
second test is `startsWith('//')`, which never fires so this opens the front page exactly
and nothing beneath it.

`src/lib/data/public-stats.ts` reads these with a **plain anon client** not the
service-role client, not the cookie-bound SSR client. That is the point: the service-role
key would make one mistyped table name a breach, and the SSR client would render a
different page for an admin than for a visitor. With the anon key, Postgres grants make
the module *incapable* of leaking, rather than merely careful.

### Current viewer scope: nothing

Migration 0009 changes all 11 `dashboard_*` views from `is_app_user()` to `is_admin()`, and
`/dashboard` renders a "limited access" state for non-admins. This is default-deny while
the user decides what viewers should see.

**When that spec arrives:** add a new, narrowly-scoped view for the viewer role. Do **not**
relax the admin views back to `is_app_user()`.

### Credentials

Two stores, deliberately separate:

- `public.settings` non-secret config (hosts, ports, URLs, sheet id, from address).
- `public.integration_secrets` credentials, **AES-256-GCM encrypted in the application**
  before they reach Postgres. RLS on with **zero policies**, and all grants revoked from
  `anon` *and* `authenticated` no browser token can read it, not even an admin's. Server
  code reaches it via the service-role client after its own `assertAdmin()`.

Secrets are write-only from the UI: set/replace only, never read back. The client sees a
`configured` flag and a `••••abcd` hint.

`APP_ENCRYPTION_KEY` (32 random bytes, base64) is required. Losing it means re-entering
every credential.

### Verified behaviour (tested against the live DB)

| Check | Result |
| --- | --- |
| Anonymous anon-key request to any table or `dashboard_*` view | **401** (not an empty array) |
| Anonymous anon-key request to `public_stats_*` | 200 intended, see above |
| Viewer `select` on leads / templates / settings | 0 rows |
| Viewer on `/leads`, `/settings`, … | 307 → `/unauthorized` |
| Admin on all 7 routes | 200 |
| `APP_ENCRYPTION_KEY` → encrypt → upsert `integration_secrets` → read back → decrypt | round-trips (2026-08-03) |
| Temp admin session → `GET /settings` | 200 |
| Temp admin session → `POST /settings` with a bogus `Next-Action` id | 404, **not** a `use server` module-evaluation 500 (2026-08-03) |
| Brevo relay: `nodemailer.verify()` against `smtp-relay.brevo.com:587` with the stored credentials | authenticated (2026-08-03) |

---

## 4. Data model

```
profiles     id (=auth.users.id), role (admin|viewer), full_name
leads        identity · pipeline status · research · draft · notes · scheduling
             dedupe_key UNIQUE  ← makes every import/sync idempotent
             sheet_row_number   ← provenance back to the Google Sheet row
templates    name, subject, body, variables[]
campaigns    name, active, daily_limit, template_id, window
email_logs   lead_id, status, provider, message_id, sent_at, error
replies      lead_id, reply_text, sentiment, is_handled, received_at
settings     key → jsonb value, is_sensitive
integration_secrets  key → ciphertext (service-role only)
integration_runs     integration, action, status, stats, timings

email_versions  lead_id, type, version_number, subject, content, status, active,
                generated_by, reviewed_by/at, review_note
                UNIQUE (lead_id, type, version_number)
                partial UNIQUE (lead_id, type) WHERE active
lead_pipeline   lead_id PK, current_stage (DERIVED), 4 gate flags + their _at stamps,
                first_email_sent, followup1_due/sent, followup2_due/sent,
                replied, closed, closed_reason, auto_followups
lead_activity   lead_id, kind, summary, detail, actor_id  (append-only audit)
```

`lead_status`: `new · researching · ready · approved · sending · sent · replied · bounced ·
invalid · archived`.

### The pipeline is derived, not stored the rule that matters most now

`lead_pipeline.current_stage` and the Next Step are **computed in Postgres**:

| | Where | Kind |
| --- | --- | --- |
| Stage | `public.compute_pipeline_stage(lead_pipeline)` | `IMMUTABLE`, run by a BEFORE trigger on every write |
| Next step | `public.compute_next_step(lead_pipeline)` | `STABLE` (compares a due date to `now()`), exposed by the `pipeline_board` view |

**Never re-implement either in TypeScript.** `src/lib/pipeline/labels.ts` holds labels,
hints, tones and icons presentation only. If you catch yourself writing an `if` that
picks a stage in TS, it belongs in a migration: two implementations of one rule is how the
board and the scheduled sender start disagreeing about what a lead needs.

`current_stage` is absent from the `Insert`/`Update` types on purpose writing it does
nothing, the trigger overwrites it.

The pipeline is a **projection of facts**, kept current by four triggers:

| Trigger source | Sets |
| --- | --- |
| `leads` (email, research_summary, draft_email, status) | `email_found`, `research_complete`, `draft_ready`, `approved` |
| `email_versions` (status, active) | `draft_ready`, `approved` |
| `email_logs` (status, sent_at) | `first_email_sent` / `followup1_sent` / `followup2_sent` **and the next due date** |
| `replies` (insert) | `replied` (first reply wins) |

Two consequences worth knowing:

1. **Evidence only ever turns a flag ON.** A blanked research field does not un-complete
   research, because an admin may have marked the stage complete deliberately. Only an
   explicit UPDATE from the review UI clears one. Getting this backwards would make the
   "Mark complete" button silently undo itself on the next save.
2. **Sends advance the pipeline via `email_logs`, never from the sending code.** The Send
   button, the cron sender and any future webhook reconciliation all move the lifecycle
   identically, and none of them has to remember to.

Clearing a gate flag must also clear its `_at` stamp `gateFlagPatch()` in
`lib/services/outreach/pipeline.ts` does this. The stamping trigger only fills a NULL, so
without it, un-approving and re-approving would keep the original `approved_at` and
"average approval time" would measure the wrong interval.

### Email verification (migration 0015)

`lead_pipeline.email_verification_status` is an enum, not a boolean, because that is what a
verifier actually returns:

| Value | Meaning | Effect |
| --- | --- | --- |
| `unverified` | never checked | default |
| `valid` | deliverable | `email_verified := true` |
| `invalid` | guaranteed bounce | `email_verified := false` **and the stage falls back to `need_email`** |
| `accept_all` | catch-all domain the check proved nothing | recorded, **not** auto-verified |
| `unknown` | verifier gave up | recorded, not auto-verified |

Collapsing `accept_all` into true or false throws away exactly the distinction that decides
whether it is safe to send, which is why the column is not a boolean.

An `invalid` lead keeps `leads.email`. Knowing which address was tried and failed is worth
more than a tidy row, and the stage already says a new one is needed.

**A successful send verifies the address** (0017). The relay accepted it and no bounce came
back, which is stronger evidence than a probe. The self-correcting half is what makes that
safe to assert: a hard bounce (0016) revises it to `invalid`. An existing `invalid` is never
overwritten, because a verifier that says the address is dead outranks a relay that merely
agreed to try.

Two front doors, same services underneath, so a CSV handled either way produces identical
state:

- **Browser** Settings, Email verification. The download button hits
  `GET /api/admin/emails/unverified.csv`; the upload runs `uploadVerificationCsv`.
- **Terminal** the npm scripts below.

The leads list has a `Verified` column and a `?verify=` filter (`/leads?verify=invalid`).
Verification and a named `?view=` intersect rather than override each other, so "awaiting
verification AND dead" is a sensible combination.

The round trip is deliberately API-free, with no verifier credentials, no bill and nothing
to leak:

```bash
npm run emails:export                       # unverified-emails.csv
# upload to NeverBounce / ZeroBounce / Bouncer, download their result
npm run emails:import -- --file=result.csv --dry-run
npm run emails:import -- --file=result.csv
npm run emails:status
```

`normaliseVerificationStatus()` accepts every spelling the common tools use (`catchall`,
`catch-all`, `accept_all_unverifiable`, `deliverable`, `undeliverable`, …), so whichever
service the operator picked, the same import works. Export includes `unknown` and
`accept_all` alongside `unverified`: a re-run often resolves them, and it de-duplicates by
address because verifiers bill per address, not per lead.

### Drafts are never overwritten

`email_versions` is append-only in practice. Editing a draft **inserts** a version;
regenerating **inserts** a version. Nothing in `lib/services/email-versions.ts` UPDATEs
`content` or `subject`. Rejecting keeps the row and its text a rejected draft is often
the most useful thing in the history.

- `version_number` is assigned by a BEFORE INSERT trigger when omitted, so two concurrent
  saves cannot both compute the same `max()+1`.
- Exactly one version per `(lead, type)` is `active`, enforced by a partial unique index.
  The trigger that clears the previous one is **BEFORE**, not AFTER: a plain unique index
  is checked the instant the row hits the heap, so an AFTER trigger would never run the
  insert would already have failed with 23505.
- The active `initial` version is **mirrored** onto `leads.subject_line` / `draft_email` by
  a trigger. `email_versions` is the system of record; that copy exists so the sender, the
  Sheets write-back and the `dashboard_*` views (which predate versioning) kept working
  without changes. Follow-ups live only in `email_versions`.
- The reverse direction exists too: `version_lead_draft()` turns a draft arriving on
  `leads.draft_email` (from the sheet sync or the workbook importer, neither of which knows
  about versioning) into a version. **The two triggers face each other, so the loop-breaker
  is load-bearing**: it compares the incoming text with the active version's content and
  stops when they match. Identical text is the mirror writing back; different text is a
  genuine upstream edit and becomes the next version.

  This was added in 0015 after the 0012 one-time backfill left 145 leads holding a draft
  with no version the review screen reported "no draft yet" for leads that plainly had
  one. A trigger cannot drift the way a backfill did.

### Inbound mail (migration 0016)

Transport is a **Cloudflare Email Worker** (`cloudflare/email-worker.js`), because
Cloudflare Email Routing forwards mail and does not host a mailbox, so there is no IMAP
server to poll. The Worker forwards to the human inbox and POSTs to
`/api/inbound/reply`. It parses no meaning and matches nothing.

All attribution happens in `lib/services/inbound/`, next to `email_logs`:

| Step | Rule |
| --- | --- |
| 1. Store | Always, before classifying. A message we cannot understand must still be visible, not dropped. |
| 2. Classify | Bounce, then auto-reply, then reply. |
| 3. Attribute | **Threading first**: `In-Reply-To`/`References` against `email_logs.message_id`. Then From address, but **only when exactly one lead matches** — this dataset has leads sharing an address, and picking one would be a coin flip presented as fact. Then unmatched. |
| 4. Record | Only a matched, genuine reply becomes a `public.replies` row. |

**Threading is not merely more accurate, it is the only method that works in the normal
case**: you mail `info@company.com` and the owner answers from their personal address.
From-address matching loses that reply entirely.

Two tables, two meanings, same distinction as `email_logs` vs `lead_pipeline`:
`inbound_messages` is everything that arrived; `public.replies` is genuine replies from
known leads, and it is what drives the pipeline and every rate. Bounces and autoresponders
never reach it.

**A hard bounce is free verification.** 5.x.x sets `email_verification_status = 'invalid'`,
which sends the lead back to `need_email`. 4.x.x (mailbox full, greylisted) changes
nothing — treating a full mailbox as a dead address throws away a good lead. No status
code is read as soft, because the cautious reading is the one that does not delete work.

**Unsubscribe is terminal**: it closes the workflow and sets `auto_followups = false`. The
`replied` stamp alone only changes the next step.

Sentiment is rules first (`inbound/classify.ts`), and only the ambiguous middle goes to
Ollama (`ai/classify-reply.ts`, temperature 0, 20s timeout). A model outage degrades the
classification instead of blocking ingestion.

Manual assignment goes through the **same** `createReply()` as automatic ingestion, so a
hand-assigned reply produces identical state. A second insert path would be a second
definition of "a reply happened".

#### The auto-reply trigger bug

`sync_pipeline_from_reply()` used to set `lead_pipeline.replied` for **any** row in
`public.replies`. Out-of-office is the single most common thing cold outreach gets back, so
the moment inbound mail started arriving, every autoresponder would have marked its lead as
having answered and permanently stopped that sequence. 0016 makes the trigger ignore
`auto_reply` and clears the flag for any lead whose only replies were automatic.

Under the current design an auto-reply never reaches `public.replies` at all — but a rule
enforced only by the code that happens to call it is not enforced, so the trigger holds it
too.

### What `email_logs` means, and what it does not

`email_logs` is evidence that **this CRM** sent something. It is written only by
`sendLeadEmail()`. Sends made upstream (n8n, by hand, anything else) never appear there,
and nothing fabricates rows in it corrupting the one table that is supposed to be proof
of our own sending would be worse than a gap.

`lead_pipeline` answers the other question: **was this lead emailed at all**, by anyone.
The sheet's "Email sent status" column feeds it through `sync_pipeline_from_lead()`.

Get these two backwards and the analytics lie. That is exactly what happened: 58 leads were
sent upstream, so `analytics_industry_performance` (counting `email_logs`) reported 0 while
the status counts said 58. It now reads `lead_pipeline`. **When adding an analytics view,
pick the source by the question being asked** "what did we send" is `email_logs`, "what
happened to this lead" is `lead_pipeline`.

### Lead identity (the single most important rule)

One definition, in `src/lib/import/dedupe.ts`, used by **both** the workbook importer and
the Google Sheets sync:

```
email:<normalised email>   preferred
site:<host+path>           when there is no usable email
name:<name>|<city>         last resort
```

Stored in `leads.dedupe_key` with a UNIQUE index. Inserts use
`ON CONFLICT DO NOTHING ... RETURNING`, so the database itself reports which rows were new
exact counts, and safe against two syncs running concurrently.

**Never write a second identity rule.** If the sync and the importer disagree, they will
create duplicates of each other's rows.

---

## 5. Directory map

```
supabase/
  migrations/        source of truth, filename order
  schema.sql         generated: all migrations
  schema-update-2-integrations.sql       generated: 0009 + 0010
  schema-update-3-remove-n8n.sql         generated: 0011
  schema-update-4-review-workflow.sql    generated: 0012 + 0013 + 0014
  seed.sql           starter template + campaign
  config.toml        local CLI config

vercel.json          declares the hourly cron that hits /api/cron/outreach

scripts/
  import-leads.ts    workbook import CLI (tsx)

src/
  proxy.ts           route-protection middleware (Next 16 naming)

  app/
    layout.tsx       Inter via next/font + pre-paint theme script
    page.tsx         redirects to /dashboard
    login/           page · client form · signIn/signOut actions
    unauthorized/
    stats/           PUBLIC statistics page no session, anon client only
    api/
      admin/leads/[id]/regenerate/  POST { type } → new version (assertAdmin)
      cron/outreach/                scheduled sender (CRON_SECRET bearer)
    (app)/           authenticated shell (sidebar + topbar)
      layout.tsx     requireUser() → AppShell
      dashboard/     operational widgets; viewers get ViewerRestricted
      analytics/     page + volume-chart (resolution toggle)
      leads/
        (list)/      table + Stage/Next Step columns  ← loading.tsx lives HERE
        [id]/        page · lead-detail · research-panels · draft-workspace ·
                     pipeline-panel
      campaigns/ templates/ email-logs/ replies/
      settings/      integrations-panel · automation-panel · settings-form

  components/
    ui/              primitives: button card input badge dialog table skeleton toast
    shell/           app-shell · sidebar · topbar · nav-config
    integrations/    trigger-button (run status) · secret-field (write-only)
    action-form.tsx  useActionFeedback / useAsyncAction / PanelError
    pipeline-badge.tsx  StageBadge · NextStepBadge · PipelineTracker
    data-table.tsx   generic: sortable, selectable, resizable columns
    charts.tsx       dependency-free SVG + hidden <table> fallback; LineChart,
                     MultiLineChart (shared scale), BarList
    metric-card · status-badge · empty-state · confirm-dialog · pagination · theme-toggle

  lib/
    env.ts               lazy, guarded env access (+ getCronSecret → null when unset)
    pipeline/labels.ts   stage/next-step LABELS ONLY the logic lives in SQL
    auth/session.ts      requireUser / requireAdmin / assertAdmin
    supabase/
      client.ts          browser
      server.ts          server components / actions (RLS applies)
      service-client.ts  service-role factory NO 'server-only' marker
      admin.ts           re-export WITH 'server-only', for app code
      database.types.ts  hand-maintained schema types
    data/                read queries: dashboard · leads · misc · admin-dashboard ·
                         analytics · public-stats (anon client)
    actions/             server actions: leads · misc · integrations · review
    services/            the only code that talks to the outside world
      config.ts          typed reader for non-secret settings (sheets/email/ai/outreach/sending)
      secrets.ts         AES-256-GCM encrypted credential store
      activity.ts        lead_activity writer (best-effort)
      email-versions.ts  create / activate / review never overwrites
      integration-runs.ts run history
      google-sheets.ts   Sheets reader + OAuth token (API key / service account)
      sheet-sync.ts      sync engine (sheet → CRM) reuses lib/import
      sheet-writer.ts    write-back (CRM → sheet row), takes a SyncSnapshot
      sync/              MODULAR OUTBOUND SYNC: types · google-sheet-target · index
      ai/                types · prompt · template-generator · ollama · index
      outreach/          pipeline.ts (reads/asserts) · scheduler.ts (the sender)
      email/             types · smtp · gmail · index (factory) · render ·
                         send-lead-email
    import/
      workbook.ts normalize.ts dedupe.ts mapping.ts importer.ts
```

---

## 6. Conventions

**Dashboard figures are links, and the link must match the number.** Every widget count and
its drill-through resolve through the same named view in `LEAD_VIEWS`
(`lib/data/leads.ts`), reached as `/leads?view=<name>`. A card reading 114 that opens a page
of 97 is worse than no card, so when adding a widget, add its view there rather than
hand-rolling a second query.

**Tables are `table-fixed`.** Under the default `auto` layout a browser sizes columns to
their widest cell and treats an explicit `width` as a suggestion, which is why dragging a
column narrower than its longest value used to do nothing. `fixed` makes the declared width
authoritative, so `TD` must be able to clip it sets `overflow-hidden` and truncates.
Resize bounds are `MIN_COLUMN_WIDTH` (72px, about eight characters) and `MAX_COLUMN_WIDTH`
(900px) in `data-table.tsx`. Do **not** re-add `minWidth` alongside `width` on the `TH`:
that was the original floor that made narrowing impossible.

**Adding an admin route** do all four:
1. `requireAdmin()` at the top of the page.
2. `assertAdmin()` at the top of every Server Action it calls.
3. Add the prefix to `ADMIN_PREFIXES` in `src/proxy.ts`.
4. Add the nav entry to `src/components/shell/nav-config.ts` with its allowed roles.

`nav-config.ts` roles control **rendering only**. Hiding a link is a courtesy, never a lock.

**Server Actions** return `ActionResult { ok: boolean; message: string }` (defined in
`lib/actions/leads.ts`). They never throw at the UI; they return a message the toast shows.

A `'use server'` module may export **async functions only**. `type` and `interface`
exports are fine (erased at compile time); a constant, array or object is not it breaks
every action in the file, not just itself. Shared values live in a plain module both sides
import, e.g. `lib/templates/placeholders.ts`.

**The UI never calls an external API.** Client → Server Action → service in `lib/services/`.
That keeps credentials server-side and gives one place to record run history.

**Types.** `src/lib/supabase/database.types.ts` is hand-maintained. Change it in the same
commit as the migration. It declares `Relationships: []`, so **PostgREST embedded selects
(`leads(business_name)`) will not type-resolve** use a second query and join in JS, as
`lib/data/misc.ts` does.

**Styling.** Semantic CSS variables only (`bg-surface`, `text-muted-foreground`,
`border-border`). Never a raw hex in a component. Both themes are defined in
`globals.css`; `@theme inline` maps them into Tailwind.

**Branding.** The logo is `public/logo.png` (full lockup) and `public/logo-mark.png` (gear
mark only). Render it through `components/brand.tsx` `BrandMark` / `BrandLockup` never
with a bare `<Image>`: the source PNG **has no alpha channel**, so its background is solid
white, and those components put it on a white tile so a dark theme shows a deliberate tile
rather than a ragged white square.

Icons and social cards come from Next's **file conventions** in `src/app/`: `icon.png`,
`apple-icon.png`, `opengraph-image.png`, `twitter-image.png`. Next emits the tags itself
with hashed URLs, so do **not** also declare `icons` or `openGraph.images` in
`layout.tsx` you would get duplicate tags that disagree after the next asset change.
`metadataBase` (from `NEXT_PUBLIC_SITE_URL`, else the Vercel host, else localhost) is what
makes the relative image paths absolute, which scrapers require.

Regenerating those derivatives after a logo change (sharp ships with Next; two gotchas —
sharp applies `trim()` *before* `extract()` and resizes the base *before* `composite()`, so
each needs its own pass):

```
mark:  extract {left:0, top:90, w:1254, h:690} -> trim -> pad 8% to a square -> resize
og:    1200x630 white canvas <- composite(trim(logo) resized to height 470, centre)
```

**Accessibility (load-bearing, not decoration).** Status is never colour alone badges pair
colour + icon + text. Charts ship a visually-hidden `<table>`. Sortable headers set
`aria-sort`; nav sets `aria-current`. Focus rings are global and never removed.
`prefers-reduced-motion` is honoured globally.

**Placeholders must be honest.** A button that does nothing says so in its toast. Never
render an editable field that silently goes nowhere.

**Outbound changes go through `lib/services/sync`, never straight to a target.** Actions
call `syncLeadChange(leadId, fields)` and fold the result in with `appendSyncMessage()`.
One decision point for "does this change need pushing", and adding a destination is a new
`SyncTarget` plus one line in the registry no caller changes.

**The review workspace is many small forms, not one big one.** Research, personalization,
each draft and notes each save independently. A single "Save everything" form would mean
an admin fixing a typo in the notes also re-submits a draft they were still thinking
about.

---

## 7. Gotchas that will cost you an hour

| Trap | What happens | Fix |
| --- | --- | --- |
| `loading.tsx` at `leads/` | Its Suspense boundary covers `leads/[id]` too, so that route starts streaming (commits HTTP 200) before `notFound()` runs a missing lead renders the not-found page with **status 200** | Keep it in the `(list)` route group |
| `setState` in a mount effect | `react-hooks/set-state-in-effect` error (React Compiler lint) | `useSyncExternalStore` for external state (see `use-persisted-state.ts`), or adjust state during render |
| Accessing a ref during render | "Cannot access refs during render" | Do it in an effect, or restructure so it is unnecessary |
| `import 'server-only'` in a CLI script | Throws under plain Node the package's default export throws | Import `service-client.ts`, not `admin.ts` |
| Exporting a non-component value from a `'use client'` module and importing it in a Server Component | You get a client-reference proxy, not the value | Put it in a plain module (`theme-script.ts`) |
| `.select('*', { head: true })` for existence checks | Returns **no error** for a non-existent table | Use a real `.select('*').limit(1)`, and test a known-bad control |
| PowerShell `Get-Content`/`Set-Content` round-trip on source files | Mangles UTF-8 (em dashes → mojibake) | Use the Write/Edit tools |
| Next 16 + TypeScript 7 | "does not provide the compiler API required by Next.js" | Stay on TypeScript 6 |
| ESLint 10 + `eslint-config-next` | `eslint-plugin-react` crashes despite the `>=9` peer range | Stay on ESLint 9 |
| `.or()` with unsanitised user input | Commas/parens break out of the filter expression | `sanitizeSearch()` in `lib/data/leads.ts` strips `,()\` and `%_` |
| A component that renders a `<form>` used inside another form | `<form> cannot be a descendant of <form>` hydration error, inner submit undefined | Take plain args and call the action from a click handler (see `secret-field.tsx`) |
| Editing an already-applied migration | Files and live database silently diverge | Add a follow-up migration instead |
| **Exporting a non-async value from a `'use server'` file** | `A "use server" file can only export async functions, found object.` The **whole module fails to evaluate**, so *every* action in it 500s including ones that have nothing to do with the offending export. The stack points at the generated action loader, never at the real culprit, and the browser just says "Could not reach the server" | Move the value to a plain module and import it from both sides (`lib/templates/placeholders.ts` exists for exactly this). `type`/`interface` exports are fine they are erased |
| **A Server Action toasting "Could not reach the server"** | The action did not fail every action catches and *returns*. The POST itself 500'd or 404'd. Check the **server** log, not the browser | Usually the row above. Otherwise a dev server that recompiled while the page stayed open, leaving stale action ids: reload the page |
| An AFTER trigger that clears a sibling before a partial UNIQUE index | Never runs the index is checked the instant the row hits the heap, so the INSERT already failed with 23505 | Use a BEFORE trigger (see `enforce_single_active_version`) |
| `ON CONFLICT DO UPDATE SET x = coalesce(public.tbl.x, excluded.x)` | Schema-qualifying the target is a syntax error | Alias the target: `insert into public.tbl as p ... set x = coalesce(p.x, excluded.x)` |
| Writing `current_stage` on `lead_pipeline` | Silently ignored the BEFORE trigger recomputes it | Set the gate flags; the stage follows |
| Reading `/stats` data with the service-role client | Turns one typo into a data breach on a page anyone can load | Use the plain anon client (`lib/data/public-stats.ts`); Postgres grants then make a leak impossible |
| Ollama streaming by default | Returns NDJSON, `JSON.parse` chokes halfway through | `stream: false` in the request body |
| `round(avg(x), 1) filter (where …)` | `42809: FILTER specified, but round is not an aggregate function` FILTER binds to the aggregate, not to a function wrapping it | `round((avg(x) filter (where …))::numeric, 1)` see `analytics_funnel_timing` |
| Adding a column anywhere but the END of an existing `create or replace view` | `42P16: cannot change name of view column "x" to "y"`. Replace can only **append**; inserting a column reads as renaming the one already in that position | `drop view if exists …;` then `create view …`. Add `cascade` only if something depends on it check first, because cascade silently drops dependents too |

---

## 8. Integrations

All services live in `src/lib/services/` and are called only from Server Actions in
`src/lib/actions/integrations.ts` (or `review.ts`), or from the cron route handler.

**Google Sheets** (`google-sheets.ts`) reads a whole tab. Two auth modes: API key (public
sheet) or service account (private sheet; JWT signed with `node:crypto` no `googleapis`
dependency). Requests `UNFORMATTED_VALUE` so dates arrive as Excel serials that the existing
normalizer already handles. The OAuth scope is the read/write `spreadsheets` scope, not
`.readonly`, because the same token drives write-back.

**Sheets write-back** (`sheet-writer.ts`) pushes CRM edits back to the originating row.

- **Requires service-account auth with Editor access.** An API key is read-only and can
  never authorise a write; `saveIntegrationConfig` refuses the api_key + write_back
  combination rather than letting every save fail with a 403.
- Targets `leads.sheet_row_number`. Leads with no row number (workbook imports, manual
  entries) are skipped, not errors.
- Maps values onto columns by matching normalized headers, with **several candidate headers
  per value** (`follow-up 1` / `followup 1` / `follow up 1`) because the sheet is written
  by a process outside this codebase and its headers drift. A value whose headers are all
  absent is skipped **columns are never created**.
- Now writes status, stage, next step, notes and both follow-up drafts as well as the
  original identity/research/initial-draft columns.
- `undefined` from a value resolver means "nothing to say" and leaves the cell alone;
  `null` means the admin cleared it and blanks the cell. A follow-up that was never drafted
  must not wipe a column somebody filled in upstream.
- Uses `valueInputOption: RAW`, so a draft starting with `=` or `+` lands as text instead of
  being evaluated as a formula.
- Best-effort, and reached only through the sync layer. A Sheets failure never makes the
  database write look like it failed; the outcome is appended to the toast so a silent
  failure is impossible.

**Sheet sync** (`sheet-sync.ts`) reuses `lib/import/mapping.ts` for validation and
identity. Reports Imported / Updated / Skipped / Invalid / duplicates-in-sheet. A blank
cell never erases existing CRM data. Pure function of (sheet, database), so a cron route
can call it exactly as the button does. **Nothing polls.**

**Email** (`email/`) `EmailProvider` is `verify()` + `send()`. One provider active at a
time via the `email.provider` setting. SMTP uses any relay; Gmail uses an App Password over
`smtp.gmail.com:465` (no OAuth consent screen for a single owned mailbox). Adding Resend or
SendGrid = one new class + one line in the factory; no caller changes.

**Placeholder guard a draft with unfilled placeholders cannot be sent.**

`findUnresolvedPlaceholders()` in `email/render.ts` runs inside `sendLeadEmail()`, *after*
rendering. That location is the point: it is the one function every send path goes through
the Send button, the API and the cron sender so the automation is covered too, which is
exactly the case where nobody is watching. The review UI shows the same warning early and
disables Send, but that is convenience; the block is server-side.

It catches two shapes:

- `{{unknown}}` a token `renderPlaceholders` left verbatim because it has no value.
- `[Title Case]` or `[oneword]` the human/AI "fill this in" convention. **The renderer
  never substituted square brackets**, so these are ordinary prose to this system and would
  be mailed literally.

The bracket rule was fitted to the real data rather than guessed. Measured over the 698
imported drafts: **574 (82%) contained placeholders** `[Your Name]` ×291,
`[Business Owner]` ×177, `[City]` ×162, `[Business Name]` ×142. Requiring Title Case *or* a
single lower-case token keeps every one of those (including `[niche]`) while clearing
bracketed prose asides like `[and Karachi too]` and citations like `[1]`.

Blocking rather than warning is a deliberate asymmetry: a refused send costs one edit,
mailing "Hi [Business Owner's Name]" costs the prospect.

**Three things must all be present before anything can send**, and `SmtpProvider`'s
constructor checks them in this order the *first* one that fails is the message the user
sees, which matters when diagnosing a report:

1. `smtp.host`
2. `email.default_from_address` **the one people miss.** A relay configured perfectly
   still cannot send without it, because there is no envelope sender.
3. the `smtp.password` secret

The from address is edited in two places on purpose (`Settings → Integrations → Email
provider`, and `Settings → Sending & content`); both write the same key. It used to live
only in the second, so an operator could fill in every field on the email card, press Test,
and get an error naming a field that was not on screen. Error messages now name the exact
card, not a section title that does not exist.

**Sending a lead's draft** (`email/send-lead-email.ts`) ordering is deliberate:

1. Resolve the **active version** of the requested step from `email_versions`. For
   `initial` there is a fallback to `leads.subject_line` / `draft_email`, because leads
   imported before versioning have their draft there.
2. Write `email_logs` as `queued` **before** sending, with `email_type` and
   `email_version_id` a crash mid-send still leaves evidence. A log written only on
   success loses exactly the cases you need to investigate.
3. Set lead to `sending` so a second click cannot double-send.
4. Send; record `sent`/`failed`, provider message id, error text.
5. Lead → `sent` + `last_contacted_at`, or back on failure (`approved` for an initial,
   `sent` for a follow-up the earlier email did go out). Never stranded.

It does **not** touch `lead_pipeline`. The `email_logs` trigger does that.

**Draft generation** (`ai/`) `EmailGenerator` is `verify()` + `generate()`, chosen by the
`ai.provider` setting:

- `template` (default) deterministic, offline, no model. Composes a draft from the
  campaign template plus the lead's research; follow-ups get their own shape with one
  specific sentence pulled from research, because reusing the initial template verbatim is
  the most obvious tell of an automated sequence. Every draft is attributed as `template`,
  never as AI output.
- `ollama` a local model over plain HTTP, no SDK. `stream: false` (Ollama returns NDJSON
  otherwise), timeout is a setting and defaults to 120s because a cold model load is slow.
  Provenance is recorded as `ollama:<model>` so "which model wrote the drafts that
  performed" is answerable later.

`prompt.ts` is provider-independent on purpose: switching engines changes *how* text is
produced, never *what the model was told*. `parseGeneratedEmail()` is forgiving models
drift from any output contract, and a usable body should not be discarded over formatting.

**Outbound sync** (`sync/`) `syncLeadChange(leadId, fields)` resolves one snapshot (lead
+ pipeline + next step + active draft per step) and fans it out to every enabled
`SyncTarget`. A throwing target cannot take the others down with it. Adding an API target
later is a new file plus one registry line; the snapshot already carries everything an
outbound webhook would want.

**The scheduled sender** (`outreach/scheduler.ts`, `POST /api/cron/outreach`):

- The website **never schedules anything in-process**. A Next server can be scaled to zero,
  restarted or duplicated at any moment, so a `setInterval` inside one instance is not a
  schedule, it is a coin flip. `vercel.json` declares an hourly cron; any external
  scheduler works equally well.
- Auth is a `CRON_SECRET` bearer token compared with `timingSafeEqual` (lengths checked
  first `timingSafeEqual` throws on a mismatch, which would itself leak the length).
  **Unset ⇒ 503.** It fails closed.
- Follow-ups that are due are sent, generating a draft first when none exists. The
  **initial** email only goes automatically when `outreach.auto_send_initial` is explicitly
  on, and it is off by default: a first touch nobody read is the line between outreach and
  spam.
- Guards, in order: `sending.paused` → automation switches → working-hours window →
  `sending.daily_limit` → `outreach.max_sends_per_run` → per-lead re-check of
  replied/closed/already-sent (a reply can land between the query and the send) →
  `auto_followups` on the lead.
- Bails out at `outreach.max_runtime_seconds` (50s default) and leaves the rest for the next
  run, because serverless platforms kill a request mid-flight and a partially completed run
  that recorded every send is fine. Keep it BELOW the platform timeout (Vercel Hobby 60s,
  Pro 300s); the route asks for `maxDuration = 300`, which Vercel clamps to the plan.

#### Pacing: the gap is measured from the database, not from a loop timer

`sending.min_gap_seconds` is enforced at the TOP of each iteration by `gapRemainingMs()`,
which reads the most recent `email_logs.sent_at`. That is the only way the gap survives:

- a run that stops at its budget, with the next run starting seconds later;
- someone pressing "Run now" during a scheduled run;
- two cron invocations overlapping.

A trailing `sleep` between iterations paces one run and nothing else, which is exactly the
case that produces a burst. The old code did that **and** capped the wait at 10 seconds, so
a 90-second setting waited 10 while the settings screen claimed otherwise.

Initial emails and follow-ups are **one queue**, so the gap applies between any two messages
regardless of type. The recipient's mail server sees one sending pattern, not two
interleaved ones.

Consequence worth internalising: with a 90s gap and a 50s budget, **one email leaves per
run**. Bulk pacing is the cron frequency, not the length of a run. To clear a queue faster,
call the endpoint more often (cron-job.org gives minute granularity free; Vercel Hobby crons
only fire once a day) rather than raising the budget.

**Run history** (`integration-runs.ts`) every invocation writes a row, so
Running/Success/Failed/last-run survives reloads and redeploys. `reapStaleRuns()` closes out
runs orphaned by a crash, so the UI never shows "Running" forever. Integrations are now
`google_sheets` | `email` | `outreach` | `ai`.

---

## 9. Commands

```bash
npm run dev            # http://localhost:3000
npm run build          # must pass before you call anything done
npm run typecheck
npm run lint
npm run import:leads:dry   # validate Leads.xlsx, write nothing
npm run import:leads       # idempotent: second run imports 0

npm run leads:purge                    # DRY RUN what would be deleted
npm run leads:purge -- --yes           # delete, writing a backup first
npm run leads:purge -- --source="google-sheets:Sheet1" --yes
npm run leads:purge -- --restore=backups/leads-<stamp>.json

npm run emails:export                            # unverified addresses -> CSV
npm run emails:import -- --file=result.csv --dry-run
npm run emails:import -- --file=result.csv       # apply a verifier's results
npm run emails:status                            # verification counts
```

`leads:purge` cascades to `email_versions`, `lead_pipeline`, `lead_activity`,
`email_logs` and `replies`, so it removes far more than the lead count suggests. It writes
a timestamped JSON backup to `backups/` (gitignored real emails and drafts) before
deleting, and refuses `--no-backup` on a full purge. The backup restores leads only:
draft *history* does not come back, so prefer `--source` over wiping everything.

Exercising the scheduled sender by hand:

```bash
# dry run counts what is due, sends nothing
curl "http://localhost:3000/api/cron/outreach?dry=1" -H "Authorization: Bearer $CRON_SECRET"
# for real
curl -X POST http://localhost:3000/api/cron/outreach -H "Authorization: Bearer $CRON_SECRET"
```

Or use Settings → Automation, which calls the same function with the working-hours window
ignored.

**Verification standard for this project:** typecheck + lint + build, *and* exercise the
change against the live database or the running app. Compiling is not evidence that it
works. Past sessions created throwaway admin/viewer users, drove real HTTP requests with
valid Supabase SSR cookies, asserted on the responses, then deleted the users that is the
bar. Delete temp scripts afterwards; anything left in `scripts/` gets type-checked by the
build.

---

## 10. Known data quirks (`Leads.xlsx`, Sheet2)

- Headers carry stray leading spaces and inconsistent casing.
- `Date Added` mixes Excel serials, `DD-MM-YYYY` text, and real dates. The serial converter
  handles Excel's phantom 1900 leap day.
- 19 rows carry scraper-junk emails (`…@sentry-next.wixpress.com`, `user@domain.com`).
  These are discarded; identity falls back to website or name. Without this, nine unrelated
  businesses would collapse under one Wix error-reporting address.
- **5 pairs of genuinely different businesses share one contact email** (two Chiang Mai
  agencies both on `info@faranghomes.com`). Under the email-identity rule they collapse:
  703 rows → 698 leads. This is intended; every collapse is reported.
- Sheet1 (687 Pakistan leads, no research/drafts) is **excluded** by user decision.
  `--sheet=Sheet1` imports it if ever wanted; overlap with Sheet2 is only 9 rows.

### The live Google Sheet has the same trap (2026-08-04)

Document `1D0IlVsbD1zl4mxlQ7lfyjZ8__QXGD0V_KoYC4WRNke4`, title "Leads":

| Tab | Populated rows | Columns | Research | Drafts |
| --- | --- | --- | --- | --- |
| Sheet1 | 687 | 12 | **none no such column** | none |
| **Sheet2** | **703** | 26 | 456 | 139 |
| Sheet3 | 0 (headers only) | 26 | | |

`sheets.sheet_name` shipped defaulting to `Sheet1`, so the first sync pulled 468 leads with
no research and no drafts and mixed them in with the enriched workbook import. **It is now
set to `Sheet2`.** If leads ever appear with empty research, check this setting first.

Note the discrepancy worth knowing about: the workbook `Leads.xlsx` carries **698 drafts**,
the live Sheet2 only **139**. The two are not the same snapshot. Re-syncing the sheet will
not reproduce the workbook's drafts `npm run import:leads` is the only way to get those
back (and it sets no `sheet_row_number`, so those leads cannot write back to the sheet).

---

## 11. Changelog

| Date | Change |
| --- | --- |
| 2026-08-03 | Foundation: schema, RLS, auth, middleware, workbook importer |
| 2026-08-03 | Full UI: dashboard, leads, lead detail, campaigns, templates, logs, replies, settings |
| 2026-08-03 | n8n + Google Sheets + email providers; encrypted secrets; real sending |
| 2026-08-03 | Viewers locked down to no data (migration 0009), pending their scope |
| 2026-08-03 | This guide created |
| 2026-08-03 | n8n removed (0011); Sheets write-back added; nested-`<form>` hydration bug fixed in `secret-field.tsx` |
| 2026-08-03 | 0011 confirmed applied to the live DB (the guide had it as pending) |
| 2026-08-05 | **0021**: research counts as done when any of the seven research fields is filled, not just the summary (239 leads were parked at "Researching" with real research); verification tiles split "no address" from "never checked"; the verifier export stopped re-billing catch-all and unknown by default; follow-up badge counts leads rather than drafts |
| 2026-08-04 | **0020**: the minimum send gap was silently capped at 10s, so a 90s setting waited 10. Now honoured in full and measured against the last recorded send, so it holds across runs and manual triggers; run budget became a setting |
| 2026-08-04 | **0019**: the sheet's Date Sent is authoritative for upstream sends and re-anchors `followup1_due`; `last_contacted_at` added to `REFRESHABLE_FIELDS`; the removed "Email draft Status" column unmapped in both directions; `workers_dev = false` so the Worker deploy stops asking for a subdomain |
| 2026-08-04 | **0018**: sheet-reported sends now schedule follow-up 1 (they never did, so 58 leads were parked on await_followup1 forever); the two definitions of "approved" reconciled, and `bulkSetStatus('approved')` routed to `bulkApproveDrafts()` so the dashboard cannot promise a send the scheduler will skip |
| 2026-08-04 | **0017**: a successful send marks the address verified (revised by a later hard bounce); `pipeline_board` gained the verification columns; leads list got a Verified column and `?verify=` filter; Settings gained a download/upload panel for the verifier round trip and a bulk follow-up draft generator |
| 2026-08-04 | **0016**: inbound mail. `inbound_messages` staging, Cloudflare Email Worker transport, threading-first matching, bounce and auto-reply filters, rules+Ollama sentiment, rebuilt Replies inbox with a lead picker. Fixes the auto-reply trigger that would have stopped a sequence on every out-of-office |
| 2026-08-04 | **0015**: email verification enum + CSV round trip (`emails:export`/`import`); `version_lead_draft()` repairs 145 leads whose drafts had no version; sheet-reported sends land on `lead_pipeline`; industry analytics rebased off `email_logs`; opt-in `public_stats_leads` |
| 2026-08-04 | `/` is now the public front page with a hero; dashboard figures link to matching `/leads?view=` lists; tables switched to `table-fixed` so columns actually resize (72–900px) |
| 2026-08-04 | Automation Squad branding: favicon, apple icon, OG + Twitter cards via Next file conventions; `components/brand.tsx` in the sidebar, sign-in and `/stats` |
| 2026-08-04 | Placeholder guard: a draft containing `[Business Owner]` / `{{unknown}}` is refused by `sendLeadEmail()`, so no send path can mail one. 82% of the imported drafts would have been caught |
| 2026-08-04 | `sheets.sheet_name` corrected `Sheet1` → `Sheet2` (Sheet1 has no research columns); all 1166 leads purged to a backup so the sheet could be re-pulled cleanly; `scripts/purge-leads.ts` added |
| 2026-08-03 | **Review workflow + lifecycle** (0012–0014): `email_versions`, `lead_pipeline`, `lead_activity`; stage/next-step derived in SQL; `/stats` public page (anon reads 5 aggregate views); `/analytics`; admin dashboard rebuilt as operational widgets; modular `lib/services/sync`; template + Ollama draft generation; automatic follow-ups via `/api/cron/outreach` |
