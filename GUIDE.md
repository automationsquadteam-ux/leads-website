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

A cold-outreach CRM. Leads are generated and enriched **outside** the CRM, by n8n, which
writes them straight into Supabase; the CRM lets an admin review and edit drafts, and sends
email through a pluggable provider. Supabase is the only system of record — until
2026-08-10 a Google Sheet sat in the middle as the ingestion layer and a mirror, and that is
now removed entirely (section 8).

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
| Google Sheets sync, read and write-back | **Removed 2026-08-10.** n8n writes Supabase directly; see section 8 |
| Email providers (SMTP via Brevo) + real sending | Done, sending |
| Encrypted credential storage | Done |
| n8n | Not run by the website. It now writes `leads` and `email_versions` DIRECTLY (was: fed the sheet) |
| Admin review workflow (research/personalization/3 drafts/notes) | Done |
| Email versioning (`email_versions`) | Done, nothing is ever overwritten |
| Outreach lifecycle (`lead_pipeline`, derived stage + next step) | Done |
| Draft generation (template generator + Ollama) | Done, `ai.provider` setting |
| Draft cleaning (unwraps the JSON n8n produces) | Done, at import and on demand |
| Automatic follow-ups (`/api/cron/outreach`) | Done, driven by cron-job.org every 3 min |
| **Reply ingestion** | Done — Cloudflare Email Worker → `/api/inbound/reply` |
| Scheduled jobs (draft sweep, sender) | Done — two `/api/cron/*` endpoints, driven externally. Sheet sync removed 2026-08-10 |
| **Email verification** | Done — verifier CSV round trip, verify-on-send, manual verdicts |
| Public front page at `/` (no login) | Done, anon reads six aggregate views |
| Analytics page | Done |
| Modular outbound sync layer | **Removed 2026-08-10** — its only target was the sheet |
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
| 0026 | `20260805200000_add_dead_email_stage_value.sql` | ✅ yes — corrected 2026-08-10, this row was stale (see below) |
| 0027 | `20260805210000_dead_email_stage_and_status_views.sql` | ✅ yes — corrected 2026-08-10 |
| 0028 | `20260806120000_verdicts_belong_to_an_address.sql` | ✅ yes — corrected 2026-08-10 |
| 0029 | `20260810090000_dedupe_key_default_on_insert.sql` | ✅ yes — pasted 2026-08-10 |
| 0030 | `20260810100000_sweep_checked_flag.sql` | ✅ yes — pasted 2026-08-10 |
| 0031 | `20260810110000_normalize_blank_leads_fields.sql` | ❌ **NOT YET** — paste `schema-update-21-normalize-blank-fields.sql` |
| 0032 | `20260810120000_normalize_social_links_shape.sql` | ❌ **NOT YET** — paste `schema-update-22-social-links-shape.sql` **after 0031** (see note in that file — it redefines the same function; whichever is pasted last wins, so if pasted out of order just paste 22 again) |
| 0033 | `20260810130000_retire_google_sheets.sql` | ✅ yes — pasted 2026-08-10 |
| 0034 | `20260810140000_exclude_archived_everywhere.sql` | ✅ yes — pasted 2026-08-10 |
| 0035 | `20260810150000_send_queue_view.sql` | ✅ yes — pasted 2026-08-10 |
| 0036 | `20260810160000_public_leads_contacted.sql` | ❌ **NOT YET** — paste `schema-update-26-leads-contacted.sql`. **Until it runs the public page shows `Businesses Contacted: 0`**, because the column it reads does not exist yet |
| 0037 | `20260810170000_close_stale_after_followup2.sql` | ❌ **NOT YET** — paste `schema-update-27-close-after-followup2.sql`. The sweep runs at the code default of 14 days without it; the row is what lets the Settings field persist a different number |

**0026–0028 were marked NOT YET in this table since they were written, but were actually pasted
into the live database at some point before 2026-08-09** — the `leads:duplicates --merge` run
that day read `email_verification_status` and `current_stage` off `lead_pipeline` without error,
which only 0028 and 0026/27 respectively make possible. Probed directly on 2026-08-10 to confirm:
a `current_stage = 'dead_email'` query and an `email_verifier_status` / `email_checked_address`
select both succeed. The table just never got updated after whoever pasted them. **Lesson: this
table is not evidence on its own — always probe, exactly as the next section already says.**

**Everything through 0035 is applied (confirmed 2026-08-10). 0036 is new and is NOT.**
Historical note on 0031/0032, kept because the ordering trap still applies if they are ever
re-run: Both live in `normalize_blank_lead_fields()`, one trigger doing two jobs: 0031
stops a direct writer's `""` from tripping `leads_email_format` / `leads_website_scheme`, 0032
extends the SAME function to also stop a JSON-string-shaped `social_links` (n8n sent the literal
text `"{}"`, or raw prose) from tripping `leads_social_links_is_object`. n8n hit both, back to
back, on its first two live executions — exactly the failure mode these exist to close. **Paste
21 then 22, in that order** (22 fully replaces the function 21 creates; if pasted out of order,
paste 22 again and it corrects itself, since `create or replace` always keeps whatever ran last).

Verified against the live database on 2026-08-05 by
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

**It also stops the lead being contacted, as of 2026-08-09.** It did not before: the pipeline
row was deliberately left untouched on archive (a due follow-up stayed due), and neither
`findDueWork()` nor `sendLeadEmail()` checked `leads.status`, so an archived duplicate loser
with a live `followup1_due` — exactly what `leads:duplicates --merge` leaves behind — was still
auto-emailed by the cron. `sendLeadEmail()` now refuses archived leads outright (the one gate
every send path goes through), and `findDueWork()` excludes them from all three of its
candidate queries. See the changelog entry the same date for the live leads this caught.

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

One definition, in `src/lib/import/dedupe.ts`, used by the workbook importer — and mirrored
in Postgres by `assign_dedupe_key_on_insert()` (0029) for direct writers like n8n, which is
the only other thing that creates leads now:

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
      config.ts          typed reader for non-secret settings (email/ai/outreach/sending)
      secrets.ts         AES-256-GCM encrypted credential store
      activity.ts        lead_activity writer (best-effort)
      email-versions.ts  create / activate / review never overwrites
      integration-runs.ts run history
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
| **Importing a non-component VALUE from a `'use client'` module into a server component** | `PAGE_SIZES.includes is not a function`. The server does not receive the array, it receives a client REFERENCE — an opaque object with none of the original's methods. **`next build` does not catch it** when the importing page is dynamic (ƒ), because such a page is never rendered during the build; it fails on the first real request, in production, at a line that looks obviously correct | Same fix as the row below, mirrored: put the value in a module with **no directive at all** (`lib/pagination.ts` exists for exactly this) and import it from both sides. Never re-export it from the client module either — a re-export is still a client reference. Components and hooks are fine; `type` exports are erased and always fine |
| **Exporting a non-async value from a `'use server'` file** | `A "use server" file can only export async functions, found object.` The **whole module fails to evaluate**, so *every* action in it 500s including ones that have nothing to do with the offending export. The stack points at the generated action loader, never at the real culprit, and the browser just says "Could not reach the server" | Move the value to a plain module and import it from both sides. `type`/`interface` exports are fine they are erased |
| **A Server Action toasting "Could not reach the server"** | The action did not fail every action catches and *returns*. The POST itself 500'd or 404'd. Check the **server** log, not the browser | Usually the row above. Otherwise a dev server that recompiled while the page stayed open, leaving stale action ids: reload the page |
| An AFTER trigger that clears a sibling before a partial UNIQUE index | Never runs the index is checked the instant the row hits the heap, so the INSERT already failed with 23505 | Use a BEFORE trigger (see `enforce_single_active_version`) |
| `ON CONFLICT DO UPDATE SET x = coalesce(public.tbl.x, excluded.x)` | Schema-qualifying the target is a syntax error | Alias the target: `insert into public.tbl as p ... set x = coalesce(p.x, excluded.x)` |
| Writing `current_stage` on `lead_pipeline` | Silently ignored the BEFORE trigger recomputes it | Set the gate flags; the stage follows |
| Reading `/stats` data with the service-role client | Turns one typo into a data breach on a page anyone can load | Use the plain anon client (`lib/data/public-stats.ts`); Postgres grants then make a leak impossible |
| Ollama streaming by default | Returns NDJSON, `JSON.parse` chokes halfway through | `stream: false` in the request body |
| `round(avg(x), 1) filter (where …)` | `42809: FILTER specified, but round is not an aggregate function` FILTER binds to the aggregate, not to a function wrapping it | `round((avg(x) filter (where …))::numeric, 1)` see `analytics_funnel_timing` |
| `sr-only` on a `<table>` | Does nothing useful — it hides via `width: 1px`, and a table will not shrink below its min-content width, so the "invisible" element stays full width and pushes document scrollWidth | Put `sr-only` on a wrapping `<div>`; the table inside is then clipped |
| `truncate` inside a grid/flex child | `white-space: nowrap` makes the element's MIN-CONTENT width the whole string, so without `min-w-0` the parent grows instead of the text truncating | `min-w-0` on the child. `Card` now sets it itself |
| A grid/flex child without `min-w-0` | Defaults to `min-width: auto`, so it refuses to shrink below its widest unbreakable content — one long string widens the whole page. Under the shell's `overflow-x-hidden` that CLIPS rather than scrolls, so right-aligned buttons become unreachable | `min-w-0` on every grid/flex child that holds variable-length content. Re-check it for each NESTED grid; the fix does not inherit |
| Text beside a `whitespace-nowrap` sibling in a `justify-between` row | Badge and Button are both nowrap, so they keep full width and the text absorbs all the squeeze — two or three letters per line | `flex-wrap` on the row and `min-w-0` on the text |
| `table-fixed` + `w-full` on a narrow screen | Column widths become a RATIO, not a floor — the table shrinks into the viewport and every cell becomes an ellipsis instead of scrolling | Give the table a `minWidth` equal to the sum of its column widths; `TableWrap`'s `overflow-x-auto` then has something to scroll against |
| Querying an `is_admin()`-gated VIEW with the service-role client | Returns **zero rows, silently** — service-role bypasses RLS on a table, but a predicate in a view body is a plain WHERE clause it does not satisfy. Killed every automatic initial send for four days (0035) | Give machine callers their own view with no `is_admin()` in the body, protected by GRANTS (`revoke ... from anon, authenticated`) — see `lead_send_queue` |
| Adding a column anywhere but the END of an existing `create or replace view` | `42P16: cannot change name of view column "x" to "y"`. Replace can only **append**; inserting a column reads as renaming the one already in that position | `drop view if exists …;` then `create view …`. Add `cascade` only if something depends on it check first, because cascade silently drops dependents too |

---

## 8. Integrations

All services live in `src/lib/services/` and are called only from Server Actions in
`src/lib/actions/integrations.ts` (or `review.ts`), or from the cron route handler.

**n8n writes Supabase directly. The Google Sheet is gone (2026-08-10).**

The sheet used to be the ingestion layer: n8n appended rows, `sheet-sync.ts` pulled them in,
and `sheet-writer.ts` pushed CRM edits back. All of it is deleted — `google-sheets.ts`,
`sheet-writer.ts`, `sheet-sync.ts`, the whole `lib/services/sync/` dispatcher,
`/api/cron/sheet-sync`, the Sync Data button and the Google Sheets settings card. Migration
0033 removes the six `sheets.*` settings rows and both stored Google credentials.

**Supabase is now the only system of record.** There is no mirror, so there is no
write-back, no "which side wins" rule, and no sync failure to fold into a toast.

### The n8n contract — what it writes, and the two rules that keep it safe

**Workflow 1, lead discovery → `INSERT INTO public.leads`.** `business_name` is required;
everything else optional. **Never send `dedupe_key`** — `assign_dedupe_key_on_insert()` (0029)
computes it, using the same `email > website > name+city` priority as `buildDedupeKey()`. A
direct writer computing its own key slightly differently is how you get the 0028 duplicate
mess back, invisibly, with no `sheet_row_number` left to catch it by. Use
`Prefer: resolution=merge-duplicates` with `?on_conflict=dedupe_key` so a re-run upserts
instead of erroring. `source` should say where it came from (`n8n:lead-gen`).

**Workflow 2, research + draft → an UPDATE and an INSERT, not one write.**

- Research fields go onto `leads` (`research_summary`, `website_observations`,
  `automation_opportunities`, `ai_chatbot_opportunities`,
  `website_improvement_opportunities`, `personalization`, `interesting_facts`,
  `outreach_angle`, `social_links`), plus `researched_at` — that timestamp is what 0024 made
  authoritative for "research is done", and is the direct replacement for the sheet's
  "research status: Done" column.
- **The draft goes into `email_versions`, never onto `leads.subject_line` / `draft_email`.**
  `mirror_active_initial_draft()` only ever copies FROM an active version ONTO `leads`;
  there is no trigger the other way. A draft written straight onto `leads` sets
  `draft_ready` (that gate reads `leads.draft_email`) but is invisible to `runDraftSweep()`,
  to the review UI and to version history, and can never become `approved`, because
  `sync_pipeline_from_version()` is the only thing that sets that flag. Insert
  `type='initial'`, `status='draft'`, `active=true`, `generated_by='n8n:ollama'`; leave
  `version_number` out (a trigger assigns it). The mirror onto `leads` is then automatic.

Blank strings are safe in both workflows: `normalize_blank_lead_fields()` (0031/0032) turns
`""` into NULL for the optional identity fields and forces `social_links` to a JSON object,
which is what stopped n8n's first two live runs failing on `leads_email_format` and
`leads_social_links_is_object`.

`sheet_row_number` and `sheet_synced_at` are left NULL for n8n leads. **The columns are kept
deliberately** — they are the only provenance for the 762 leads that did come in through the
sheet, and `leads:duplicates` still groups by row number to find 0028-style pairs.

### What happens to an n8n draft after it lands

Nothing has to be told about it; four triggers and one cron do the whole thing:

1. `set_email_version_number()` assigns the version number, `enforce_single_active_version()`
   deactivates any previous active draft for that (lead, type).
2. `mirror_active_initial_draft()` copies subject/content onto `leads`, so the sender, the
   CSV exports and the dashboards — all of which predate versioning — keep working unchanged.
3. `sync_pipeline_from_version()` sets `lead_pipeline.draft_ready`.
4. The stage re-derives to the **first unmet gate**, so the lead shows what is actually
   blocking it (usually `need_email` or `need_verification`, not `review`).
5. `/api/cron/approve-drafts` (00:00, 07:00, 14:00, 21:00) runs `runDraftSweep()`, which
   repairs the draft into a NEW version and approves it **only if zero blocking issues
   remain**. Anything still broken gets `sweep_checked_at` set (0030) and is left alone until
   a human edits it into a new version.
6. Approval sets `lead_pipeline.approved`. Ready to Send additionally requires an address and
   `email_verification_status = 'valid'`, so an approved draft still cannot leave until the
   address is proven.

**Follow-ups are NOT n8n's job.** It only writes `initial`. `followup1` / `followup2` are
generated by the CRM's own generator (`ai.provider`, currently `template`) when the scheduler
finds one due and none drafted.

**What the sweep can and cannot catch.** `inspectDraft()` is a STRUCTURAL check —
placeholders, stray braces, code fences, escaped newlines, wrapping quotes, missing subject.
It has no idea what the email *says*. A grammatical, well-formed draft that pitches the wrong
industry to the wrong business passes every check and gets auto-approved. See the 2026-08-10
changelog entry: all 39 of n8n's first drafts were structurally repairable and **none** were
semantically correct.

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

### "Approved" means one draft, and a lead has three

A find-and-replace turned every "Approved" into "Initial Approved" on 2026-08-06, including
`z.enum([... 'initial approved' ...])` in `actions/leads.ts`. That is the DATABASE enum
`public.lead_status`, which has no such value, so the deploy failed to compile — and would have
failed at the INSERT even if it had.

The vocabulary, settled:

| Thing | Where | Reads |
| --- | --- | --- |
| `email_versions.status = 'approved'` | draft workspace chip | **Approved** — this draft is signed off, whichever of the three it is |
| `lead_pipeline.approved` | pipeline panel gate | **Initial email approved** — only the initial version sets it |
| stage `approved` | badges, tiles | **Initial Approved** |

The chip must NOT say "Initial", because it renders above follow-up 1 and follow-up 2 as well.
Approving a follow-up marks that draft and moves no stage: `sync_pipeline_from_version()` sets
the gate for `type = 'initial'` and for nothing else.

**Wording belongs in `STAGE_META`, `NEXT_STEP_META` and `GATE_LABELS`.** Nothing a user reads
comes from a database enum, so relabelling never needs a migration — and editing an enum to
change a label breaks the build at best.

### The cleaner fills what it knows and refuses to guess

Two additions took the pending queue from **0 clean out of 92 to 82**:

- **Matched wrapping quotes.** `stripJsonDebris()` only stripped a quote when the count was ODD,
  reading an even count as "these are part of the prose". A body that both opens and closes on a
  quote is a JSON string value that lost its key, and that was **60 of 92** drafts — the single
  biggest reason anything was stuck. Stripping the outer pair is right even when the email quotes
  something internally: four quotes minus the outermost two leaves the inner pair where it belongs.
- **Placeholders answered from the lead.** `[City]`, `[Niche]`, `[Business Summary]`,
  `[Website Observations]`, `[Your Name]` and friends are filled from `leads` and the configured
  from-name. `fillKnownPlaceholders()` takes a `DraftContext` rather than reading the database,
  so `quality.ts` stays pure and a script, an action and a client component keep sharing it.

**It never guesses.** `[Owner's Name]`, `[insert number]` and
`[specific observation about their website]` have no answer here, and inventing one is how "Hi
[Owner's Name]" becomes "Hi Sarah" for someone called Ahmed. Those stay, and the draft stays
blocked — which is the entire reason that check is blocking.

The one exception is a SALUTATION built round an unknown name: "Hi [Owner's Name]," carries no
information beyond "Hi," so it collapses. Every other position keeps its placeholder, because
elsewhere the sentence was built around the missing fact.

Braces are stripped only when a `{` or `}` sits **alone on a line**. A brace inside a line is
almost always a token someone still has to deal with, and deleting it silently would turn a
visible problem into an invisible one.

### Why the whole app could be dragged sideways on a phone

The layout collapsed to one column correctly; the document was simply wider than the viewport. A
grid or flex child defaults to `min-width: auto` — it refuses to shrink below its widest CONTENT
— so one long unbreakable string (a curl command, a URL, an email address) widened its column,
which widened the page.

Fixed at the cause with `min-w-0` on the shell's content column, plus `overflow-wrap: break-word`
on the body. `overflow-x: clip` on `html`/`body` is the belt-and-braces half; **`clip` and not
`hidden`**, because `hidden` creates a scroll container and would break `position: sticky` on the
topbar.

### The email log had no way off page 1

`getEmailLogs()` has never filtered by date, and the page has always read `?page=` — but nothing
ever rendered a control to change it. So the log was frozen on the newest 50 rows, and on a day
that used the full send quota those 50 rows WERE that day. It looked exactly like "the log only
keeps today"; all 87 attempts were there the whole time, 35 of them one page away.

`LogPagination` is a thin client wrapper around the shared `Pagination`, because that component
takes callbacks and the log page is a server component. Page and size live in the URL, as they do
on the leads list.

**Worth checking whenever a list is added:** a `?page=` the server reads and the client cannot set
is invisible, and it fails in the most misleading way possible — the data looks deleted.

### Sending days were hardcoded, and Save reverted them

`updateSettings()` wrote `days: [1, 2, 3, 4, 5]` as a literal. So the sending days could not be
changed from the UI at all — and worse, **pressing Save on the Settings page silently reverted
whatever was in the database back to Monday–Friday**, which would have undone any direct edit at
the next unrelated settings change.

It is a real seven-day control now, carrying a `wh-days-present` marker for the same reason the
public-stage checkboxes do: an unchecked checkbox never appears in FormData, so without a marker
"no days ticked" and "this form was not on screen" are indistinguishable. Saving with none ticked
is refused rather than accepted, because zero days means nothing ever sends.

Live value is now `{"start":"09:00","end":"17:00","timezone":"UTC","days":[1,2,3,4,5,6,7]}` —
every day. Note the window is **UTC**, which is 14:00–22:00 in Asia/Karachi; the Settings page
spells that translation out beneath the fields, because "09:00–17:00 UTC" next to a log line
reading "14:32 PKT" is the pair that gets misread.

### Editing an email created a duplicate lead. This is the leak.

`dedupe_key` was computed once at import and nothing recomputed it, so:

1. lead exists with `dedupe_key = 'email:info@apatchicars.com'`
2. an admin corrects the address to `showroom@apatchicars.com`
3. write-back pushes the new address to the sheet row
4. the next sync reads that row, computes `email:showroom@apatchicars.com`, finds
   no lead with that key, and **inserts a new lead**

Found in the live data as **eight sheet rows claimed by two leads each**, three of them
email-to-email pairs that no other path could produce:

```
row 686  Ali & Sons    email:ascon@ali-sons.com     || email:last@ali-sons.com
row 723  Apatchi Cars  email:showroom@apatchicars   || email:info@apatchicars.com
row 121  Modern Mart   email:contact@gmail.com      || email:info@modernmart.lk
```

plus four leads whose stored key no longer matched their own address, caught mid-drift. **Several
of the pairs show `logs=1` on BOTH rows — those businesses were emailed twice.**

0028 recomputes the key in a BEFORE trigger at the moment of the edit. GUIDE used to warn against
recomputing keys; that warning was about a bulk backfill over every row, where one collision fails
an entire sync. One row at a time is the opposite case — a collision means "another lead already
owns that address", which is a true and useful thing to say to whoever just typed it.

Only an already-`email:` key is recomputed. A `site:` or `name:` key keeps its identity, because
those were chosen when there was no address and the sheet still matches on them.

`npm run leads:duplicates` now groups by sheet row as well as by address, which is the only way to
see this class — the two rows have DIFFERENT addresses, so email grouping cannot find them.

### A verdict belongs to an address, not to a lead

The same root cause, second symptom. NeverBounce judged `info@abc.com`; someone corrected a typo
to `info@abd.com`; the verdict stayed:

- `valid` → the new, unchecked address was marked verified and **passed the send gate**
- `invalid` → the new, correct address stayed dead, blocked for ever, counted in Dead Addresses

`email_checked_address` records which address each verdict was about, and changing to a different
one resets the verdict, its source, the verifier's own verdict and the timestamps.

That reset is what makes **"a verifier said invalid → never send"** safe to enforce in
`sendLeadEmail()`. It applies only while the address is the one that was judged: correct the typo
and `email_verifier_status` is already NULL, so the block never fires. That is exactly the
difference between "I fixed the typo" and "I disagree with the bounce", and it needs no override
switch that could be misused.

### Send priority — ordering, never gating

`email_verifier_status` keeps the last NON-manual verdict, so a human override no longer erases
what the machine found. `compute_send_priority()` reads the pair:

| Tier | Means |
| --- | --- |
| **1** | a verifier said valid, or a real email was already delivered |
| **2** | you confirmed it, and no machine had said anything against it (catch-all, or never checked) |
| **3** | you confirmed it after the verifier tried and gave up (unknown) |
| **9** | not sendable — unverified, or the verifier proved THIS address dead |

`findDueWork()` orders initial sends by priority then `approved_at`, reading `pipeline_board`
because the view computes it. Every tier-1 lead goes before any tier-2. **Nothing is gated:** an
address confirmed from the company's own website is worth mailing, it just waits behind the ones a
verifier proved, so a bad hand-confirmation costs less reputation.

### The sheet write-back only touches what changed

The write has always been per-cell — one single-cell range per column, and a column whose header is
not in `WRITEBACK_COLUMNS` is never touched. But **every mapped column was rewritten on every
sync**: `push()` accepted a `fields` argument and ignored it, with a comment arguing that a
batchUpdate costs one HTTP call either way.

Cost was never the issue. A column the CRM holds as NULL is written as an empty string, so editing
one note re-stamped a dozen unrelated cells and blanked any that had been filled in by hand
upstream. Each `WritebackColumn` now declares which `SyncField` group makes it worth rewriting, and
only those columns are sent.

### Archived is a filter, not an "also show"

"Show archived" mixed two archived leads into seven hundred live ones, which is not a way to look
at them. It shows **only** the archive now, and the stage facets count archived leads in that mode
— the difference between `lead_count_all` and `lead_count` in `lead_stage_counts`.

### An empty Website cell is a job, not a dash

A lead with no website is the moment you go and look the business up, so the leads table shows a
**Look up** link there instead of an em dash — a Google search for the business narrowed by its
city and country. `googleSearchUrl()` in `lib/utils.ts` builds it; blank parts are dropped rather
than producing double spaces, and `encodeURIComponent` handles the Cyrillic, Vietnamese and
bracketed names this dataset actually contains.

The location is the whole point. "Konyha Restaurant" returns every restaurant of that name on
earth; "Konyha Restaurant Budapest Hungary" returns the one on screen. All 723 leads carry both a
city and a country, so the query is never vague.

It appears on **every** lead without a website — 112 of 723, of which 86 DO have an email address.
Restricting it to leads missing an address was the obvious-looking choice and the wrong one: an
address that exists still gets verified by hand sometimes, and that starts with the same lookup.

`stopPropagation` on the click is load-bearing: the table row itself navigates to the lead, so
without it a click would open the search AND leave the page.

### The verification verdict stages, like every other edit on the lead page

The Email address dropdown used to write on `onChange`. Everything else on that page — Business
information, the research panels, the draft editor — stages an edit and waits for Save, and this
control being the exception mattered rather than merely looking inconsistent: choosing **Dead**
takes the lead out of every queue and stops the sender, so brushing the wrong option with a
scroll wheel had real consequences and no confirmation.

It now has its own Save and Cancel, appearing only when the selection differs from what is
stored, with the hint under the select following the SELECTION so it describes what Save is about
to do.

The gate checkboxes below it still commit on click. They are single, obvious, reversible facts;
a Save button for a tick box is ceremony.

**The dirty-state idiom:** the component compares the incoming prop to a `saved` state during
RENDER and resets the selection when they differ, so a completed save that revalidates the page
clears the dirty flag by itself. `lead-detail.tsx` does the same thing, and for the same reason —
doing it in an effect costs an extra cascading render.

### Pause versus close, for a reply that says no

Both stop the sending and both are reversible, but they mean different things and the lead page
now says so outright:

- **Pause** (`auto_followups = false`) — the lead keeps its stage and stays in every queue and
  count. For "not right now, try me next quarter".
- **Close** (`closed` set) — the sequence is over. The lead leaves every queue and every dashboard
  figure, and its stage reads Closed. For a no, for a conversation that has moved to your inbox,
  and for a lead that turned out to be wrong.

An unsubscribe closes the workflow automatically and sets `auto_followups = false` as well;
`replied` on its own only changes the next step, which is why a reply still needs a decision.

### Two scheduled jobs, neither of them scheduled by this app

Both take the same shared-secret check — `guardCronRequest()` in `lib/cron/authorize.ts`,
moved out of the outreach route the moment there was a second caller, because a security
check copied three times is a security check that ends up subtly different in one of them.

| Endpoint | Cron | Does |
| --- | --- | --- |
| `/api/cron/approve-drafts` | `0 */4 * * *` | The same `runDraftSweep()` as the Clean-and-approve button |
| `/api/cron/outreach` | `*/3 * * * *` | Sends what is due |

**There was a third, `/api/cron/sheet-sync` at `59 23 * * *` Asia/Karachi.** It is deleted
along with the rest of the Sheets code (2026-08-10). **Delete its schedule in cron-job.org
too** — the endpoint now 404s, so an orphaned schedule is a job that fails every night
forever and trains you to ignore the failure mail.

**The sweep runs every 4 hours** (`0 */4 * * *`, changed 2026-08-10 from an explicit
`0 0,7,14,21 * * *`). Four divides 24 evenly, so the step syntax is honest here — 00, 04, 08,
12, 16, 20, six runs a day. **This is exactly what `0 */7 * * *` could NOT do**: cron restarts
its count at midnight, so a 7 is 00, 07, 14, 21 and then a three-hour gap, which is why that
schedule had to be written as an explicit hour list. Check the arithmetic before using `*/n`
on hours — only divisors of 24 (1, 2, 3, 4, 6, 8, 12) behave the way they read.

**`vercel.json` was deliberately left alone.** It already declares one cron; Vercel's Hobby plan
allows two, and adding two more would fail the deploy rather than degrade. cron-job.org is what
actually drives these — it also speaks timezones, so a schedule can be set in Asia/Karachi
instead of being hand-converted to UTC and silently breaking at a DST boundary somewhere.

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
| 2026-08-10 | **Mobile, round three — measured this time, not reasoned about.** The previous two rounds fixed real bugs but missed the ones actually on screen, so this pass drove a headless Chrome at 386×800 against every page with a temp admin session and asserted `document.scrollWidth === window.innerWidth`, listing any element wider than the viewport. Four more causes, all of them the same family: **(1) `CollapsibleSection`'s badge** was `shrink-0` beside a `min-w-0 flex-1` title, and every Badge is `whitespace-nowrap` — so a badge reading "From: send@team-automationsolutions.me" (a string this codebase introduced when the sheet name was replaced in 0033) kept its full ~250px and left the title ~30px, rendering "Integrations" as `Int/eg/rat/io/ns` down the card. **`flex-wrap` does not fix this**: with `min-w-0` the browser can always satisfy the row by shrinking the title to nothing instead of wrapping the badge, so the two must be told to STACK below `sm`. **(2) The draft tablist** was a plain `flex` totalling ~400px once each tab carried its version chip and sent icon; it overflowed the card and the shell clips rather than scrolls, so "Follow-up 2" was unreachable — now `overflow-x-auto` with `shrink-0` tabs. **(3) `Card` now carries `min-w-0` itself.** A dashboard activity card measured **948px** on a 386px screen: `truncate` sets `white-space: nowrap`, whose MIN-CONTENT width is the entire string, and a grid child defaults to `min-width: auto` — so the text never truncated, it just widened the card. Setting it on the component means the next card dropped into a layout cannot reintroduce it. **(4) `sr-only` on a `<table>` does nothing** — it hides by setting `width: 1px`, and a table refuses to shrink below min-content, so the chart accessibility fallbacks were ~400px absolutely-positioned elements giving /analytics and the public page a horizontal scrollbar with nothing visible in it. The class belongs on a wrapping `<div>`. Final measurement: all eight pages report `doc = win = 386`, no element exceeding the viewport outside a deliberate `overflow-x-auto` scroller |
| 2026-08-10 | **0037 — an exhausted sequence closes itself.** A lead that got follow-up 2 and never answered has nothing left to do (`compute_next_step()` already returns `close_workflow`), but nothing ever performed the close, so they piled up at stage `followup2_sent` inside every figure describing live prospects — 56 in the first two days of sending. `closeExhaustedSequences()` runs inside `runOutreachCycle()` rather than in a new cron route: it is one UPDATE that normally touches zero rows, so the existing 3-minute tick carries it for free and there is no third endpoint or cron-job.org schedule to register. Two predicates are load-bearing: **`replied is null` lives in the WHERE clause**, not in a prior SELECT, because a reply landing between a read and a write is the one outcome here that costs a conversation; and **`auto_followups` is required**, because Pause means "try me next quarter" and a timer must never let it decay into a Close. Placed ABOVE the working-hours and daily-limit guards (closing sends nothing, so neither has any bearing on it) but BELOW `sending.paused`, which is documented as a global kill switch. Skipped on a dry run. Threshold is `outreach.close_after_followup2_days`, default 14, 0 to disable. Verified against live data: 0 would close at 14 days, exactly the known 56 at 2 days, and the replied / paused / already-closed rows are all spared |
| 2026-08-10 | **Mobile, round two — three separate causes, all the same underlying rule.** (1) **Lead detail was unusable on a phone**: the two grid columns had no `min-w-0`, and a grid child defaults to `min-width: auto` — it refuses to shrink below its widest unbreakable content. One long draft body widened the column, which widened the grid past the viewport, and because `main` clips with `overflow-x-hidden` rather than scrolling, the right edge of every card was cut off. The Save/Cancel row sits at `justify-end`, so the button you most need was the first thing to vanish. This is the identical trap already documented on the shell's own container — every nested grid re-introduces it. (2) **`CardHeader` now wraps by default**: a header is a title plus controls, and on a narrow screen that pair must become two rows rather than one row wider than the card. (3) **`SecretField`'s label and the settings save bar's paragraph were being crushed by `whitespace-nowrap` siblings** — every `Badge` and `Button` carries it, so in a non-wrapping `justify-between` row they held full width and the text beside them took all the squeeze, rendering two or three letters per line. `flex-wrap` + `min-w-0` on the text side fixes both |
| 2026-08-10 | **Mobile.** Three real causes, not a styling pass. (1) **Tables were crushed, not scrollable** — `table-fixed` + `w-full` makes per-column widths a RATIO once they stop fitting, so ten columns declared at 130–240px rendered ~30px each on a phone and every cell became an ellipsis. `TableWrap` always had `overflow-x-auto`; what was missing was a floor to scroll against, so `DataTable` now sets `minWidth` from the sum of its column widths. `overscroll-x-contain` added too, so swiping past the end of a table no longer triggers the browser's back gesture. (2) **`MetricCard` truncated its own label** — a two-column grid on a 360px screen leaves ~150px, which cut "Initial Approval Queue" to "Initial Appr…"; labels now wrap below `sm` and truncate from `sm` up, and the value steps down to `text-xl`. (3) **Email logs got a real mobile layout** — seven columns cannot be squeezed into a phone, and horizontal scrolling makes you drag sideways to answer "did this bounce?", which is the whole point of the page. Below `md` each attempt is a card; the table returns at `md`. Both render the same `rows` — one query, one definition. The two analytics tables got a `min-w-[380px]` scroll floor for the same reason as (1) |
| 2026-08-10 | **0036 — the public page counts businesses reached, not messages sent.** `emails_sent` counts `email_logs` rows, so ten businesses in a full three-step sequence published as "25 emails sent" — our activity, not our reach — and `reply_rate_pct` inherited the same denominator, so it FELL every time a follow-up went out even though the conversations were unchanged. Adds `leads_contacted` (distinct non-archived leads with `first_email_sent`) and re-bases reply rate on it. Counted from `lead_pipeline`, NOT from `email_logs where email_type = 'initial'`: it is one row per lead so it is distinct by construction, and sheet-era upstream sends have no `email_logs` row at all (0015/0018 write `first_email_sent` directly), so counting logs would drop every lead emailed before this CRM recorded sends. `emails_sent` / `emails_attempted` / `emails_bounced` deliberately stay MESSAGE counts — bounce rate is a per-message property of the sending domain and would be wrong per business. The daily activity chart also stays per-message |
| 2026-08-10 | **0035 — the scheduled sender has not auto-sent an initial email since 0028, and reported success the whole time.** Symptom: the cron fires every 3 minutes, writes a green `integration_runs` row saying "Nothing is due, considered: 0", while 20 leads sit approved, verified and unsent. Cause: 0028 moved the initial-send query from the `lead_pipeline` table to the `pipeline_board` view because the new `send_priority` is computed there — but `pipeline_board`'s body ends `where public.is_admin()`, and the scheduler runs on the SERVICE-ROLE key. **Service-role bypasses RLS on a TABLE; it satisfies no predicate written into a VIEW body**, which is an ordinary WHERE clause, not a policy. Verified live: `pipeline_board` returns 0 rows to the service-role client, `lead_pipeline` returns all 809. The failure was invisible because "0 due" and "0 visible" produce the identical run record. Fix: `lead_send_queue`, a machine-facing view with no `is_admin()` gate, protected by GRANTS instead (revoked from anon/authenticated, granted to service_role) — the same shape as `integration_secrets`, which is protected by having no grants rather than by a policy. It also excludes archived leads, so the extra round trip `findDueWork()` was making for follow-ups is gone. `pipeline_board` is untouched: it feeds the admin UI where `is_admin()` is doing real work. **The trap was already documented** — the deleted `lib/services/sync/index.ts` carried a comment about exactly this ("the service-role client is not an admin JWT so this is null in practice") while the scheduler made the same mistake three files away |
| 2026-08-10 | **0034 — an archived lead is counted nowhere.** Reported as Dead Addresses reading 12 against a list of 11. Both queries were right about themselves: the list resolves ids through `lead_pipeline` and then queries `leads`, which excludes archived by default, while every COUNT queried `lead_pipeline` directly — and **`lead_pipeline` has no status column**, so it structurally cannot express the filter. The same bug class as GUIDE §2's "a tile must link to exactly the rows it counted", through a different door. Fixed in both places: `public_stats_overview`, `public_stats_stages`, `public_stats_leads` and `analytics_stage_distribution` now join `leads` and exclude archived, and every count in `lib/data/admin-dashboard.ts` routes through `activePipelineCount()` / `activePipelineLeadIds()`, which read `pipeline_board` (same rows plus `lead_status`) — **never reach for `lead_pipeline` directly in that file again**. `public_stats_leads` was also a disclosure fix: with `public.show_leads` on, an archived duplicate could be published by name on the front page. `email_logs` / `replies` figures deliberately still include archived leads, because a message that left the building stays sent. `pipeline_board` itself is unchanged — the leads list needs to show archived rows when the toggle is on |
| 2026-08-10 | Draft sweep schedule changed to **every 4 hours** (`0 */4 * * *`, six runs a day) from the explicit `0 0,7,14,21 * * *` four-times-a-day list. Safe because 4 divides 24; see the note under the scheduled jobs table for why 7 could not be written that way |
| 2026-08-10 | **n8n output verified good after the prompt fix.** 52 active n8n leads (20 Plumbing, 17 HVAC, 15 Solar); 45 of 52 active drafts pass every check, naming the right business, niche and city with real detail pulled from the site. Remaining 7: three never name the business (generic but not wrong), two run 236–244 words against the prompt's 120–180 target, one still carries a bracket placeholder and will be left by the sweep, and one (`Solar Liberty`) still claims the business has no website when it has one — the `_websiteFetchStatus` branch bug, an n8n-side fix |
| 2026-08-10 | **The n8n prompt fix verified, and the sweep's semantic blind spot bit for real.** After correcting Workflow 2's expressions (they were still using the Sheets column names with their leading spaces — `$json[' Niche']` — against a Supabase row, so every field resolved empty; and the prompt's own example block hardcoded "the travel industry"), output is clean from **08:27:54** onward. `J. Marin Heating` is the A/B: v2 at 08:20 opens "Congratulations on operating in the travel industry", v3 at 08:27:54 reads correctly. **But the draft sweep then ran at ~09:00 and approved three of the pre-fix travel drafts** — it repaired them structurally (quotes, braces), found zero blocking issues, and signed them off, exactly as section 8 warns: `inspectDraft()` cannot see meaning. A second prompt bug surfaced too — 6 drafts told businesses with live websites that they had none, because the "If NO website exists" branch fires on an empty `_websiteFetchStatus` rather than an absent URL (only 2 of the 6 had actually failed to fetch). Remediation: `outreach.auto_send_initial` set to **false** (10 leads were passing every send gate with the cron 3 minutes away and nothing sent yet), 20 versions across 10 leads rejected, their research and `subject_line`/`draft_email` cleared, and `research_complete`/`draft_ready`/`approved` explicitly turned off. 0 bad active drafts remain; 25 n8n leads sit in Workflow 2's queue for a clean redo |
| 2026-08-10 | **The Google Sheet is retired.** n8n now writes `leads` and `email_versions` straight into Supabase, so the sheet is neither the ingestion layer nor a mirror. Deleted outright: `google-sheets.ts`, `sheet-writer.ts`, `sheet-sync.ts`, the entire `lib/services/sync/` dispatcher, `/api/cron/sheet-sync`, the Sync Data button on the leads toolbar, the Google Sheets settings card and both `runGoogleSheetSync` / `testGoogleSheetsConnection` actions. **The sync layer went with it, not just its target** — `syncLeadChange()` had exactly one `SyncTarget`, so with the sheet gone every one of its ~20 call sites was spending four queries to resolve a snapshot for nobody, and `appendSyncMessage()` could only ever return its input unchanged. **0033** removes the six `sheets.*` settings rows and both stored Google credentials; `leads.sheet_row_number` / `sheet_synced_at` are deliberately KEPT as provenance for the 762 leads that arrived that way and because `leads:duplicates` still groups by row number. Remember to delete the sheet-sync schedule in cron-job.org and revoke the service-account key at the Google end |
| 2026-08-10 | **n8n's first 39 drafts are structurally perfect and semantically wrong.** Verified by running the real `repairDraft()` / `inspectDraft()` over every live `generated_by = 'n8n:ollama'` version: all 39 repair cleanly and **would be auto-approved by the next sweep**. But 36 of 39 pitch *travel industry* services to New Orleans plumbers and HVAC companies, 26 leak literal schema words into the prose (`Niche`, `City, Country`, `Business Name` used as if they were values), and 27 never name the actual business. Zero were correct. The lesson worth keeping: **`inspectDraft()` is a STRUCTURAL check only** — placeholders, braces, fences, quotes, missing subject. A fluent, well-formed email selling the wrong thing to the wrong person passes every gate the sweep has. The prompt in n8n's Workflow 2 is not receiving the lead's own `niche`/`city`/`country`/`business_name`; that is an n8n-side fix, and nothing in this codebase can detect it. **All 39 were set to `status = 'rejected'`** with the reason in `review_note`, which takes them out of the sweep queue permanently (rejected is not `draft`) while keeping them readable in version history; 0 leads were left flagged `approved`. A corrected rerun inserts fresh versions that supersede them normally. **The cause was NOT the 20-per-trigger batching** (that was the first hypothesis, and the timestamps do show bursts ~12s apart): zero n8n leads are travel businesses, so nothing could bleed from a sibling item. The contamination is one layer upstream, in `research_summary` itself — `"Travel Agency, operating in the travel industry"` written for an HVAC company, `"serving [City], [Country]"` with the literal brackets intact, `"in the city of, country"` where the expressions resolved to empty strings. Workflow 2's prompt was written with literal placeholder words instead of `{{ }}` expressions, over leftover travel-agency wording; the email node then faithfully repeated the poisoned research. All 37 n8n leads had their research fields and `researched_at` cleared so the fixed workflow re-picks them up, and `research_complete` / `draft_ready` were explicitly turned OFF — the triggers never turn a gate off by design, so a blanked field would otherwise have left 10 leads sitting in the Approval Queue claiming research they no longer had |
| 2026-08-10 | **0032 — `social_links` normalizes to an object too.** Same trigger as 0031, same day, second failure from the same source: n8n's "Update a row" node (Workflow 2, writing research back onto `leads`) sent `social_links` a JSON *string* — the literal text `"{}"`, or the raw "Social Links" prose un-parsed — which is valid jsonb but not an object, tripping `leads_social_links_is_object`. `normalize_blank_lead_fields()` now also handles this: a string that parses as a JSON object is unwrapped and used, a string that does not (real prose) survives under `_raw` — mirroring `normalizeSocialLinks()` in `lib/import/normalize.ts` exactly — and anything with no sensible object reading (blank, an array, a bare JSON null) becomes `{}`. Redefines the SAME function 0031 created rather than a second trigger, so paste order matters: 0031 then 0032 |
| 2026-08-10 | **0031 — blank fields from a direct writer stopped tripping the format checks.** n8n's very first live insert (Workflow 1, a lead with no email) failed with `leads_email_format` violated: n8n sends `""` for "no value", and the CHECK constraint only exempts `NULL`. `normalize_blank_lead_fields()`, a BEFORE INSERT OR UPDATE trigger, turns blank/whitespace-only email, website, phone, city, country and niche into NULL before the CHECK constraints (and dedupe-key computation) ever see them — the same one-rule-enforced-once fix as 0029, rather than asking every n8n expression to remember `\|\| null`. `business_name` is deliberately left alone; a blank one should fail loudly. 0029 and 0030 (previous entry) confirmed pasted and live the same day |
| 2026-08-10 | **Groundwork for n8n writing directly to Supabase, plus the draft sweep stops re-checking itself forever.** Two new migrations, both pending (§2 has the paste instructions): **0029** adds `assign_dedupe_key_on_insert()`, a BEFORE INSERT trigger that computes `leads.dedupe_key` in Postgres whenever a caller leaves it blank — needed because a direct writer (n8n) has no reason to replicate `buildDedupeKey()` correctly, and getting it wrong silently reproduces the 0028 duplicate-key bug with no `sheet_row_number` to ever catch it. **0030** adds `email_versions.sweep_checked_at`, set by `runDraftSweep()` the moment a draft is examined and still has a blocking issue afterwards; the sweep's query now excludes anything already flagged, so the same permanently-stuck ~10 drafts stop being re-parsed and re-reported as newly blocked four times a day. No manual reset needed — any new version (an edit, or a repair) starts NULL again. Also discovered and corrected while doing this: the migration status table had 0026–0028 marked NOT YET despite being live on the database since before 2026-08-09 (confirmed by direct probe) — a stale row that outlived whoever actually pasted them in |
| 2026-08-09 | **Archiving never stopped the sender — fixed.** `archiveLead()` only ever set `leads.status`, on the stated theory that archiving is "a visibility choice" and the pipeline row should stay untouched. But `findDueWork()` reads `lead_pipeline` (and `pipeline_board` for initial sends) directly and never checked `leads.status`, so an archived lead with a live `followup1_due`/`followup2_due` — exactly what `leads:duplicates --merge` leaves on every loser — was still picked up by the `*/3 * * * *` cron and mailed on schedule, usually to the SAME address as the surviving lead. Confirmed live: 6 of the 8 leads archived by today's merge were still armed, one (`Lanka Safe Tours`) sitting due since 2026-08-06. Fixed in the one place every send path goes through: `sendLeadEmail()` now refuses an archived lead outright, and `findDueWork()`'s three candidate queries (followup1, followup2, initial) all exclude `status = 'archived'` too, so the cron's `considered`/`skipped` counts stay honest instead of quietly retrying forever. The 8 already-archived leads had their `lead_pipeline` row closed directly (`closed` set, `auto_followups = false`) so the fix doesn't wait on a deploy. **Archiving a lead now actually stops it being contacted — not just hides it from the list.** |
| 2026-08-09 | **Audit: DB vs the live Google Sheet, then `leads:duplicates -- --merge`.** Confirmed the count the user was seeing (724 active + 2 archived = 726 leads, sheet at 723 rows) was fully explained by two known, already-documented effects — nothing new was broken. (1) The eight 0028 leak pairs (see 2026-08-06 below) were never fully cleaned up: two (rows 672 `Lanka Safe Tours`, 674 `Vacation Sri Lanka`) were already archived one-sided; the other six (rows 121 `Modern Mart`, 371 `YourColombia`, 666 `Olanka Travels`, 679 `Three Travels`, 686 `Ali & Sons Contracting`, 723 `Apatchi Cars`) were still two live, active leads apiece, several emailed twice. Every pair matched on email + city + country + niche, i.e. all four fields, not just email. (2) Five sheet rows (3, 216, 286, 472, 662) have no lead of their own — not deletions, but the documented same-email-collapses-two-businesses-into-one-lead behavior (§10), verified by confirming each row's email resolves to a DB lead under a *different* business name at a *different* row. 718 distinct sheet rows were represented + 5 collapsed elsewhere = all 723 sheet rows accounted for; zero sheet rows pointed at nothing. Ran `npm run leads:duplicates -- --merge`, which archived the 6 remaining duplicate losers (evidence moved onto the richer/keep side first). **Active leads now 718, archived 8, total 726** — 718 matches the sheet's 723 populated rows minus the 5 by-design collapses exactly |
| 2026-08-06 | `PAGE_SIZES` moved to `lib/pagination.ts`. It lived in the `'use client'` pagination component, so importing it into the email-log server page produced a client reference rather than an array and threw at request time — a class of bug `next build` cannot see on a dynamic page. Four copies of the list collapsed into one, with shared `parsePageSize` / `parsePageNumber` helpers |
| 2026-08-06 | **0028 — the duplicate-lead leak.** Editing an email left `dedupe_key` holding the old address, so the next sheet sync inserted a second lead for the same row: eight sheet rows in the live data are claimed by two leads each, several emailed twice. The key is now recomputed in a trigger, and `leads:duplicates` groups by sheet row so the pairs are findable. Same root cause fixed for verdicts: `email_checked_address` means a verification result resets when the address changes, which is what makes "a verifier said invalid → never send" enforceable without an override. Adds `email_verifier_status` and send priority 1/2/3, ordering initial sends verifier-proved first. Write-back now sends only the columns whose field group changed, instead of re-stamping every mapped cell and blanking ones filled in by hand upstream. Archived became an only-archived filter |
| 2026-08-06 | Leads table shows a Google **Look up** link where the Website cell would be empty, scoped to the business plus its city and country. 112 of 723 leads, 86 of which have an email that may still need checking by hand |
| 2026-08-06 | The Email address verdict on the lead page stages behind a Save button instead of writing on change, matching Business information. Marking an address Dead removes the lead from every queue, so a stray scroll should not do it |
| 2026-08-06 | Email log gets pagination. The page read `?page=` but rendered no control, so it was stuck on the newest 50 of 87 rows and appeared to hold only today |
| 2026-08-06 | Sending days become a real setting. `updateSettings()` hardcoded `days: [1,2,3,4,5]`, so they could not be changed and every Save reverted them; now a seven-day control with a presence marker. Live window set to every day |
| 2026-08-06 | **Six fixes.** The cleaner now strips MATCHED wrapping quotes and fills bracket placeholders from the lead's own fields, taking the pending queue from **0 clean to 82 of 92**; the 10 left have no answer in the database and stay blocked on purpose. `leads.status` reverted to the ten DB enum values, which is what broke the last deploy — "Initial Approved" is a LABEL and now lives only in STAGE_META/GATE_LABELS, with the draft chip saying plain "Approved" because a lead has three drafts. Email logs swap the constant Provider column for which step was sent. `min-w-0` on the shell plus `overflow-x: clip` stops every page dragging sideways on a phone. Pause vs Close spelled out on the lead page |
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
