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

### Current state (2026-08-05)

Migrations 0001 through 0023 are all applied to the live database.

| Area | Status |
| --- | --- |
| Schema, RLS, auth, middleware | Done |
| Workbook importer (`Leads.xlsx`) | Done |
| Full UI (dashboard, leads, logs, replies, analytics, settings) | Done. Campaigns and templates removed in 0025 |
| Google Sheets sync, read and write-back | Done, write-back live |
| Email providers (SMTP via Brevo) + real sending | Done, sending |
| Encrypted credential storage | Done |
| n8n | Not run by the website. It feeds the sheet; the CRM reads it |
| Admin review workflow (research/personalization/3 drafts/notes) | Done |
| Email versioning (`email_versions`) | Done, nothing is ever overwritten |
| Outreach lifecycle (`lead_pipeline`, derived stage + next step) | Done |
| Draft generation (template generator + Ollama) | Done, `ai.provider` setting |
| Draft cleaning (unwraps the JSON n8n produces) | Done, at import and on demand |
| Automatic follow-ups (`/api/cron/outreach`) | Done, driven by cron-job.org every 3 min |
| **Reply ingestion** | Done — Cloudflare Email Worker → `/api/inbound/reply` |
| Scheduled jobs (sheet sync, draft sweep, sender) | Done — three `/api/cron/*` endpoints, driven externally |
| **Email verification** | Done — verifier CSV round trip, verify-on-send, manual verdicts |
| Public front page at `/` (no login) | Done, anon reads six aggregate views |
| Analytics page | Done |
| Modular outbound sync layer | Done, `lib/services/sync/` |
| What signed-in *viewers* may see | **Still deliberately nothing.** `/` is the public answer |
| Deliverability (SPF/DKIM/DMARC, BIMI) | **Not addressed.** See section 11 |

Live figures at the time of writing: 701 leads, 394 with an address, 202 verified, 28 emails
sent from the CRM, 89 emailed in total (the rest upstream), 1 reply.

> **See section 12 first.** A read-only audit on 2026-08-05 found twelve open problems in
> the dashboard, the send gates and the verification model. None of them is fixed.

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
| 0015 | `20260804120000_verification_versions_and_public_leads.sql` | ✅ yes |
| 0016 | `20260804140000_inbound_messages.sql` | ✅ yes |
| 0017 | `20260804160000_verify_on_send_and_board.sql` | ✅ yes |
| 0018 | `20260804180000_schedule_followups_for_backfilled_sends.sql` | ✅ yes |
| 0019 | `20260804200000_sheet_date_sent_is_authoritative.sql` | ✅ yes |
| 0020 | `20260804220000_outreach_run_budget.sql` | ✅ yes |
| 0021 | `20260805100000_research_complete_any_field.sql` | ✅ yes |
| 0022 | `20260805120000_reconcile_approved_versions.sql` | ✅ yes |
| 0023 | `20260805140000_manual_verification_is_a_verdict.sql` | ✅ yes |
| 0024 | `20260805160000_sheet_research_status_and_drop_category.sql` | ✅ yes (2026-08-05) |
| 0025 | `20260805180000_stage_is_the_first_unmet_gate.sql` | ✅ yes (2026-08-05) |
| 0026 | `20260805200000_add_dead_email_stage_value.sql` | ❌ **NOT YET** — paste `schema-update-16-dead-email-enum-value.sql` **on its own, first** |
| 0027 | `20260805210000_dead_email_stage_and_status_views.sql` | ❌ **NOT YET** — paste `schema-update-17-dead-email-stage.sql` **after 16 has committed** |

**Everything through 0025 is applied.** Verified against the live database on 2026-08-05 by
probing for each migration's marker rather than trusting the file list — `inbound_messages`
exists, `pipeline_board` carries the verification columns, `outreach.max_runtime_seconds` is
present, a research-but-no-summary lead reads `research_complete = true`, and no row is left
with `email_verified` set while its status still says `unverified` (which is what 0023 fixed).

**The next migration is 0028.** Add the file, regenerate `schema.sql` and a
`schema-update-18-*.sql` bundle, and leave its row as NOT YET until it has actually run.

### 0026 and 0027 are ONE change split in two, and the order is not optional

Postgres refuses to let a new enum value be used in the transaction that added it:

```
ERROR:  unsafe use of new value "dead_email" of enum type pipeline_stage
HINT:   New enum values must be committed before they can be used.
```

So 0026 is a single `alter type ... add value` and nothing else, and 0027 — the function that
returns it, the backfill that stores it, the new view, the drops — is a separate script. Paste
16, let it finish, then paste 17. Running them as one script fails on the backfill.

**The application code already assumes both.** Until they run, the 19 dead addresses still sit
at `need_email`, so the stage filter reads 326 where the tiles read 307 and 19.

### Applying a new one

There is no CLI on this machine (`supabase` and `psql` are both absent), so it is a
paste-into-the-SQL-editor job:

1. Write `supabase/migrations/<timestamp>_<name>.sql`.
2. Generate `supabase/schema-update-<n>-<name>.sql` containing just that migration, plus
   regenerate `supabase/schema.sql` from every migration in filename order.
3. Paste the update bundle into the Supabase SQL editor and Run.
4. Flip its row in the table above.

Bundles 5 through 13 correspond to migrations 0015 through 0023 and have all been run. Keep
every migration re-runnable — `create or replace`, `add column if not exists`,
`on conflict do nothing`, guarded backfills — because a partially applied or rolled-back
attempt is normal and the fix should always be "run it again".

### The flag and the status move together, in both directions

`email_verified` (boolean) and `email_verification_status` (enum) describe the same fact, so
0023 makes them bidirectional. **Which side wins is decided by which one changed** in the
statement:

| Changed | Effect |
| --- | --- |
| `email_verification_status` | A verifier or a bounce spoke. It drives the flag. |
| `email_verified` | A human spoke. It drives the status, recorded as source `manual`. |

Before this, ticking "Email verified" on the lead page set only the flag. The status stayed
`unverified`, the table kept showing "Never checked", and the lead stayed in the verifier
export — being re-billed for an address someone had already confirmed.

Unticking returns the status to `unverified`, never to `invalid`: "no longer sure" is not
"proved dead". An existing `invalid` is never softened, because a hard bounce is evidence.

### Archive versus delete

`archiveLead` sets `status = 'archived'` and the default leads list now excludes those, so
archiving actually removes the row from view. Tick Archived in the status filter to see them.
A named `?view=` is exempt, because those ask a specific question that archiving does not
answer.

`deleteLeads()` is permanent and cascades: `email_logs`, `replies`, `email_versions`,
`lead_pipeline` and `lead_activity` all reference `leads.id` with ON DELETE CASCADE, so send
history and drafts go too. That is the intent for a duplicate or junk row, and it is why the
UI confirms. It refuses more than 500 at once and points at `npm run leads:purge`, which
writes a restorable JSON backup first.

### Duplicate leads sharing one address, despite a UNIQUE dedupe_key

`dedupe_key` is computed ONCE, at import, from what the row had then:
`email:<address>` when there was a usable one, otherwise `site:<host>` or
`name:<name>|<city>`. It is not in `REFRESHABLE_FIELDS` and nothing recomputes it.

So a sheet row imported without an address gets `site:example.com`, and if the address is
filled in later the key stays `site:`. A second row for the same business imported WITH the
address gets `email:info@example.com`. Two different keys, one address, and the UNIQUE index
is perfectly satisfied.

Observed live: `info@vacationsrilanka.com` and `info@lankasafetours.com`, each present twice.
The symptom is confusing rather than obviously broken — you send from one row and open the
other, which shows no email log and still reads unverified.

`npm run leads:duplicates` reports them; `-- --merge` moves logs, replies, activity and
inbound messages onto the survivor and **archives** the others (never deletes). The survivor
is chosen by evidence first — logs, a reply, a confirmed verification — because content can
be copied across but a conversation cannot.

Recomputing keys automatically would be worse: it would collide with the surviving row and
fail the whole sync.

### A tile must link to exactly the rows it counted

"No address" and "Never checked" are both `email_verification_status = 'unverified'` in the
database — a lead with no address has nothing to verify, so it carries that status too. A
`?verify=unverified` link therefore returned all 308 of them under a tile reading 2.

Both are named views (`?view=missing_email`, `?view=never_checked`) for that reason. When
adding a tile, check that its link and its count resolve through the same query; if they
cannot, the tile needs a view rather than a filter.

The leads table shows **No email** rather than "Unverified" when there is no address, because
the two are different jobs: one is sourcing, the other is verification.

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

Order matters between migrations: 0017 rewrites `pipeline_board`, which 0015 created.

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
viewers get **no row access** to `leads`, `replies`, `email_logs` or
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

### The `/stats` exception anon can read exactly four views

Migration 0013 **deliberately breaks** the "anon gets nothing" invariant, for four views
and nothing else (0025 dropped the fifth, `public_stats_campaigns`, with the campaigns table):

```
public_stats_overview        public_stats_stages     public_stats_statuses
public_stats_activity_daily
```

They carry no `is_admin()` gate and are granted `select` to `anon`. That is what makes the
login-free `/stats` page possible. Everything protecting the data now lives in **what
those views select**, so:

- Aggregates only. Never a lead id, business name, website, email, phone, city, note,
  research paragraph, draft, subject line or reply body. A count grouped by
  `business_name` is a list of business names with extra steps.
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
| Viewer `select` on leads / settings | 0 rows |
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
             (campaigns and templates were dropped in 0025; every lead had
              campaign_id = NULL, so the generator never used them)
email_logs   lead_id, status, provider, message_id, sent_at, error, email_type
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

`lead_pipeline.current_stage` and the Next Step are **computed in Postgres**, and since 0025
both are the **first unmet gate** rather than the last satisfied one — a stage names what is
BLOCKING a lead. Facts (sent, replied, closed) stay pinned above the gates, because a send
cannot be undone by a gate failing later:

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

### What decides that research is done

Three answers over time, each replacing a worse guess:

| | Rule | Problem |
| --- | --- | --- |
| 0012 | `research_summary` is not null | 239 leads had full research and no summary |
| 0021 | any of seven research fields | still guessing about someone else's process |
| **0024** | the sheet's **research status** column, OR any research field | — |

The sheet column is the upstream pipeline's own verdict, so it wins. It reaches the database
on `leads.researched_at`, stamped by the importer, and the trigger treats a non-null value as
authoritative.

Field presence is **kept as a fallback rather than replaced**. A lead with a page of website
observations has plainly been researched whatever a status column says, and requiring both
signals would push hundreds of finished leads back into the queue the moment a column went
blank. Either signal being true is enough.

`researched_at` records when we LEARNED the research was done, not when it happened — the
sheet does not carry that. Date Added is preferred over import time because it is at least
bounded by reality. `drafted_at` is deliberately still left null: nothing depends on when a
draft was written, so a guessed timestamp there would be invention with no payoff.

`personalization` is excluded from the field check. It is the hook line used in the draft
rather than research, and 691 of 698 leads have it, so including it would make the flag true
for everything and mean nothing.

### `category` is deprecated, not dropped

Removed from the sheet on 2026-08-05 and from every CRM code path: import mapping, Sheets
write-back, leads table, lead form, the AI prompt and the missing-address export. The leads
list shows **Niche** in its place, which is the field actually used for segmenting.

**The database column survives on purpose.** It still holds a real qualification signal —
348 `Skip`, 241 `Needs Automation`, 112 `No Website` — and dropping it destroys that with no
way back. The exact statements to run, once those marks are confirmed unnecessary, are in the
column's own `COMMENT`. `dashboard_leads_by_category` selects it and has to be dropped first.

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

### Drafts arrive as JSON, and have to be unwrapped

The upstream Ollama pipeline is prompted for structured output, so what lands in the sheet
(and therefore in `leads.draft_email`) is a payload, not an email:

```
{"header": "Elevate Your Budapest Goulash Experience",
 "body": "Hi,\n\nI came across Budapest Goulash..."}
```

`lib/services/drafts/quality.ts` handles this, and it is pure — no database, no network, no
`server-only` — so a script, a server action and a client component all share one definition.

`normaliseDraft()` tries three passes, most reliable first: strict `JSON.parse`, then
tolerant key extraction, then treat it as prose. **The tolerant pass is the one that earns
its keep**: a model writing a multi-line email into a JSON string emits raw newlines, which
makes the document invalid JSON, and that is the common case rather than the exception. It
salvages the text instead of discarding a perfectly usable draft.

It runs at **import** (`lib/import/mapping.ts`), so the CRM stores an email rather than a
payload and every downstream consumer deals in prose. Cleaning per-feature would mean
remembering to do it in each one.

**The sheet keeps header and body in SEPARATE columns**, so each cell holds a bare fragment
rather than a whole object:

```
Email Header cell:  "header": "Elevate Your Budapest Goulash Experience",
Email Body cell:    "body": "Hi,\n\nI came across..."
```

That never starts with `{`, so the JSON passes skip it entirely and the key name and quotes
would reach the recipient. `normaliseDraft()` has a dedicated fragment pass for it, and
`normaliseSubjectLine()` applies the same treatment to the header column — stricter, since a
newline surviving into a subject is a parse failure rather than a formatting choice.

**The tail-only case is the common one and it broke the whole feature.** The Body column
frequently holds an ordinary-looking email that simply ends with the debris it was cut out
of:

```
Best regards,
Team Automation"
}
```

No leading `{`, so every structural pass skips it, and a strip-quotes rule requiring BOTH
ends to match does nothing either. Result: three sweeps in a row reporting
`400 checked, 0 approved, 400 left for review`.

`stripJsonDebris()` peels this from both ends and loops until stable, because the debris
nests. The trailing quote is removed **only when the quote count is odd** — an email ending
`he called it "the good one"` has balanced quotes and is left alone, whereas a lone
unmatched `"` is the tail of a JSON string. That test is what makes the sweep safe to run
unattended over every draft.

It is idempotent, verified: running it two and three times over the same body changes
nothing, so re-pressing the button does not spawn versions.

`inspectDraft()` returns what is still wrong: JSON wrapper, literal `\n`, code fences, stray
braces, wrapping quotes, unfilled placeholders, no subject, suspiciously short. Round
brackets are deliberately fine — "(and yes, really)" is ordinary prose; braces and square
brackets are not.

**Repairing and approving are separate, on purpose.** `repairAndApproveDrafts()` cleans
every pending draft — saving each repair as a NEW VERSION, so the original stays in the
history and a bad clean is one click from undone — and only then approves the ones with zero
blocking issues. Anything still carrying a placeholder or a truncated body keeps its place in
the queue. A cleaner that also approved would defeat the point of having an approval step.

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
      email-logs/ replies/
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
import from a plain module.

**The UI never calls an external API.** Client → Server Action → service in `lib/services/`.
That keeps credentials server-side and gives one place to record run history.

**Types.** `src/lib/supabase/database.types.ts` is hand-maintained. Change it in the same
commit as the migration. It declares `Relationships: []`, so **PostgREST embedded selects
(`leads(business_name)`) will not type-resolve** use a second query and join in JS, as
`lib/data/misc.ts` does.

**Styling.** Semantic CSS variables only (`bg-surface`, `text-muted-foreground`,
`border-border`). Never a raw hex in a component. Both themes are defined in
`globals.css`; `@theme inline` maps them into Tailwind.

**Times are displayed in one pinned zone.** `DISPLAY_TIME_ZONE` in `lib/utils.ts`
(`NEXT_PUBLIC_DISPLAY_TIMEZONE`, default `Asia/Karachi`) is passed to every Intl formatter.
Without an explicit `timeZone`, Intl uses whatever clock the code runs on: UTC on Vercel for
a server component, the visitor's own zone for a client one, so one page could show the same
instant two ways.

This is **display only**. Storage is UTC (`timestamptz`) and `sending.working_hours` keeps
its own timezone, deliberately separate: when the sender may run is a policy about the
recipients, not about who is reading the screen. Because both appear in the UI,
`formatDateTime()` appends the zone label by default (`{ zone: false }` opts out), and the
Settings screen translates the window into display time so "09:00–17:00 UTC" next to
"14:32 PKT" cannot be misread.

Chart axes still use the raw `YYYY-MM-DD` buckets from `date_trunc` in Postgres, which are
UTC days. Converting a pre-aggregated day label would be meaningless, so they are left alone.

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
| **Exporting a non-async value from a `'use server'` file** | `A "use server" file can only export async functions, found object.` The **whole module fails to evaluate**, so *every* action in it 500s including ones that have nothing to do with the offending export. The stack points at the generated action loader, never at the real culprit, and the browser just says "Could not reach the server" | Move the value to a plain module and import it from both sides. `type`/`interface` exports are fine they are erased |
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

npm run leads:duplicates                 # leads sharing an email address
npm run leads:duplicates -- --merge      # keep the richest, archive the rest

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

## 11. Deliverability and sender identity (NOT code)

The blank "T" avatar Gmail shows next to outbound mail is not something this codebase can
change. Recording it here because it comes up, and because the prerequisites are worth doing
for reasons that matter far more than the icon.

**Gmail will not show a logo without BIMI plus a VMC.** BIMI is a DNS record pointing at a
logo; Gmail only renders it when the domain also presents a **Verified Mark Certificate**,
which requires a *registered trademark* and costs roughly $1,000–1,500 a year from DigiCert
or Entrust. Without the VMC the record is still valid and some clients (Yahoo, Fastmail, La
Poste) will display it, but Gmail will not.

**An animated GIF is impossible.** BIMI requires SVG Tiny 1.2 in the SVG-P/S profile:
square, static, no scripts, no animation, no external references. No major client supports
an animated sender avatar. `public/logo-mark.png` would need converting to conformant SVG.

**A Google Workspace profile photo does not apply here.** That works when the sending
address is a Workspace mailbox. `send@team-automationsolutions.me` is a Cloudflare Email
Routing address that forwards to Gmail, so there is no account to attach a photo to.

**The prerequisites are the real prize.** BIMI requires DMARC at enforcement
(`p=quarantine` or `p=reject`) with SPF and DKIM aligned and passing. For cold outreach that
alone does more for inbox placement than any avatar: without DMARC enforcement, anyone can
spoof the domain and every provider treats it as lower trust. Brevo's docs cover the SPF and
DKIM records; DMARC is a single TXT record at `_dmarc.team-automationsolutions.me`, and it
should start at `p=none` with reporting until the reports come back clean.

Order of value for a cold-outreach sender: SPF and DKIM aligned → DMARC at `p=none` →
DMARC at enforcement → BIMI → VMC. The avatar is the last and least of these.

## 12. Audit 2026-08-05 — open findings, NOTHING FIXED YET

Read-only probe of the live database plus a pass over every dashboard tile and the paths that
feed them. **None of this is fixed.** It is written down so the next session does not
re-derive it. Live figures at the time of the probe: 701 leads, 701 pipeline rows, 743
versions, 28 sends recorded in `email_logs`, 89 leads emailed in total (the rest upstream),
1 reply.

### What the tiles actually count right now

| Tile | Shows | Composition |
| --- | --- | --- |
| Approval Queue | 351 | `draft_ready & !approved` — 159 have no address, 13 are dead addresses |
| Emails Waiting Review | 375 | the SAME 351 initial drafts + 12 followup1 + 12 followup2 |
| Awaiting Verification | 173 | 78 catch-all + 95 unknown. **Zero** never-checked addresses exist |
| Needs Research | 0 | requires `email_verified`, and only 202 leads are verified |
| Needs Draft | 207 | 58 already emailed, 84 have no address |
| Ready to Send | 111 | 62 have **no address**, 4 are **dead**, 18 unknown, 12 catch-all, **15 verified** |
| Leads Missing Email | 307 | correct |
| Dead Addresses | 19 | correct |

### The findings

1. **Ready to Send counts leads that cannot be sent.** `idsForView('ready_to_send')` and the
   matching widget check `pipeline.approved` + an approved active `initial` version +
   `first_email_sent is null`. Neither checks `email_found` or `email_verified`, so 96 of the
   111 are unsendable. The cron then refuses them (`requireVerifiedEmail` is on), which is
   why the tile never moves.
2. **The manual Send button has no verification gate.** `sendLeadEmail()` checks a placeholder
   and an address being present, and nothing else. `requireVerifiedEmail` is enforced only in
   `findDueWork()` in the scheduler. Pressing Send on a lead whose address a verifier proved
   dead will mail it.
3. **The approve sweep signs off leads with no address.** `repairAndApproveDrafts()` and
   `bulkApproveDrafts()` filter on the draft only. That is how 62 address-less leads reached
   Ready to Send.
4. **"Awaiting Verification" conflates never-checked with checked-inconclusive.** It counts
   `email_verified = false` minus `invalid`, which today is 100 % catch-all and unknown —
   addresses a verifier HAS already answered on. The Settings panel says 0 to check, the
   dashboard says 173 awaiting, and both are reading the same rows.
5. **The pipeline panel gate is the same conflation.** `email_verified` is a boolean over a
   five-value enum, so catch-all and unknown render as an empty circle indistinguishable from
   "nobody has looked". This is the "it says verification wasn't done when it was" report.
6. **`saveResearch()` wipes `researched_at`.** It writes
   `researched_at: values.research_summary ? now : null`, so saving any research edit with an
   empty summary nulls the column — which is exactly the carrier 0024 makes authoritative.
7. **Follow-up Due Today tile and its link disagree.** The widget counts `followup1_due`
   BETWEEN today's start and end; `idsForView('followup1_due')` counts everything `<= end of
   today`. Both are 0 today so it is invisible; the first overdue follow-up makes the tile and
   the page disagree, and double-counts against Overdue Follow-ups.
8. **The dashboard "Ready to send" list card does not match its own tile.** It queries
   `pipeline_board` by `next_step` and adds `updated_at <= end of today`, a filter that is
   true for essentially every row and answers nothing.
9. **`current_stage` hides a missing address.** The CASE is ordered newest-fact-first, so
   `approved` / `draft_ready` / `research_complete` all outrank `email_found`. 307 leads have
   no address; only 2 read `need_email`. The rest read "Draft Ready" or "Approved".
10. **348 leads are marked `Skip` upstream and the CRM ignores it.** `category` was removed
    from every code path in 0024 but the data is still there: 158 Skip leads sit in the
    approval queue, 60 in Ready to Send, and **54 have already been emailed**.
11. **`outreach.auto_send_initial` is `true` in the live settings.** Initial emails go out
    unattended. Sections 1 and 8 describe it as off by default; it is not.
12. **`leads.status` and `current_stage` disagree at scale.** `status = 'researching'` on 472
    leads while 695 read `research_complete`; `status = 'invalid'` on 15 against 19 dead
    addresses. Status is a label someone sets; stage is derived. Only
    `sync_pipeline_from_lead()` reads status (for `approved`), and the importer overwrites it.

### Dead code and dead schema

| Thing | Evidence | Verdict |
| --- | --- | --- |
| `src/lib/data/dashboard.ts` | imported by nothing | dead module |
| `dashboard_overview`, `dashboard_leads_by_country`, `dashboard_leads_by_niche`, `dashboard_reply_activity_daily`, `dashboard_reply_stats` | only consumed by that dead module | droppable |
| `dashboard_leads_created_daily` | no consumer at all | droppable |
| `dashboard_leads_safe` | built for the viewer role that was never given a scope | keep only if viewers are coming |
| `dashboard_leads_by_category` | no consumer; blocks `alter table leads drop column category` | drop with the column, not before |
| `settings` rows `ai.default_model`, `provider.name`, `followup.default_delay_days` | seeded in 0006, read by nothing | droppable |
| `leads.next_followup_at` | 0 rows populated, never read or written | droppable |
| `campaigns` / `templates` | 1 seed row each; **all 701 leads have `campaign_id = NULL`** | so `dashboard_campaign_stats`, `analytics_template_performance` and `public_stats_campaigns` are structurally empty |
| `leads.category` | 348 Skip / 241 Needs Automation / 112 No Website | **droppable** — the Skip marks were confirmed stale on 2026-08-05 |

### Decisions taken 2026-08-05 — the target design

Eight decisions, all made by the user. **This is the spec; none of it is built yet.**

**1. Stage becomes a strict funnel.** `compute_pipeline_stage()` is reordered from *newest fact
wins* to **first unmet gate wins**, so a stage names what is BLOCKING a lead rather than the
last thing that happened to it. Sent leads stay pinned at the top — a lead already emailed
never falls back, even if its address later goes dead.

```
closed > replied > followup2_sent > followup1_sent > initial_sent   (facts, pinned)
  then: no address        -> need_email
        status = invalid  -> need_email
        not verified      -> need_verification
        no research       -> research
        no draft          -> draft
        not approved      -> review
        else              -> ready
```

Modelled against live data, 497 leads move backwards: 172 `review -> need_email`,
89 `review -> need_verification`, 86 `draft -> need_email`, 54 `draft -> need_verification`,
66 `approved -> need_email`, 30 `approved -> need_verification`. **Nothing is deleted** —
drafts and approvals stay attached, so a lead jumps straight to `ready` the moment its address
is found and verified.

The uncomfortable fact this exposes: 304 of the 307 address-less leads already have research
done, 159 have drafts awaiting review and 62 have approved drafts. The upstream pipeline
researched and drafted for hundreds of businesses it never found an address for. The funnel
does not create that; it stops "Approval Queue: 351" from hiding it.

**2. Every dashboard tile becomes a stage or next-step query,** not an ad-hoc flag query. This
is the permanent fix for the "tile says 114, page shows 97" class of bug — the count and the
link resolve through the same derivation by construction.

| Tile | Now | Target |
| --- | --- | --- |
| Leads Missing Email | 307 | 307 (`stage = need_email`, excluding dead) |
| Dead Addresses | 19 | 19 |
| Awaiting Verification | 173 | **0** — never-checked WITH an address |
| **Checked, inconclusive** | — | **173** — new tile, catch-all + unknown |
| Needs Research | 0 | 0 |
| Needs Draft | 207 | **9** |
| Approval Queue | 351 | **90** (`stage = review`, initial only) |
| Emails Waiting Review | 375 | **removed** — it was the same 351 drafts + 24 follow-ups |
| Ready to Send | 111 | **9** |

**3. Ready to Send means verified.** Address present + `email_verification_status = 'valid'` +
active `initial` version approved + not sent. The tile, the named view and the sender all read
the same conditions.

**4. Catch-all and unknown get their own queue.** 78 + 95 = 173 addresses a verifier HAS
answered on and could not prove either way, of which 30 already have an approved draft and 89
have one awaiting review. They stop being counted as "awaiting verification", which was the
"it says verification wasn't done when it was" complaint. The lead-page tick box becomes a real
five-state control over the enum, because a boolean over five values is what caused this.

**5. The verification gate moves into `sendLeadEmail()`** — the one function every send path
goes through. Refuses no-address, refuses `invalid`, and refuses unverified while
`outreach.require_verified_email` is on. A gate that lives only in `findDueWork()` protects the
cron and nothing else; the Send button on the lead page currently has no gate at all.

**6. Stage wins, status mirrors.** `sync_pipeline_from_lead()` stops deriving `approved` from
`leads.status`. Status remains only as the sheet's label for write-back, and comes out of the
leads table UI. This removes the last coupling that produced the two-definitions-of-approved bug.

**7. The approve sweep is left alone — deliberately.** The first draft of this plan had
`repairAndApproveDrafts()` and `bulkApproveDrafts()` skipping leads with no address or a dead
one. The user reversed that, and the reversal is right: approving a draft is a judgement about
the WORDS, and it stays valid whether or not an address has turned up yet. Gate the one thing
that actually matters — a lead can be approved and still never reach Ready to Send, because
Ready to Send requires all four gates. One gate, in one place, instead of the same rule
scattered across every action that can approve something.

**8. `Skip` is stale.** Confirmed with the user. `leads.category` and
`dashboard_leads_by_category` are both safe to drop, and the 54 already-emailed Skip leads are
a non-issue.

**9. Do not overcomplicate the UI.** Standing constraint on everything above, and specifically
on the five-state verification control in chunk 3.

### The questions that produced this, and the answers

Kept verbatim, because the next person will otherwise re-litigate them.

| # | Question | Answer |
| --- | --- | --- |
| 1 | What must be true for a lead to be in Ready to Send? | **All four pipeline gates**, email first: `email_verified`, `research_complete`, `draft_ready`, `approved` |
| 2 | What happens to the 173 catch-all / unknown addresses? | Their own tile and their own decision queue. They stop counting as "awaiting verification" |
| 3 | How do status and stage relate? | Stage wins; `leads.status` becomes a sheet mirror only |
| 4 | What does `category = 'Skip'` mean? | Stale. The column and `dashboard_leads_by_category` are droppable |
| 5 | Keep stage as-is, or a strict funnel? | **Strict funnel** — first unmet gate wins, even though 497 leads move backwards |
| 6 | Where does the verification gate live? | Inside `sendLeadEmail()`, the one function every send path goes through |
| 7 | `auto_send_initial` was on and sending — leave it? | Off until these fixes ship |
| 8 | Approval Queue vs Emails Waiting Review? | One tile, initial drafts only. Emails Waiting Review is removed |

### Chunk 1 — SHIPPED 2026-08-05

Verified against the live database after the change, not assumed.

| Change | Where | Effect |
| --- | --- | --- |
| Ready to Send requires all four gates | `data/leads.ts`, `data/admin-dashboard.ts` | **103 → 7**, and all 7 read `valid`. The two queries are duplicated on purpose (one counts, one lists) and must be edited together |
| Verification gate | `services/email/send-lead-email.ts` | Dry run over the 103: **7 allow, 4 refused dead, 92 refused unverified**. `invalid` is refused regardless of `require_verified_email`, because a bounce is proof rather than a lack of it |
| `researched_at` no longer wiped | `actions/review.ts` | Stamped only when the research text actually changed; never set back to NULL |
| Follow-up buckets partition | `data/leads.ts`, `data/admin-dashboard.ts` | Overdue measured from the start of today, not `now()`. Due-today views bounded at both ends so a card and the page it links to cannot disagree |

### Chunks 2 and 3 — SHIPPED 2026-08-05 (code); migration 0025 still to run

**Everything above is now built.** `npm run typecheck`, `npm run lint` and `npm run build` all
pass, and the route table no longer contains `/campaigns` or `/templates`.

| Change | Where |
| --- | --- |
| Stage reordered to first unmet gate; `compute_next_step` matched | migration 0025 |
| A verifier result decides the flag outright: `email_verified := (status = 'valid')` | migration 0025 |
| `sync_pipeline_from_lead()` no longer derives `approved` from `leads.status` | migration 0025 |
| Ten unread views dropped; `pipeline_board` and `dashboard_leads_safe` rebuilt without the dropped columns | migration 0025 |
| `campaigns`, `templates`, `leads.category`, `leads.campaign_id`, `leads.next_followup_at`, `email_logs.campaign_id`, `email_logs.template_id`, three orphan settings rows | migration 0025 |
| Every tile and named view is a `current_stage` query | `data/admin-dashboard.ts`, `data/leads.ts` |
| "Emails Waiting Review" removed; Approval Queue is initial drafts only | `dashboard/page.tsx` |
| "Checked, Inconclusive" tile added; Awaiting Verification means never checked | `dashboard/page.tsx` |
| Leads list: Stage column and stage filter, Status column and filter gone, Archived is a toggle | `leads-table.tsx`, `filter-panel.tsx`, `(list)/page.tsx` |
| Five-state verification dropdown replaces the tick box, revalidating `/leads` and `/dashboard` so the counts move with it | `pipeline-panel.tsx`, `setVerificationStatus()` |
| Approval writes the version and nothing else — no `leads.status`, no lead fields | `actions/leads.ts`, `actions/verification.ts`, `actions/review.ts` |
| `bulkApproveDrafts` filters `status = 'draft'`, so a rejected version is not silently re-approved | `actions/leads.ts` |

**What `leads.status` is now.** Read in exactly two places and written in three:

- **Inbound**, the important one: the sheet's "Email sent status" arrives as `status = 'sent'`,
  and `sync_pipeline_from_lead()` turns that into `first_email_sent`. For the 89 leads n8n
  emailed there is no `email_logs` row, so this is the only record the send ever happened.
- **Archiving**, which is a visibility choice no derived stage can express — an archived lead
  still sits wherever it sat.
- `sendLeadEmail()` still moves it to sending/sent, because that is a fact about the lead.

It is no longer read for approval, no longer shown in the leads table, and its outbound sheet
mapping is deleted: it targeted headers `status` / `crm status` / `lead status`, and the sheet
has none of them. Everything the sheet does receive comes from the pipeline.

**Deliberately not done.** The approve sweep still approves drafts for leads with no address —
the user reversed that, correctly. Approval is a judgement about the words; Ready to Send
requires all four gates, so an unsendable lead can be approved and simply never gets there. One
gate in one place beats the same rule copied into every action that can approve something.

**Done already:** `outreach.auto_send_initial` is `false` in the live settings.
`auto_followups` stays on.

### 0026 / 0027 — four things the user found after 0025 went live

**1. The stage filter said 326 where the tiles said 307 and 19.** `need_email` was answering
two questions: 307 leads never had an address, 19 had one a verifier proved dead. Both need an
address FOUND, so both landed on one stage, while the dashboard had always split them because
the work is different. **`dead_email` is now its own stage.** One stage per tile, no arithmetic.

`pipeline_next_step` deliberately gains no value: for both stages the next action is "go and
find an address", and inventing a second word for one action would be a second enum migration
for no gain.

**2. The stage filter said `initial_sent 94` and the page showed 93.** Two leads are archived;
one of them is at `initial_sent`. The facets read `analytics_stage_distribution`, which counts
every pipeline row, while the list hides archived by default. New view
`public.lead_stage_counts` returns both figures (`lead_count` excludes archived,
`lead_count_all` includes them) and `getStageFacets(showArchived)` picks the one the list is
actually using. `analytics_stage_distribution` is unchanged — /analytics reports on everything
on purpose.

**3. "Business information — Researching" on leads that had plainly been researched.** The lead
detail page still rendered `leads.status`, as a badge and as an editable dropdown, on 472 leads
reading `researching` against 695 with research complete. Both are gone; the badge is now the
derived stage. `leads.status` rides along as a hidden input so a save cannot blank the value the
sheet sync depends on.

`StatusBadge`, `LEAD_STATUS_LABELS` and `STATUS_CHART_COLORS` were deleted with them — **nothing
in the application renders lead status any more.** `EmailStatusBadge` and `SentimentBadge` are
unrelated and stay: they describe an email and a reply, which are facts rather than labels.

**4. "Who verified these?"** Worth recording, because it will be asked again. Of the 202
addresses marked `valid`:

| source | count | meaning |
| --- | --- | --- |
| `neverbounce` | 190 | a verifier result CSV, uploaded through Settings or `emails:import` |
| `delivered` | 7 | a real email was accepted and no bounce came back (migration 0017) |
| `manual` | 5 | someone ticked the box |

The 89 in the approval queue: 88 `neverbounce`, 1 `manual`. `email_verification_source` is on
every `lead_pipeline` row, so this question is always answerable — never guess at it.

### The last two status views are gone

`dashboard_lead_status_counts` fed a Status-distribution chart on /analytics and
`public_stats_statuses` fed one on the public page, each sitting beside a stage chart answering
the same question correctly. Two charts contradicting each other on one screen is worse than one
chart. Both dropped, along with `dashboard_leads_safe` — shaped for a viewer role that still has
no scope, and read by nothing since it was written.

`public_stats_leads` **stays**: it is a working, default-denied feature (Settings → Public page),
not dead code.

### Three scheduled jobs, none of them scheduled by this app

`/api/cron/outreach` was joined by two more. All three take the same shared-secret check —
`guardCronRequest()` in `lib/cron/authorize.ts`, moved out of the outreach route the moment
there was a second caller, because a security check copied three times is a security check that
ends up subtly different in one of them.

| Endpoint | Cron | Does |
| --- | --- | --- |
| `/api/cron/sheet-sync` | `59 23 * * *` Asia/Karachi | The same `syncFromGoogleSheet()` as the Sync button, once n8n has finished appending for the day |
| `/api/cron/approve-drafts` | `0 0,7,14,21 * * *` | The same `runDraftSweep()` as the Clean-and-approve button |
| `/api/cron/outreach` | `*/3 * * * *` | Sends what is due |

**Cron cannot express "every 7 hours."** `0 */7 * * *` restarts its count at midnight, so it
fires at 00, 07, 14, 21 and then waits three hours rather than seven. The explicit hour list is
the same four times and says outright what it does.

**`vercel.json` was deliberately left alone.** It already declares one cron; Vercel's Hobby plan
allows two, and adding two more would fail the deploy rather than degrade. cron-job.org is what
actually drives these — it also speaks timezones, so 23:59 can be set as 23:59 Asia/Karachi
instead of being hand-converted to 18:59 UTC and silently breaking at a DST boundary somewhere.

### Every cron route answers before it works, and why that is a trade

cron-job.org gives up after about 30 seconds. A 700-row sheet sync and a sweep over a queue of 90
both take longer than that legitimately, so both were reported as **failed runs while actually
completing in the background** — the worst outcome available, since the alarm was false and a
genuine failure would have looked identical.

All three routes now answer `202 Accepted` in milliseconds and finish the job inside Next's
`after()`, which keeps the function alive past the response. `/api/cron/outreach` was included
even though it appeared healthy: it only survived because it usually finds nothing due, and it
sleeps 90 seconds between sends by design, so its first real queue would have failed the same way.

**The cost, which is real:** the scheduler can no longer tell you whether a run SUCCEEDED, only
that it started, so it shows green either way. That is only acceptable because all three jobs
write an `integration_runs` row carrying the true outcome, and Settings lists them. **Do not use
`lib/cron/accepted.ts` for a route that does not record a run** — that would be a job whose
failures are invisible everywhere.

`maxDuration` now covers the `after()` work, not the response. The sweep's own budget is 50s,
matching the sender's, so it stops cleanly inside a Hobby function's 60s rather than being killed
mid-version-write; whatever it does not reach waits for the next of the four daily runs.

**`runDraftSweep()` moved to `lib/services/drafts/sweep.ts`** so the button and the schedule run
one function. `repairAndApproveDrafts()` is now a nine-line action: `assertAdmin()`, call the
service, `revalidatePath()`. The same shape as the verification CSV round trip — two front
doors, one service, identical state either way. Authorization deliberately is NOT in the
service: the action checks the session, the route checks the secret, and the service assumes the
caller earned it.

The cron sweep gets a 240s budget against the button's 45s, because nobody is watching a page
wait. Both stop themselves cleanly rather than being killed mid-write.

### The two pages the deletions left lopsided

Removing the campaign, template and status cards left `lg:grid-cols-3` sections holding one card
and `lg:grid-cols-2` sections holding one, so both pages rendered half-width cards next to
holes. Fixed by rebalancing rather than by padding:

- **/analytics** is now four even two-column rows. The last one renders
  `analytics_generation_daily`, **a view that had always been queried and never displayed** —
  the honest way to fill a gap is a figure already being fetched, not a chart invented to occupy
  space.
- **The public page** pipeline row went from eight cards in a four-column grid to nine in a
  three-column grid (3×3), the ninth being **Dead Address**. That card is not decoration:
  `public_stats_overview.need_email` counts the stage, so splitting `dead_email` out would
  otherwise have dropped 19 leads off the public page without a trace. Stage distribution, which
  lost its neighbour, is full width — better for an eleven-row bar list anyway.

## 13. Changelog

| Date | Change |
| --- | --- |
| 2026-08-05 | **Scheduled jobs + layout.** `/api/cron/sheet-sync` (23:59 Asia/Karachi) and `/api/cron/approve-drafts` (00:00, 07:00, 14:00, 21:00) added, sharing `guardCronRequest()` with the outreach route. The draft sweep moved to `lib/services/drafts/sweep.ts` so the button and the schedule run one function. Settings now lists all three jobs with their cron lines. /analytics rebalanced into four even rows, the last rendering `analytics_generation_daily` — queried since 0014, never displayed until now. The public page pipeline row is 3×3 with a new Dead Address card, without which the `dead_email` split would have dropped 19 leads off it silently |
| 2026-08-05 | **0026 + 0027** (must be pasted in that order — Postgres will not use a new enum value in the transaction that added it). `dead_email` becomes its own stage, so the stage filter stops reading 326 where the tiles read 307 and 19. New `lead_stage_counts` view makes the filter facets honour the archived toggle, fixing a chip that said `initial_sent 94` against a page of 93. The lead detail page stops rendering `leads.status` — the "Researching" badge and the editable Status dropdown are gone, replaced by the derived stage — and `StatusBadge` / `LEAD_STATUS_LABELS` / `STATUS_CHART_COLORS` are deleted, so nothing renders lead status anywhere. `dashboard_lead_status_counts`, `public_stats_statuses` and `dashboard_leads_safe` dropped |
| 2026-08-05 | **Chunks 2 and 3.** **0025**: the stage becomes the FIRST UNMET GATE, so it names what is blocking a lead instead of the last thing that got done — 497 leads move backwards into need_email / need_verification, keeping their drafts and approvals. Every dashboard tile and named view is now a `current_stage` query, which is what makes a count and the page it opens the same query by construction. "Emails Waiting Review" removed (it was the Approval Queue plus follow-up drafts); "Checked, Inconclusive" added for the 173 addresses a verifier answered on and could not prove. Campaigns and templates deleted outright, along with ten unread views, `leads.category`, `leads.next_followup_at` and three orphan settings rows. The lead page gets a five-state verification dropdown; the leads list swaps Status for Stage with Archived as a toggle; approval writes the version and nothing else |
| 2026-08-05 | **Audit + chunk 1.** Read-only probe of the live database found twelve problems (section 12). Fixed: Ready to Send now requires all four gates (103 → 7, of which 96 could never have been sent — 62 had no address, 4 were proven dead); the verification gate moved into `sendLeadEmail()` so the Send button and the API are covered and not just the cron; `saveResearch()` stopped nulling `researched_at`; overdue follow-ups measured from the start of today so they no longer double-count against due-today. `auto_send_initial` paused |
| 2026-08-03 | Foundation: schema, RLS, auth, middleware, workbook importer |
| 2026-08-03 | Full UI: dashboard, leads, lead detail, campaigns, templates, logs, replies, settings |
| 2026-08-03 | n8n + Google Sheets + email providers; encrypted secrets; real sending |
| 2026-08-03 | Viewers locked down to no data (migration 0009), pending their scope |
| 2026-08-03 | This guide created |
| 2026-08-03 | n8n removed (0011); Sheets write-back added; nested-`<form>` hydration bug fixed in `secret-field.tsx` |
| 2026-08-03 | 0011 confirmed applied to the live DB (the guide had it as pending) |
| 2026-08-05 | **0024**: the sheet's "research status" column decides whether research is done, carried on `researched_at`, with field presence kept as a fallback. `category` retired from every code path but the column deliberately kept, since it still holds 348 Skip / 241 Needs Automation / 112 No Website marks |
| 2026-08-05 | Draft cleaner now strips tail-only JSON debris (a trailing `"` and `}` with no leading brace), which is the shape most drafts actually have and the reason three sweeps approved nothing; trailing quotes are only stripped when unmatched, so quotes inside an email survive. The sweep now reports which leads it approved and which it left, with reasons and links, instead of three bare numbers |
| 2026-08-05 | Migrations 0015–0023 confirmed applied to the live DB, verified by probing each one's marker rather than trusting the file list. Section 11 added on deliverability and why the Gmail sender avatar is not a code problem |
| 2026-08-05 | **0023**: ticking "Email verified" now records a real verdict instead of only setting the flag (the lead kept saying "Never checked" and stayed in the paid export); permanent delete added for duplicates and junk; archived leads dropped from the default list, so archiving finally does what it says |
| 2026-08-05 | Draft cleaner handles the sheet's SEPARATE header/body columns (bare `"body": "..."` fragments, which the JSON passes skipped); verification tiles link to views that match their counts; leads table says "No email" vs "Never checked"; CSV export of leads with no address; settings sections collapsed by default via `<details>`, so a collapsed section still submits its fields |
| 2026-08-05 | Draft quality: `drafts/quality.ts` unwraps the JSON the upstream Ollama pipeline produces (tolerantly, since a multi-line body makes the JSON invalid), runs at import so nothing downstream sees a payload, and backs a "Clean and approve drafts" sweep that repairs into a new version and approves only what comes out spotless |
| 2026-08-05 | **0022**: the sender had been picking the same 6 leads every 3 minutes and refusing all 6, because `lead_pipeline.approved` (from `leads.status`) and the version status disagreed. Reconciled, and `findDueWork()` now requires the approved version so the queue cannot offer work it will reject. Added `leads:duplicates` after finding two businesses present twice |
| 2026-08-05 | All displayed timestamps pinned to `Asia/Karachi` and labelled PKT; storage and the sending window stay UTC; Settings shows the window translated into local time |
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
