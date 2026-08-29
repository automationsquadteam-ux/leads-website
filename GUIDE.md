# GUIDE.md Leads CRM codebase guide

**Read this before changing anything. Update it before you finish.**

This is the internal guide: how the code works, why it is shaped this way, and the traps
that will bite you. `README.md` is the setup-and-usage document this one is for whoever
(human or AI agent) is about to modify the code.

> **Standing rule:** read this file at the start of a task, update it at the end. If you
> add a migration, a route, a service or a convention, it belongs here.
> Never add the double dash, never.

---

## 1. What this is

A cold-outreach CRM. Leads are generated and enriched **outside** the CRM, by n8n, which
writes them straight into Supabase; the CRM lets an admin review and edit drafts, and sends
email through a pluggable provider. Supabase is the only system of record ,until
2026-08-10 a Google Sheet sat in the middle as the ingestion layer and a mirror, and that is
now removed entirely (section 8).

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 · Tailwind CSS 4 ·
Supabase (Postgres + Auth + RLS) · nodemailer · ExcelJS.

Node 20.9+. Windows dev box; PowerShell is the primary shell.

### Current state (2026-08-12)

Migrations 0001 through 0039 are all applied to the live database (see section 2 ,every one
from 0031 onward was confirmed by a live functional probe on 2026-08-12, not assumed from this
table).

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
| **Reply ingestion** | Done ,Cloudflare Email Worker → `/api/inbound/reply` |
| Scheduled jobs (draft sweep, sender) | Done ,two `/api/cron/*` endpoints, driven externally. Sheet sync removed 2026-08-10 |
| **Email verification** | Done ,verifier CSV round trip, verify-on-send, manual verdicts |
| Public front page at `/` (no login) | Done, anon reads six aggregate views |
| Analytics page | Done |
| Modular outbound sync layer | **Removed 2026-08-10** ,its only target was the sheet |
| What signed-in *viewers* may see | **Still deliberately nothing.** `/` is the public answer |
| Deliverability (SPF/DKIM/DMARC, BIMI) | **Not addressed.** See section 11 |

Live figures at the time of writing (all excluding archived, per the standing rule below): 1003
leads, 13 archived, 611 with an address, 281 verified, 270 businesses contacted (348 messages —
215 initial, 76 follow-up 1, 57 follow-up 2), 3 replies, 0% bounce rate. **Never report a figure
for this project without excluding `status = 'archived'` first** ,`leads`, `lead_pipeline` and
`email_versions` all carry archived rows, and only the views rebuilt in 0034
(`public_stats_overview` and friends) or app code that explicitly joins `leads.status` exclude
them; a raw `count(*)` on `lead_pipeline` does not, because that table has no status column of
its own to filter on (see 0034 and 0035 in the changelog for what that gap actually cost).

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
| 0026 | `20260805200000_add_dead_email_stage_value.sql` | ✅ yes ,corrected 2026-08-10, this row was stale (see below) |
| 0027 | `20260805210000_dead_email_stage_and_status_views.sql` | ✅ yes ,corrected 2026-08-10 |
| 0028 | `20260806120000_verdicts_belong_to_an_address.sql` | ✅ yes ,corrected 2026-08-10 |
| 0029 | `20260810090000_dedupe_key_default_on_insert.sql` | ✅ yes ,pasted 2026-08-10 |
| 0030 | `20260810100000_sweep_checked_flag.sql` | ✅ yes ,pasted 2026-08-10 |
| 0031 | `20260810110000_normalize_blank_leads_fields.sql` | ✅ yes ,confirmed 2026-08-12 by functional probe |
| 0032 | `20260810120000_normalize_social_links_shape.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0033 | `20260810130000_retire_google_sheets.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0034 | `20260810140000_exclude_archived_everywhere.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0035 | `20260810150000_send_queue_view.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0036 | `20260810160000_public_leads_contacted.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0037 | `20260810170000_close_stale_after_followup2.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0038 | `20260810180000_stamp_checked_address.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0039 | `20260812080000_approved_version_stays_active.sql` | ✅ yes ,confirmed 2026-08-12 |
| 0040 | `20260812190000_email_log_failure_reason.sql` | ❌ NOT YET ,paste `supabase/schema-update-30-email-failure-reason.sql` |
| 0041 | `20260812200000_realtime_publication.sql` | ⚠️ not pasted, but **already effective** ,`email_logs`, `leads` and `lead_pipeline` were probed live on 2026-08-12 and all three already emit realtime events, so this project's `supabase_realtime` publication already covers them. The migration is a no-op safety net that makes all eight explicit and survives a `db reset`. |
| 0042 | `20260815150000_followup_due_dates_are_whole_days.sql` | ✅ pasted ,**and confirmed BUGGY live**, not just "unverified." `date AT TIME ZONE zone` is genuinely ambiguous in Postgres; it silently resolved wrong and round-tripped through UTC twice (a 10-hour error). Superseded by 0043. Left in the table rather than rewritten ,migrations here are immutable once applied; the fix is a new one, same as every other correction in this project. |
| 0043 | `20260816160000_fix_followup_due_date_timezone_bug.sql` | ✅ yes ,**confirmed live 2026-08-17**, and confirmed by real computed values rather than by anyone's recollection of pasting it. 20 of the 157 pending due dates now land on exactly `00:00:00` Asia/Karachi, and they are the newest ones: a follow-up 1 anchored on a send at 16 Aug 16:30:41 PKT computed to 23 Aug 00:00:00 PKT (+7 days, midnight), a follow-up 2 anchored 17 Aug 14:03:55 PKT computed to 20 Aug 00:00:00 PKT (+3 days, midnight). That signature is 0043's and nothing else's ,the pre-0042 pattern would have inherited the send's own minute, and 0042's bug produced `10:00:00`. The other 137 are pre-0042 rows, which is correct: neither migration is retroactive. |
| 0044 | `20260818130000_website_rejects_social_media_links.sql` | ❌ NOT YET ,paste `supabase/schema-update-34-no-social-website.sql`. Extends `normalize_blank_lead_fields()` (0031) so a Facebook/Instagram/etc. profile URL written to `leads.website` is nulled the same way a blank string already is, plus a one-time backfill of leads already carrying one. Probe: a throwaway lead insert with `website = 'https://facebook.com/someprofile'` comes back with `website is null`. |
| 0045 | `20260820140000_daily_cap_alert_settings.sql` | ❌ NOT YET ,paste `supabase/schema-update-35-daily-cap-alert-settings.sql`. Seeds `outreach.daily_cap_alert_email` (default `rayyanmasroor8@gmail.com`) and the internal bookkeeping row `outreach.daily_cap_alert_date`, both read by `runOutreachCycle()`'s new daily-cap-reached email. Data only, no function changes. Probe: `select value from settings where key = 'outreach.daily_cap_alert_email'` returns the address rather than an empty string — `getIntegrationConfig().outreach.dailyCapAlertEmail` reads `''` (and the alert silently does nothing) until this is pasted, confirmed live 2026-08-22. |

**0001 through 0039, 0042 and 0043 are applied; 0040, 0041, 0044 and 0045 are not yet pasted.** This table had drifted stale more than once by this point
,0026–0028 sat marked NOT YET for days after they had actually run, and on 2026-08-12 the same
thing had happened again to 0031, 0032, 0036, 0037 and 0038. **A "NOT YET" row is not evidence a
migration is pending; it only means nobody re-probed since it was written.** The row means
nothing on its own ,what changed this time is HOW it was confirmed: not by re-deriving from
context (asking "did anyone mention pasting this recently") but by a real functional test against
the live database for every single migration from 0031 onward, in the same session, right before
writing this table:

- **0031/0032**: inserted a throwaway lead with `email: ''` and `social_links: '{}'` (a JSON
  string, not an object) ,both used to violate a CHECK constraint outright; both now insert
  cleanly, which only happens if `normalize_blank_lead_fields()` is live.
- **0033**: `settings` no longer has a `sheets.spreadsheet_id` row.
- **0034**: `public_stats_overview.total_leads` equals a direct `count(*) where status <> 'archived'` exactly.
- **0035**: `lead_send_queue` is readable by the service-role client (it would return zero rows,
  not an error, if 0035 had not run ,see the gotcha table for why that specific failure mode is
  the dangerous one).
- **0036**: `public_stats_overview.leads_contacted` selects without error.
- **0037**: the `outreach.close_after_followup2_days` settings row exists.
- **0038**: set a throwaway lead's `email_verification_status` WITHOUT setting
  `email_checked_address`, and confirmed the trigger stamped it anyway.
- **0039**: created an approved, active v1; wrote different-CRLF-but-same-text to
  `leads.draft_email` (exactly what the old lead-detail form round trip did); confirmed v1 was
  still the active version afterward, not silently demoted.

**The lesson, stated plainly because it cost real time twice:** for anything this table claims is
applied, prefer a probe that would FAIL in an observable way if it were not ,a raw `select` that
merely returns zero rows (like querying an `is_admin()`-gated view with the wrong client) proves
nothing, because "empty" and "doesn't exist yet" look identical from the client. An insert that
should be rejected without the migration, or a value that should differ without it, is real
evidence; a table existing is not.

**0040 and 0041 are written but not pasted yet.** Paste them in order:

1. `supabase/schema-update-30-email-failure-reason.sql` ,adds `email_logs.failure_reason`, one
   nullable text column, `add column if not exists`, nothing else. Probe: `select failure_reason
   from email_logs limit 1` returns no "column does not exist" error.
2. `supabase/schema-update-31-realtime-publication.sql` ,adds eight tables to the
   `supabase_realtime` publication. **Optional in practice, and measured rather than assumed:**
   probing live on 2026-08-12 (subscribe, wait for the replication stream to settle, then write)
   showed `email_logs`, `leads` and `lead_pipeline` ALREADY emitting events on this project, so
   live updates work today without it. Paste it anyway so all eight are explicit and a
   `db reset` or a new environment does not quietly lose them. Probe: `select tablename from
   pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`.

   **A probe here needs a settling delay.** Subscribing and writing immediately reports a false
   negative ,the first attempt at this said "not published" for a table that two other tests had
   already proved live. Wait a few seconds after `SUBSCRIBED` before mutating, or you will
   conclude the publication is missing when it is the replication stream that had not started.

**0044 is also written but not pasted yet**, independent of the above (paste in either order):
`supabase/schema-update-34-no-social-website.sql` ,extends `normalize_blank_lead_fields()` (0031)
so a Facebook/Instagram/etc. profile URL written to `leads.website` is nulled the same way a blank
string already is, then backfills every lead already carrying one. Probe: insert a throwaway lead
with `website = 'https://www.facebook.com/someprofile'` and confirm it comes back `website is
null`; separately, `select count(*) from leads where website ~* 'facebook\.com|instagram\.com'`
should read 0 after pasting (it read a live nonzero count before this migration, which is what it
was written to fix).

**0045 is also written but not pasted yet**, independent of the above:
`supabase/schema-update-35-daily-cap-alert-settings.sql` ,two settings rows, data only, seeding the
daily-cap-reached email alert (see 2026-08-20's changelog entry). Without it,
`config.outreach.dailyCapAlertEmail` reads `''` and `notifyDailyCapReachedOnce()` silently does
nothing every time the cap is hit ,not an error, just no email, which is exactly the kind of
"looks like it's just not needed yet" failure mode this guide keeps warning about. Probe: `select
value from settings where key = 'outreach.daily_cap_alert_email'` returns
`"rayyanmasroor8@gmail.com"` rather than the row not existing (confirmed missing live 2026-08-22).

Then flip their rows above ,after a real probe, not just after pasting, same rule as every other
entry in this table.

**0042 shipped a real bug, and it is worth stating plainly why.** This machine has no CLI, so a
`create or replace function` cannot actually be run against the live database from here ,0042's
SQL was checked by hand-tracing the logic and by reproducing the intended arithmetic in a
standalone JS script, but neither of those *executes the actual DDL*, and the bug it shipped with
is exactly the kind that only exists once Postgres itself resolves it: `date AT TIME ZONE zone`
is genuinely ambiguous (a bare `date` has implicit casts to BOTH `timestamp` and `timestamptz`,
and `AT TIME ZONE` is overloaded on both), and it silently resolved to the wrong one ,round-
tripping through the session's UTC default twice, a 10-hour PKT error. Caught the same day by
asking "why does this lead still say due in 5 hours" and testing against a THROWAWAY LEAD WITH A
KNOWN SEND TIMESTAMP rather than trusting the paste ,the technique below. **Fixed in 0043** with
an explicit `::timestamp` cast, which removes the ambiguity outright (an exact-type match beats
an overload that needs a cast, every time).

**0043 is now confirmed live** (see the migration table for the values that prove it). Keep the
probe below anyway: it is the only opinion-free way to re-check this function after any change to
it, and it is **a deterministic test, not a read of existing rows** ,existing rows split three
ways (old minute-precise, correctly midnight, or 0042's bug), so just reading one proves nothing
on its own:

```sql
-- 1. A throwaway lead, then a fake "sent" row at a KNOWN, deliberately odd instant:
insert into leads (business_name, email, status) values ('probe, delete me', 'probe@example.invalid', 'new')
  returning id;  -- note the id
insert into email_logs (lead_id, status, email_type, sent_at)
  values ('<that id>', 'sent', 'initial', '2026-08-16T16:47:13Z');  -- = 21:47:13 PKT

-- 2. Read back what got computed:
select first_email_sent, followup1_due,
       (followup1_due at time zone 'Asia/Karachi')::time = time '00:00:00' as lands_on_midnight
  from lead_pipeline where lead_id = '<that id>';

-- 3. Clean up:
delete from email_logs where lead_id = '<that id>';
delete from lead_pipeline where lead_id = '<that id>';
delete from leads where id = '<that id>';
```

`lands_on_midnight` must read `true`, and `followup1_due` should be exactly 23 Aug 2026, midnight
Asia/Karachi. If it instead reads a specific non-zero time (0042's bug produced `10:00:00`), the
paste did not take, or something is still serving the old function ,do not mark this row applied
on the strength of "I pasted it," only on the strength of this probe.

**0044 and 0045 are now taken** (website-rejects-social-media-links; daily-cap-alert-settings ,see
the migration table above). **The next migration after that is 0046.** Add the file, regenerate
`schema.sql` and a `schema-update-N-*.sql` bundle, and leave its row as NOT YET until it has
actually been probed ,not just pasted, and not just remembered as pasted.

### 0026 and 0027 are ONE change split in two, and the order is not optional

Postgres refuses to let a new enum value be used in the transaction that added it:

```
ERROR:  unsafe use of new value "dead_email" of enum type pipeline_stage
HINT:   New enum values must be committed before they can be used.
```

So 0026 is a single `alter type ... add value` and nothing else, and 0027 ,the function that
returns it, the backfill that stores it, the new view, the drops ,is a separate script. Paste
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
every migration re-runnable ,`create or replace`, `add column if not exists`,
`on conflict do nothing`, guarded backfills ,because a partially applied or rolled-back
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
export ,being re-billed for an address someone had already confirmed.

Unticking returns the status to `unverified`, never to `invalid`: "no longer sure" is not
"proved dead". An existing `invalid` is never softened, because a hard bounce is evidence.

**A verdict is about an ADDRESS, and `email_checked_address` is what records which one.**
Changing `leads.email` to a different address resets the verdict to `unverified` (0028) ,but
only when that column is set, so **any code path that writes a verification status must let
`set_pipeline_stage()` stamp it**. Do not write `email_checked_address` yourself unless you are
applying a result for an address that has since been edited; leaving it NULL is what silently
switched the reset off for every verdict written between 0028 and 0038.

### Archive versus delete

`archiveLead` sets `status = 'archived'` and the default leads list now excludes those, so
archiving actually removes the row from view. Tick Archived in the status filter to see them.
A named `?view=` is exempt, because those ask a specific question that archiving does not
answer.

**It also stops the lead being contacted, as of 2026-08-09.** It did not before: the pipeline
row was deliberately left untouched on archive (a due follow-up stayed due), and neither
`findDueWork()` nor `sendLeadEmail()` checked `leads.status`, so an archived duplicate loser
with a live `followup1_due` ,exactly what `leads:duplicates --merge` leaves behind ,was still
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
The symptom is confusing rather than obviously broken ,you send from one row and open the
other, which shows no email log and still reads unverified.

`npm run leads:duplicates` reports them; `-- --merge` moves logs, replies, activity and
inbound messages onto the survivor and **archives** the others (never deletes). The survivor
is chosen by evidence first ,logs, a reply, a confirmed verification ,because content can
be copied across but a conversation cannot.

Recomputing keys automatically would be worse: it would collide with the surviving row and
fail the whole sync.

### A tile must link to exactly the rows it counted

"No address" and "Never checked" are both `email_verification_status = 'unverified'` in the
database ,a lead with no address has nothing to verify, so it carries that status too. A
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

`getVerificationCounts()` now returns them separately ,`noAddress`, `exportable` (never
checked AND has an address) and `inconclusive` (catch-all + unknown). A tile that counts one
thing and a button that delivers another is worse than no tile.

**The export defaults to never-checked only.** It used to include `unknown` and `accept_all`
on the theory that a re-run might resolve them, which re-bills every one of those addresses
on every export ,and a catch-all domain returns catch-all every single time. Re-checking is
now an explicit `?recheck=1` button.

Order matters between migrations: 0017 rewrites `pipeline_board`, which 0015 created.

### Two definitions of "approved" ,do not add a third

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

1. A send **this CRM** made ,an `email_logs` row with a `sent_at` ,is authoritative. The
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
from both directions. Nothing read it ,`deriveStatus()` uses the presence of a draft body,
which is a fact rather than a label someone has to remember to update.

### A send recorded outside the CRM must still schedule its follow-up

`followup1_due` is set by the `email_logs` trigger. Sends made upstream have no `email_logs`
row ,0015 writes `first_email_sent` directly ,so their due date stayed NULL and
`compute_next_step()` parked them on `await_followup1` permanently while the cron reported
nothing to do. 0018 makes `sync_pipeline_from_lead()` schedule it too, and backfills.

**Both writers land on midnight, not the sending minute (0042, fixed for real in 0043).**
`followup1_due`/`followup2_due` used to be `sent_at + N days` ,exact timestamp arithmetic, so a
due date carried whatever minute the previous send happened to fire at. `sync_pipeline_from_email_log()`
and `sync_pipeline_from_lead()` now both truncate to the calendar day (Asia/Karachi) before adding
the delay, landing on that day's midnight ,"N days" is a day count, not a stopwatch, so two
sends 40 seconds apart on the same day should become due together, not drift apart down the line
as the sequence compounds. See section 2's row for the exact mechanism and why it is not
retroactive.

**0042's own first attempt at this got the SQL wrong.** `date AT TIME ZONE zone` is ambiguous in
Postgres ,a bare `date` has implicit casts to both `timestamp` and `timestamptz`, and it silently
picked the wrong one, round-tripping through the session's UTC default twice (a 10-hour PKT
error, caught the same day a lead was still showing "due in 5 hours" instead of landing on
midnight). 0043 fixes it with an explicit `::timestamp` cast, which leaves Postgres no ambiguous
overload to mis-resolve. Worth remembering generally: `AT TIME ZONE` on anything that is not
ALREADY exactly `timestamp` or `timestamptz` ,a bare `date` especially ,is not safe to trust
without an explicit cast first, and this project has no way to execute DDL to catch that kind of
bug before it ships.

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
             dedupe_key UNIQUE  ← makes every import/insert idempotent, auto-computed
             on INSERT when left blank (0029) ,email > website > name+city, the same
             rule for the workbook importer, a direct writer (n8n), and a hand upsert
             sheet_row_number   ← provenance back to a Google Sheet row, from the era
             before 2026-08-10; NULL for anything inserted since. Kept, never backfilled
             (campaigns and templates were dropped in 0025; every lead had
              campaign_id = NULL, so the generator never used them)
email_logs   lead_id, status, provider, message_id, sent_at, error, email_type
replies      lead_id, reply_text, sentiment, is_handled, received_at
settings     key → jsonb value, is_sensitive
integration_secrets  key → ciphertext (service-role only)
integration_runs     integration, action, status, stats, timings

email_versions  lead_id, type, version_number, subject, content, status, active,
                generated_by, reviewed_by/at, review_note, sweep_checked_at (0030)
                UNIQUE (lead_id, type, version_number)
                partial UNIQUE (lead_id, type) WHERE active
lead_pipeline   lead_id PK, current_stage (DERIVED), 4 gate flags + their _at stamps,
                first_email_sent, followup1_due/sent, followup2_due/sent,
                replied, closed, closed_reason, auto_followups,
                email_verifier_status, email_checked_address (0028 ,which address
                a verdict was about; see "The flag and the status" in section 2)
lead_activity   lead_id, kind, summary, detail, actor_id  (append-only audit)

lead_send_queue  VIEW (0035). Machine-facing mirror of lead_pipeline + leads, archived
                 excluded, computed send_priority. Protected by GRANTS (revoked from
                 anon/authenticated, granted to service_role) rather than by
                 is_admin() ,the scheduler runs on the service-role key, which
                 satisfies no is_admin() predicate, so pipeline_board (the admin
                 equivalent) returns ZERO ROWS to it. Read from a service-role
                 context (scripts, the scheduler); pipeline_board from a session-
                 bound admin context (the dashboard, the leads list).
```

`lead_status`: `new · researching · ready · approved · sending · sent · replied · bounced ·
invalid · archived`.

### The pipeline is derived, not stored the rule that matters most now

`lead_pipeline.current_stage` and the Next Step are **computed in Postgres**, and since 0025
both are the **first unmet gate** rather than the last satisfied one ,a stage names what is
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
| **0024** | the sheet's **research status** column, OR any research field | ,|

The sheet column is the upstream pipeline's own verdict, so it wins. It reaches the database
on `leads.researched_at`, stamped by the importer, and the trigger treats a non-null value as
authoritative.

Field presence is **kept as a fallback rather than replaced**. A lead with a page of website
observations has plainly been researched whatever a status column says, and requiring both
signals would push hundreds of finished leads back into the queue the moment a column went
blank. Either signal being true is enough.

`researched_at` records when we LEARNED the research was done, not when it happened ,the
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
348 `Skip`, 241 `Needs Automation`, 112 `No Website` ,and dropping it destroys that with no
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

`lib/services/drafts/quality.ts` handles this, and it is pure ,no database, no network, no
`server-only` ,so a script, a server action and a client component all share one definition.

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
`normaliseSubjectLine()` applies the same treatment to the header column ,stricter, since a
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
nests. The trailing quote is removed **only when the quote count is odd** ,an email ending
`he called it "the good one"` has balanced quotes and is left alone, whereas a lone
unmatched `"` is the tail of a JSON string. That test is what makes the sweep safe to run
unattended over every draft.

It is idempotent, verified: running it two and three times over the same body changes
nothing, so re-pressing the button does not spawn versions.

`inspectDraft()` returns what is still wrong: JSON wrapper, literal `\n`, code fences, stray
braces, wrapping quotes, unfilled placeholders, no subject, suspiciously short. Round
brackets are deliberately fine ,"(and yes, really)" is ordinary prose; braces and square
brackets are not.

**Repairing and approving are separate, on purpose.** `repairAndApproveDrafts()` cleans
every pending draft ,saving each repair as a NEW VERSION, so the original stays in the
history and a bad clean is one click from undone ,and only then approves the ones with zero
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
| 3. Attribute | **Threading first**: `In-Reply-To`/`References` against `email_logs.message_id`. Then From address, but **only when exactly one lead matches** ,this dataset has leads sharing an address, and picking one would be a coin flip presented as fact. Then unmatched. |
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
nothing ,treating a full mailbox as a dead address throws away a good lead. No status
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

Under the current design an auto-reply never reaches `public.replies` at all ,but a rule
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

**Every refusal is logged now, not just provider-level failures (0040).** Before 0040,
`sendLeadEmail()` had nine return points and only the last ,a genuine SMTP-level rejection —
wrote to `email_logs`; the other eight (archived, no email, verifier says invalid, unverified,
no draft, no subject, provider misconfigured, an unresolved placeholder left in the text) just
returned, so a whole class of "why did this fail" had zero trace anywhere. All eight now write a
`status='failed'` row too, with `provider` left NULL (a real rejection always has `provider.id`
,that is how the two are told apart) and `failure_reason` set to a stable code
(`logRefusal()` in `send-lead-email.ts` is the one place that writes these; keep new refusal
branches going through it). Throttled to one row per lead+type+reason per six hours, because the
scheduler retries a due lead every tick and an unthrottled log would recreate the exact
"failed on every 3-minute tick for hours" problem this project already hit once with
`summary.notes` (see the 2026-08-12 changelog entry above). Surfaced on **Send Failures**
(`/send-failures`, `getEmailFailures()` in `src/lib/data/misc.ts`) ,a "why, in the last 14
days" summary above the full paginated history, both excluding archived leads.

### Lead identity (the single most important rule)

One definition, in `src/lib/import/dedupe.ts`, used by the workbook importer ,and mirrored
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

### Live updates are a SIGNAL, not a second copy of the data (0041)

Pages update by themselves ,a reply landing, the scheduler sending, another browser saving an
edit ,without anyone pressing refresh. The mechanism is deliberately the boring one:

```
Postgres change → supabase_realtime publication → browser subscription
  → debounce → router.refresh() → the SAME server components and the SAME
    src/lib/data/ functions re-run
```

**The client never patches a changed row into a table.** That is the whole design decision, and
it follows from the rule this guide states more often than any other. The filtering that decides
what a page shows lives in exactly one place: archived leads are excluded (0034), Ready to Send
needs `send_priority < 9`, an initial send needs its ACTIVE version approved (0039), the send
queue's three-part order mirrors `findDueWork()`, business names come from a keyed second query.
Splicing a realtime row into a client table means re-deciding all of that in a browser ,a second
implementation of rules that have already gone out of step between the board and the sender more
than once. A refresh costs one re-query and keeps one definition.

`router.refresh()` rather than `location.reload()` because it preserves client state: the leads
table keeps its selection and any half-typed inline address edit, an open dialog stays open,
scroll position holds.

**Security is inherited, not rebuilt.** Every published table already carries
`for select to authenticated using (public.is_admin())`, and Realtime applies RLS per subscriber,
so an admin gets events, a viewer gets nothing, anon cannot subscribe. The subscription is
mounted for `role === 'admin'` only, in the (app) layout ,one mount for the whole shell, so a
page added later is live by default rather than live only if somebody remembered.

Two things worth knowing before changing it:

- **The table list is in two places and must agree** ,migration 0041's publication and
  `LIVE_TABLES` in `components/realtime-refresh.tsx`. A mismatch does not break anything, it just
  silently means no live updates for that table.
- **Bursts are coalesced**, with a 400ms quiet window and a 5s ceiling. The ceiling matters: a
  pure debounce would starve under a long send run and never refresh at all.

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
  find-duplicates.ts leads sharing an email/sheet row -- --merge archives the loser
  purge-leads.ts     delete leads with a restorable JSON backup
  verify-emails.ts   verifier CSV round trip: export / import / status

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
      cron/outreach/                scheduled sender + exhausted-sequence close (CRON_SECRET bearer)
      cron/approve-drafts/          scheduled draft sweep, same CRON_SECRET check
      inbound/reply/                Cloudflare Email Worker → reply ingestion
    (app)/           authenticated shell (sidebar + topbar)
      layout.tsx     requireUser() → AppShell
      dashboard/     operational widgets; viewers get ViewerRestricted
      analytics/     page + volume-chart (resolution toggle)
      leads/
        (list)/      table + Stage/Next Step columns  ← loading.tsx lives HERE
        [id]/        page · lead-detail · research-panels · draft-workspace ·
                     pipeline-panel
      email-logs/ replies/
      send-failures/ page + why-summary card + full history, reuses email-logs' pagination
      email-schedule/ 14-day send forecast, spreads findDueWork()'s own priority
                      order and daily cap across days rather than just "now"
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
    realtime-refresh.tsx  the ONE live-updates subscription, mounted in the
                          (app) layout for admins. Renders nothing.
    metric-card · status-badge · empty-state · confirm-dialog · pagination · theme-toggle

  lib/
    env.ts               lazy, guarded env access (+ getCronSecret → null when unset)
    use-realtime-refresh.ts  Realtime event → debounced router.refresh(). A
                             SIGNAL, never a client-side copy of the data —
                             see section 4's note on why.
    pipeline/labels.ts   stage/next-step LABELS ONLY the logic lives in SQL
    auth/session.ts      requireUser / requireAdmin / assertAdmin
    supabase/
      client.ts          browser
      server.ts          server components / actions (RLS applies)
      service-client.ts  service-role factory NO 'server-only' marker
      admin.ts           re-export WITH 'server-only', for app code
      database.types.ts  hand-maintained schema types
    data/                read queries: dashboard · leads · misc · admin-dashboard ·
                         analytics · public-stats (anon client) · email-schedule
    actions/             server actions: leads · misc · integrations · review
    services/            the only code that talks to the outside world
      config.ts          typed reader for non-secret settings (email/ai/outreach/sending)
      secrets.ts         AES-256-GCM encrypted credential store
      activity.ts        lead_activity writer (best-effort)
      email-versions.ts  create / activate / review never overwrites
      integration-runs.ts run history
      ai/                types · prompt · template-generator · ollama · index
      drafts/            quality.ts (inspectDraft/repairDraft, the placeholder+shape
                         checks every send path shares) · sweep.ts (runDraftSweep,
                         button and cron call this, never re-implement it)
      outreach/          pipeline.ts (reads/asserts) · scheduler.ts (the sender AND
                         the exhausted-sequence close, 0037)
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

**An instant and a date are formatted by different functions, and mixing them up is a bug
that reads as a lie.** `formatRelative()` is minute-precise and belongs on real instants ,a
send, a reply, a verification check ,where the minute is part of the fact. A follow-up's due
date is not one of those: it is a whole calendar day stored as that day's midnight (0042 /
0043), so `formatRelative()` rendered it as a countdown to a boundary that carries no
meaning ,"in 11 hours", then "in 3 minutes" ,which reads as a promise that mail is about to
leave at 00:03. `formatDueDay()` is the one to use for anything due: it counts a difference of
**calendar days in `DISPLAY_TIME_ZONE`**, not elapsed milliseconds over 86,400,000, so it
answers "tomorrow" for midnight tonight-plus-one-hour and flips at the same local midnight
`dayBoundsUtc()` and the scheduler's day buckets use. Where a panel lists both kinds together
(`PipelinePanel`'s stamps), the due rows are tagged `day: true` and the rest keep minute
precision ,the distinction is in the data, not in the caller's memory.

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
| **Importing a non-component VALUE from a `'use client'` module into a server component** | `PAGE_SIZES.includes is not a function`. The server does not receive the array, it receives a client REFERENCE ,an opaque object with none of the original's methods. **`next build` does not catch it** when the importing page is dynamic (ƒ), because such a page is never rendered during the build; it fails on the first real request, in production, at a line that looks obviously correct | Same fix as the row below, mirrored: put the value in a module with **no directive at all** (`lib/pagination.ts` exists for exactly this) and import it from both sides. Never re-export it from the client module either ,a re-export is still a client reference. Components and hooks are fine; `type` exports are erased and always fine |
| **Exporting a non-async value from a `'use server'` file** | `A "use server" file can only export async functions, found object.` The **whole module fails to evaluate**, so *every* action in it 500s including ones that have nothing to do with the offending export. The stack points at the generated action loader, never at the real culprit, and the browser just says "Could not reach the server" | Move the value to a plain module and import it from both sides. `type`/`interface` exports are fine they are erased |
| **A Server Action toasting "Could not reach the server"** | The action did not fail every action catches and *returns*. The POST itself 500'd or 404'd. Check the **server** log, not the browser | Usually the row above. Otherwise a dev server that recompiled while the page stayed open, leaving stale action ids: reload the page |
| An AFTER trigger that clears a sibling before a partial UNIQUE index | Never runs the index is checked the instant the row hits the heap, so the INSERT already failed with 23505 | Use a BEFORE trigger (see `enforce_single_active_version`) |
| `ON CONFLICT DO UPDATE SET x = coalesce(public.tbl.x, excluded.x)` | Schema-qualifying the target is a syntax error | Alias the target: `insert into public.tbl as p ... set x = coalesce(p.x, excluded.x)` |
| Writing `current_stage` on `lead_pipeline` | Silently ignored the BEFORE trigger recomputes it | Set the gate flags; the stage follows |
| Reading `/stats` data with the service-role client | Turns one typo into a data breach on a page anyone can load | Use the plain anon client (`lib/data/public-stats.ts`); Postgres grants then make a leak impossible |
| Ollama streaming by default | Returns NDJSON, `JSON.parse` chokes halfway through | `stream: false` in the request body |
| `round(avg(x), 1) filter (where …)` | `42809: FILTER specified, but round is not an aggregate function` FILTER binds to the aggregate, not to a function wrapping it | `round((avg(x) filter (where …))::numeric, 1)` see `analytics_funnel_timing` |
| `sr-only` on a `<table>` | Does nothing useful ,it hides via `width: 1px`, and a table will not shrink below its min-content width, so the "invisible" element stays full width and pushes document scrollWidth | Put `sr-only` on a wrapping `<div>`; the table inside is then clipped |
| `truncate` inside a grid/flex child | `white-space: nowrap` makes the element's MIN-CONTENT width the whole string, so without `min-w-0` the parent grows instead of the text truncating | `min-w-0` on the child. `Card` now sets it itself |
| Testing a placeholder/template rule against RENDERED text only | A bracket or token that is genuinely part of the lead's own data (a business name containing `[EDCC]`) is indistinguishable from an unfilled placeholder once merged in ,the rule blocks real data forever, unconditionally, no data fix possible | Pass the lead's own known field values alongside the rendered text and exclude a match that is a substring of one of them |
| A background job computes a specific per-item failure reason, then a caller passes only the summary count to where it is stored | The reason existed in memory and is gone the instant the function returns ,the record left behind (`failed: 1`) is unfalsifiable and undebuggable without re-deriving it by hand | Fold the reason into the one message/summary every caller already persists, in the function that computed it ,not in each caller |
| Round-tripping text through a hidden form input | HTML form submission normalises line breaks to **CRLF**, so a value submitted unchanged comes back different from the stored LF text. Anything comparing byte-for-byte reads it as an edit | Do not submit fields the form does not edit. Compare with `replace(x, E'
', E'
')` where a comparison must survive a round trip |
| A grid/flex child without `min-w-0` | Defaults to `min-width: auto`, so it refuses to shrink below its widest unbreakable content ,one long string widens the whole page. Under the shell's `overflow-x-hidden` that CLIPS rather than scrolls, so right-aligned buttons become unreachable | `min-w-0` on every grid/flex child that holds variable-length content. Re-check it for each NESTED grid; the fix does not inherit |
| Text beside a `whitespace-nowrap` sibling in a `justify-between` row | Badge and Button are both nowrap, so they keep full width and the text absorbs all the squeeze ,two or three letters per line | `flex-wrap` on the row and `min-w-0` on the text |
| `table-fixed` + `w-full` on a narrow screen | Column widths become a RATIO, not a floor ,the table shrinks into the viewport and every cell becomes an ellipsis instead of scrolling | Give the table a `minWidth` equal to the sum of its column widths; `TableWrap`'s `overflow-x-auto` then has something to scroll against |
| Querying an `is_admin()`-gated VIEW with the service-role client | Returns **zero rows, silently** ,service-role bypasses RLS on a table, but a predicate in a view body is a plain WHERE clause it does not satisfy. Killed every automatic initial send for four days (0035) | Give machine callers their own view with no `is_admin()` in the body, protected by GRANTS (`revoke ... from anon, authenticated`) ,see `lead_send_queue` |
| Adding a column anywhere but the END of an existing `create or replace view` | `42P16: cannot change name of view column "x" to "y"`. Replace can only **append**; inserting a column reads as renaming the one already in that position | `drop view if exists …;` then `create view …`. Add `cascade` only if something depends on it check first, because cascade silently drops dependents too |

---

## 8. Integrations

All services live in `src/lib/services/` and are called only from Server Actions in
`src/lib/actions/integrations.ts` (or `review.ts`), or from the cron route handler.

**n8n writes Supabase directly. The Google Sheet is gone (2026-08-10).**

The sheet used to be the ingestion layer: n8n appended rows, `sheet-sync.ts` pulled them in,
and `sheet-writer.ts` pushed CRM edits back. All of it is deleted ,`google-sheets.ts`,
`sheet-writer.ts`, `sheet-sync.ts`, the whole `lib/services/sync/` dispatcher,
`/api/cron/sheet-sync`, the Sync Data button and the Google Sheets settings card. Migration
0033 removes the six `sheets.*` settings rows and both stored Google credentials.

**Supabase is now the only system of record.** There is no mirror, so there is no
write-back, no "which side wins" rule, and no sync failure to fold into a toast.

### The n8n contract ,what it writes, and the two rules that keep it safe

**Workflow 1, lead discovery → `INSERT INTO public.leads`.** `business_name` is required;
everything else optional. **Never send `dedupe_key`** ,`assign_dedupe_key_on_insert()` (0029)
computes it, using the same `email > website > name+city` priority as `buildDedupeKey()`. A
direct writer computing its own key slightly differently is how you get the 0028 duplicate
mess back, invisibly, with no `sheet_row_number` left to catch it by. Use
`Prefer: resolution=merge-duplicates` with `?on_conflict=dedupe_key` so a re-run upserts
instead of erroring. `source` should say where it came from (`n8n:lead-gen`).

**Workflow 2, research + draft → an UPDATE and an INSERT, not one write.**

- Research fields go onto `leads` (`research_summary`, `website_observations`,
  `automation_opportunities`, `ai_chatbot_opportunities`,
  `website_improvement_opportunities`, `personalization`, `interesting_facts`,
  `outreach_angle`, `social_links`), plus `researched_at` ,that timestamp is what 0024 made
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
deliberately** ,they are the only provenance for the 762 leads that did come in through the
sheet, and `leads:duplicates` still groups by row number to find 0028-style pairs.

### What happens to an n8n draft after it lands

Nothing has to be told about it; four triggers and one cron do the whole thing:

1. `set_email_version_number()` assigns the version number, `enforce_single_active_version()`
   deactivates any previous active draft for that (lead, type).
2. `mirror_active_initial_draft()` copies subject/content onto `leads`, so the sender, the
   CSV exports and the dashboards ,all of which predate versioning ,keep working unchanged.
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

#### The research fields are notes TO US. Never paste one into a body unfiltered

`outreach_angle`, `automation_opportunities`, `personalization` and the rest are written as
**advice on how to approach the business**, not as sentences addressed to it. 782 of 958
non-archived leads have an `outreach_angle` opening `Offer to …`; `personalization` adds 107
`Congratulate them on …`. A bare imperative pasted into an email body has no subject left
except the reader, so it lands as us instructing the RECIPIENT to make an offer, or to
emphasize something about their own city ,which is exactly what went out until 2026-08-17.

`bestAngle()` in `template-generator.ts` therefore **skips** any candidate matching
`ADVICE_SHAPES` and falls through to the next field, rather than trying to reword it: a
deterministic template cannot turn arbitrary strategy notes into first-person prose without
producing something worse than the problem. Two properties of that filter are deliberate and
worth preserving if you touch it:

- **`outreach_angle` keeps its first place.** A hand-written angle is the best line on the
  lead; the machine-written ones lose by failing the shape test, not by being read last.
- **Gerunds are not blanket-matched.** "Automating enquiry handling would free up an hour a
  day" is an observation and reads correctly; "Highlighting their expertise could be an
  effective angle" is advice. What separates them is the predicate, not the opening word.

The same trap applies to the `ollama` path in a milder form ,`prompt.ts` hands these fields
to the model under honest headings (`OUTREACH ANGLE`, `PERSONALIZATION`), so a model can
tell instruction from fact. It is only the deterministic paste that had no such chance.

Follow-up 2 additionally frames the angle with a lead-in naming whose thought it was.
Follow-up 1 does not need one and does not have one: its closing ASK re-anchors the whole
email as ours, so whatever the middle paragraph is, the reader lands on a direct question
from a person. Follow-up 2 deliberately has no ask ,it is the "no work to answer" step ,so
the angle paragraph IS the email, and an unattributed sentence there reads as an order.

That frame carries a second load. 132 of 350 live angles talk about the lead in the **third
person** ("the company could benefit from…"), because they were written about them, not to
them. Do not try to rewrite that to "you" ,it was measured, and only 4 of 350 sentences
could be swapped safely, one of which came out "you is a pioneering cafetería". Naming the
sentence as a note makes the third person correct instead of wrong.

**A template change does not reach drafts that already exist.** Drafts are written days
ahead of the send and the scheduler only generates when none exists, so every fix to this
file strands the queue on the old wording. `refreshStaleFollowupDrafts()` is the remedy and
the Settings button "Rewrite drafts to the current template" is its front end ,run it after
changing anything here. It only ever touches `generated_by = 'template'` drafts whose step is
unsent, and only when regenerating actually produces something different, so it is safe to
press twice and cannot overwrite a draft anyone edited.

`shortName()` decides how the business is addressed everywhere ,subject and opener alike.
Lead names are scraped listings carrying legal and SEO tails, so the raw column is not what a
person would write.

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

## 10. Known data quirks (`Leads.xlsx` workbook importer)

`npm run import:leads` (`scripts/import-leads.ts`) is the only thing left that reads this file —
the Google Sheet it used to share an identity rule with is retired (section 8). Kept for the rare
occasion someone runs it again, and because the identity rule below is not actually workbook-
specific.

- Headers carry stray leading spaces and inconsistent casing.
- `Date Added` mixes Excel serials, `DD-MM-YYYY` text, and real dates. The serial converter
  handles Excel's phantom 1900 leap day.
- 19 rows carry scraper-junk emails (`…@sentry-next.wixpress.com`, `user@domain.com`).
  These are discarded; identity falls back to website or name. Without this, nine unrelated
  businesses would collapse under one Wix error-reporting address.
- **Genuinely different businesses sharing one contact email collapse into one lead** (two
  Chiang Mai agencies both on `info@faranghomes.com` was the original example). This is
  intended, not a bug: the identity rule is `email > website > name+city`, so two rows with the
  same email are, as far as this system can tell, the same business until proven otherwise.
  `buildDedupeKey()` in `lib/import/dedupe.ts` is the TypeScript half of this rule, used by the
  workbook importer; `assign_dedupe_key_on_insert()` (0029) is the SAME rule enforced in
  Postgres for any direct writer ,n8n included ,so a collision collapses a lead the same way
  regardless of which path it came in through.
- Sheet1 (687 Pakistan leads, no research/drafts) is **excluded** by user decision.
  `--sheet=Sheet1` imports it if ever wanted.

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

## 12. Historical debugging notes ,deeper reasoning behind changelog entries

The Changelog (section 13) is the terse, one-line-per-day record of what shipped. This section
is the small number of past investigations worth more than one line ,the reasoning, not just the
outcome, kept because the SAME class of bug tends to recur in a new place (see 0034 and 0035:
"archived leads leak into a count" and "service-role gets zero rows from an is_admin() view" each
happened more than once, in different tables, months apart).

**Everything below is resolved.** None of it describes a current problem. If a subsection reads
like it is reporting something broken, that is the state AS FOUND, on the date given, before the
fix in the same subsection.

### The 2026-08-05 audit, compressed

A full read-only pass over the live database and every dashboard tile, on a 701-lead dataset,
found twelve disagreements between what a tile showed and what its own linked page actually
contained ,the root cause in every case was one of two things: **an ad-hoc flag query standing
in for the derived pipeline stage** (so a tile and a page could each apply a slightly different
definition of "ready"), or **a boolean collapsing a wider enum** (`email_verified` hiding the
difference between "nobody has checked" and "a verifier tried and could not tell either way").

The fix, in one sentence: **every dashboard tile became a `current_stage` or `next_step` query**,
so a count and the page it links to resolve through the same derivation by construction, and
`compute_pipeline_stage()` was reordered from "newest fact wins" to "first unmet gate wins" ,a
stage now names what is BLOCKING a lead, not the last thing that happened to it. This shipped as
migrations 0025 (the funnel reorder, every tile rebuilt) and 0026/0027 (a `dead_email` stage split
out from `need_email`, because "no address" and "address proved dead" are different jobs that had
been sharing one bucket). `leads.category` (the stale upstream "Skip" marking) and the unused
`campaigns`/`templates` tables were dropped in the same pass ,confirmed structurally empty
(every lead had `campaign_id = NULL`) rather than assumed.

The verification gate ,refusing to send to an address a verifier proved dead, or one nobody has
checked while `outreach.require_verified_email` is on ,moved into `sendLeadEmail()` itself, the
one function every send path goes through (the Send button, the API, the cron sender). It used to
live only in the scheduler's `findDueWork()`, which protected automatic sends and nothing else;
pressing Send by hand on a dead address would have mailed it anyway.

### 0026 / 0027 ,four things the user found after 0025 went live

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
actually using. `analytics_stage_distribution` is unchanged ,/analytics reports on everything
on purpose.

**3. "Business information ,Researching" on leads that had plainly been researched.** The lead
detail page still rendered `leads.status`, as a badge and as an editable dropdown, on 472 leads
reading `researching` against 695 with research complete. Both are gone; the badge is now the
derived stage. `leads.status` rides along as a hidden input so a save cannot blank the value the
sheet sync depends on.

`StatusBadge`, `LEAD_STATUS_LABELS` and `STATUS_CHART_COLORS` were deleted with them ,**nothing
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
every `lead_pipeline` row, so this question is always answerable ,never guess at it.

### The last two status views are gone

`dashboard_lead_status_counts` fed a Status-distribution chart on /analytics and
`public_stats_statuses` fed one on the public page, each sitting beside a stage chart answering
the same question correctly. Two charts contradicting each other on one screen is worse than one
chart. Both dropped, along with `dashboard_leads_safe` ,shaped for a viewer role that still has
no scope, and read by nothing since it was written.

`public_stats_leads` **stays**: it is a working, default-denied feature (Settings → Public page),
not dead code.

### "Approved" means one draft, and a lead has three

A find-and-replace turned every "Approved" into "Initial Approved" on 2026-08-06, including
`z.enum([... 'initial approved' ...])` in `actions/leads.ts`. That is the DATABASE enum
`public.lead_status`, which has no such value, so the deploy failed to compile ,and would have
failed at the INSERT even if it had.

The vocabulary, settled:

| Thing | Where | Reads |
| --- | --- | --- |
| `email_versions.status = 'approved'` | draft workspace chip | **Approved** ,this draft is signed off, whichever of the three it is |
| `lead_pipeline.approved` | pipeline panel gate | **Initial email approved** ,only the initial version sets it |
| stage `approved` | badges, tiles | **Initial Approved** |

The chip must NOT say "Initial", because it renders above follow-up 1 and follow-up 2 as well.
Approving a follow-up marks that draft and moves no stage: `sync_pipeline_from_version()` sets
the gate for `type = 'initial'` and for nothing else.

**Wording belongs in `STAGE_META`, `NEXT_STEP_META` and `GATE_LABELS`.** Nothing a user reads
comes from a database enum, so relabelling never needs a migration ,and editing an enum to
change a label breaks the build at best.

### The cleaner fills what it knows and refuses to guess

Two additions took the pending queue from **0 clean out of 92 to 82**:

- **Matched wrapping quotes.** `stripJsonDebris()` only stripped a quote when the count was ODD,
  reading an even count as "these are part of the prose". A body that both opens and closes on a
  quote is a JSON string value that lost its key, and that was **60 of 92** drafts ,the single
  biggest reason anything was stuck. Stripping the outer pair is right even when the email quotes
  something internally: four quotes minus the outermost two leaves the inner pair where it belongs.
- **Placeholders answered from the lead.** `[City]`, `[Niche]`, `[Business Summary]`,
  `[Website Observations]`, `[Your Name]` and friends are filled from `leads` and the configured
  from-name. `fillKnownPlaceholders()` takes a `DraftContext` rather than reading the database,
  so `quality.ts` stays pure and a script, an action and a client component keep sharing it.

**It never guesses.** `[Owner's Name]`, `[insert number]` and
`[specific observation about their website]` have no answer here, and inventing one is how "Hi
[Owner's Name]" becomes "Hi Sarah" for someone called Ahmed. Those stay, and the draft stays
blocked ,which is the entire reason that check is blocking.

The one exception is a SALUTATION built round an unknown name: "Hi [Owner's Name]," carries no
information beyond "Hi," so it collapses. Every other position keeps its placeholder, because
elsewhere the sentence was built around the missing fact.

Braces are stripped only when a `{` or `}` sits **alone on a line**. A brace inside a line is
almost always a token someone still has to deal with, and deleting it silently would turn a
visible problem into an invisible one.

### Why the whole app could be dragged sideways on a phone

The layout collapsed to one column correctly; the document was simply wider than the viewport. A
grid or flex child defaults to `min-width: auto` ,it refuses to shrink below its widest CONTENT
,so one long unbreakable string (a curl command, a URL, an email address) widened its column,
which widened the page.

Fixed at the cause with `min-w-0` on the shell's content column, plus `overflow-wrap: break-word`
on the body. `overflow-x: clip` on `html`/`body` is the belt-and-braces half; **`clip` and not
`hidden`**, because `hidden` creates a scroll container and would break `position: sticky` on the
topbar.

### The email log had no way off page 1

`getEmailLogs()` has never filtered by date, and the page has always read `?page=` ,but nothing
ever rendered a control to change it. So the log was frozen on the newest 50 rows, and on a day
that used the full send quota those 50 rows WERE that day. It looked exactly like "the log only
keeps today"; all 87 attempts were there the whole time, 35 of them one page away.

`LogPagination` is a thin client wrapper around the shared `Pagination`, because that component
takes callbacks and the log page is a server component. Page and size live in the URL, as they do
on the leads list.

**Worth checking whenever a list is added:** a `?page=` the server reads and the client cannot set
is invisible, and it fails in the most misleading way possible ,the data looks deleted.

### Sending days were hardcoded, and Save reverted them

`updateSettings()` wrote `days: [1, 2, 3, 4, 5]` as a literal. So the sending days could not be
changed from the UI at all ,and worse, **pressing Save on the Settings page silently reverted
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
of the pairs show `logs=1` on BOTH rows ,those businesses were emailed twice.**

0028 recomputes the key in a BEFORE trigger at the moment of the edit. GUIDE used to warn against
recomputing keys; that warning was about a bulk backfill over every row, where one collision fails
an entire sync. One row at a time is the opposite case ,a collision means "another lead already
owns that address", which is a true and useful thing to say to whoever just typed it.

Only an already-`email:` key is recomputed. A `site:` or `name:` key keeps its identity, because
those were chosen when there was no address and the sheet still matches on them.

`npm run leads:duplicates` now groups by sheet row as well as by address, which is the only way to
see this class ,the two rows have DIFFERENT addresses, so email grouping cannot find them.

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

### Send priority ,ordering, never gating

`email_verifier_status` keeps the last NON-manual verdict, so a human override no longer erases
what the machine found. `compute_send_priority()` reads the pair:

| Tier | Means |
| --- | --- |
| **1** | a verifier said valid, or a real email was already delivered |
| **2** | you confirmed it, and no machine had said anything against it (catch-all, or never checked) |
| **3** | you confirmed it after the verifier tried and gave up (unknown) |
| **9** | not sendable ,unverified, or the verifier proved THIS address dead |

`findDueWork()` orders initial sends by priority then `approved_at`, reading `pipeline_board`
because the view computes it. Every tier-1 lead goes before any tier-2. **Nothing is gated:** an
address confirmed from the company's own website is worth mailing, it just waits behind the ones a
verifier proved, so a bad hand-confirmation costs less reputation.

### The sheet write-back only touches what changed

The write has always been per-cell ,one single-cell range per column, and a column whose header is
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
,the difference between `lead_count_all` and `lead_count` in `lead_stage_counts`.

### An empty Website cell is a job, not a dash

A lead with no website is the moment you go and look the business up, so the leads table shows a
**Look up** link there instead of an em dash ,a Google search for the business narrowed by its
city and country. `googleSearchUrl()` in `lib/utils.ts` builds it; blank parts are dropped rather
than producing double spaces, and `encodeURIComponent` handles the Cyrillic, Vietnamese and
bracketed names this dataset actually contains.

The location is the whole point. "Konyha Restaurant" returns every restaurant of that name on
earth; "Konyha Restaurant Budapest Hungary" returns the one on screen. All 723 leads carry both a
city and a country, so the query is never vague.

It appears on **every** lead without a website ,112 of 723, of which 86 DO have an email address.
Restricting it to leads missing an address was the obvious-looking choice and the wrong one: an
address that exists still gets verified by hand sometimes, and that starts with the same lookup.

`stopPropagation` on the click is load-bearing: the table row itself navigates to the lead, so
without it a click would open the search AND leave the page.

### The verification verdict stages, like every other edit on the lead page

The Email address dropdown used to write on `onChange`. Everything else on that page ,Business
information, the research panels, the draft editor ,stages an edit and waits for Save, and this
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

- **Pause** (`auto_followups = false`) ,the lead keeps its stage and stays in every queue and
  count. For "not right now, try me next quarter".
- **Close** (`closed` set) ,the sequence is over. The lead leaves every queue and every dashboard
  figure, and its stage reads Closed. For a no, for a conversation that has moved to your inbox,
  and for a lead that turned out to be wrong.

An unsubscribe closes the workflow automatically and sets `auto_followups = false` as well;
`replied` on its own only changes the next step, which is why a reply still needs a decision.

### Two scheduled jobs, neither of them scheduled by this app

Both take the same shared-secret check ,`guardCronRequest()` in `lib/cron/authorize.ts`,
moved out of the outreach route the moment there was a second caller, because a security
check copied three times is a security check that ends up subtly different in one of them.

| Endpoint | Cron | Does |
| --- | --- | --- |
| `/api/cron/approve-drafts` | `0 */4 * * *` | The same `runDraftSweep()` as the Clean-and-approve button |
| `/api/cron/outreach` | `*/3 * * * *` | Sends what is due |

**There was a third, `/api/cron/sheet-sync` at `59 23 * * *` Asia/Karachi.** It is deleted
along with the rest of the Sheets code (2026-08-10). **Delete its schedule in cron-job.org
too** ,the endpoint now 404s, so an orphaned schedule is a job that fails every night
forever and trains you to ignore the failure mail.

**The sweep runs every 4 hours** (`0 */4 * * *`, changed 2026-08-10 from an explicit
`0 0,7,14,21 * * *`). Four divides 24 evenly, so the step syntax is honest here ,00, 04, 08,
12, 16, 20, six runs a day. **This is exactly what `0 */7 * * *` could NOT do**: cron restarts
its count at midnight, so a 7 is 00, 07, 14, 21 and then a three-hour gap, which is why that
schedule had to be written as an explicit hour list. Check the arithmetic before using `*/n`
on hours ,only divisors of 24 (1, 2, 3, 4, 6, 8, 12) behave the way they read.

**`vercel.json` carries one cron, and it is not what actually drives either job.** cron-job.org
is ,it also speaks timezones, so a schedule can be set in Asia/Karachi instead of being
hand-converted to UTC and silently breaking at a DST boundary somewhere.

**This paragraph used to say Hobby "allows two [crons]".** That was true once; it is not the
current rule. Vercel now restricts Hobby to cron jobs that run **once per day**, full stop ,a
more frequent expression fails at DEPLOY time, not at runtime. That is exactly what happened on
2026-08-14: the one entry in `vercel.json` (`/api/cron/outreach` at `0 * * * *`, hourly) had been
failing every deploy, unnoticed because it degrades nothing ,cron-job.org already covers the
real schedule. Fixed to `0 9 * * *` (valid, once daily) rather than removed, since there is no
strong signal on whether the redundant trigger was intentional. **If Vercel's cron rules change
again, re-check this file before trusting anything written here about them** ,the rule itself,
not just the schedule, is what moved.

### Every cron route answers before it works, and why that is a trade

cron-job.org gives up after about 30 seconds. A 700-row sheet sync and a sweep over a queue of 90
both take longer than that legitimately, so both were reported as **failed runs while actually
completing in the background** ,the worst outcome available, since the alarm was false and a
genuine failure would have looked identical.

All three routes now answer `202 Accepted` in milliseconds and finish the job inside Next's
`after()`, which keeps the function alive past the response. `/api/cron/outreach` was included
even though it appeared healthy: it only survived because it usually finds nothing due, and it
sleeps 90 seconds between sends by design, so its first real queue would have failed the same way.

**The cost, which is real:** the scheduler can no longer tell you whether a run SUCCEEDED, only
that it started, so it shows green either way. That is only acceptable because all three jobs
write an `integration_runs` row carrying the true outcome, and Settings lists them. **Do not use
`lib/cron/accepted.ts` for a route that does not record a run** ,that would be a job whose
failures are invisible everywhere.

`maxDuration` now covers the `after()` work, not the response. The sweep's own budget is 50s,
matching the sender's, so it stops cleanly inside a Hobby function's 60s rather than being killed
mid-version-write; whatever it does not reach waits for the next of the four daily runs.

**`runDraftSweep()` moved to `lib/services/drafts/sweep.ts`** so the button and the schedule run
one function. `repairAndApproveDrafts()` is now a nine-line action: `assertAdmin()`, call the
service, `revalidatePath()`. The same shape as the verification CSV round trip ,two front
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
  lost its neighbour, is full width ,better for an eleven-row bar list anyway.

## 13. Changelog

| Date | Change |
| --- | --- |
| 2026-08-28 | **The background video never played in Chrome: `canPlayType` was asked before `Hls.isSupported()`, and Chrome lies.** The console said `play() refused (NotSupportedError)`, which is NOT an autoplay refusal ,it means the element has no decodable source, and it pointed straight at the source-selection order in `components/hero/video-backdrop.tsx`. **`canPlayType()` returns a three-state string (`""`, `"maybe"`, `"probably"`), and Chrome on Windows answers `"maybe"` for `application/vnd.apple.mpegurl` despite having no native HLS demuxer at all.** The old branch treated any truthy answer as native support, handed the element an `.m3u8` as a plain `src`, and every `play()` then rejected because a playlist is not media. Fixed by asking `Hls.isSupported()` (a real MSE capability check) FIRST and falling back to native only when MSE is genuinely absent ,the order hls.js's own docs use. Native HLS is real on iOS Safari and essentially nowhere else. **This also retires two earlier wrong theories, both recorded here so they are not re-tried:** it was NOT `prefers-reduced-motion` (that skip was removed and the video still did not play), and it was NOT React failing to reflect `muted` to the HTML attribute (`muted=""` was confirmed present in the served HTML). It was never the autoplay policy at all, which is why the same build animated in VS Code's embedded browser: Electron answers `""` to that same `canPlayType` call, fell through to hls.js, and worked. **The lesson worth keeping: a truthy `canPlayType` is not a capability check.** The retry-on-`loadeddata`/`canplay` listeners added while chasing the autoplay theory are kept ,they are harmless and genuinely help a slow first segment |
| 2026-08-28 | **Brand accent moved to azure, and two real bugs behind "the video is a still frame" fixed.** **(1) The accent has now moved twice, and the second move was the informative one:** cyan collided with `--info` (`#5ec8d2`), which `lib/pipeline/labels.ts` uses as the stage badge for **Researching** and **Needs Draft** ,so a "Send Follow-up 1" button in brand cyan read as a pipeline state rather than an action, which is exactly what the first move (mint→cyan) was supposed to prevent. The palette is crowded: green is success, amber is warning, red is danger, violet is Draft Ready, cyan is info. **Blue is the only unoccupied region**, so brand is now `#5c9dff` dark / `#2563eb` light, and it is also further from the background's green cast than cyan was. The rule to keep: before choosing an accent, check `STAGE_META` and `NEXT_STEP_META` in `lib/pipeline/labels.ts`, not just the six `--color-*` status tokens. **(2) The admin backdrop was invisible because two scrims were stacked** ,a flat `bg-background/70` AND a gradient reaching `/80` over a 60%-opacity video, which multiply out to roughly 5% of the footage surviving, i.e. the flat dark page that was reported. Now ONE scrim at `/60`, leaving ~24%. If it needs tuning, change that single number rather than adding a layer; stacked overlays are why the arithmetic became unreadable in the first place. **(3) Playback was attempted once and gave up silently.** First theory ,that React fails to reflect `muted` to the HTML attribute and Chrome therefore blocks autoplay ,was **checked and disproved**: `muted=""` is present in the served HTML. The stream was also verified live (7 renditions, real video). What remained is that Chrome enforces an autoplay policy where VS Code's embedded browser does not, and a single `play()` on `MANIFEST_PARSED` has no answer when it is refused, nor when the promise resolves while the element stays paused. Playback is now retried on `loadeddata` / `canplay` / `canplaythrough` as well, with pointer and key listeners armed UNCONDITIONALLY (not only after a rejection) and removed on the `playing` event. **Not verified in a real browser from here** ,there is no Chrome in this environment, so the console warnings are the diagnostic if it still misbehaves |
| 2026-08-28 | **Whole site returned 504 MIDDLEWARE_INVOCATION_TIMEOUT on Vercel. Root cause was a Supabase-side auth outage; the real defect was that this app let an auth outage take down pages that do not use auth.** Measured directly rather than guessed: every GoTrue endpoint hung past 12s ,including `/auth/v1/health`, which needs no credentials ,while PostgREST answered `/rest/v1/` in **117ms**. So the database was healthy and only auth was down. **Three fixes, all about blast radius rather than about the outage itself.** (1) **`proxy.ts` called `readSession()` BEFORE checking `isPublic()`**, so every hit on the public front page made two blocking Supabase auth calls and then threw the answer away. That is waste on a good day and fatal on a bad one ,a page that reads nothing but anon-granted aggregate views, and has no concept of a user, was 504ing because auth was down. Public paths that need nothing from the session now return `NextResponse.next()` without touching auth; `/login` still reads it (it must know whether to bounce you to `/dashboard`) but degrades safely. (2) **`readSession()` had no timeout and could throw.** The Supabase client inherits no deadline of its own, so on the edge it waits until the platform kills the invocation at ~25s. It now injects a `fetch` bounded at 3s via `AbortController` and catches, **failing CLOSED**: unreachable auth means `userId: null`, so a protected route redirects to `/login` instead of 504ing, and nothing is ever authorised on the strength of an unanswered question. The cost ,a real outage signs everyone out while it lasts ,is the right way round, and `requireAdmin()` plus RLS still stand behind it. (3) **`getPublicStats()` had no timeout and no `try`/`catch`**, so a hung read stalled the render forever and an aborted one would have 500'd, even though the function's return type already carries an `error` field the page renders as a notice. Now bounded at 8s and wrapped, so the worst case is a rendered page saying statistics are unavailable. **Verified against the live degraded Supabase:** before, `/` hung past 30s on roughly three requests in five; after, five consecutive requests all returned 200, the slow ones capping at ~8.2s and the fast ones at 260-770ms, with `/dashboard` at 57ms and `/login` at 63ms. **Note for next time:** `supabase.auth.getUser()` short-circuits without a network call when no session cookie is present, so testing middleware timeouts signed-out proves nothing ,send a dummy `sb-<project>-auth-token` cookie to force the call. Code only, no migration |
| 2026-08-28 | **Brand accent split from status green, video backdrop extended to the admin shell, and three silent failures fixed in the HLS player.** **(1) The accent was the same mint `#5ed29c` the pipeline already uses for success**, which on a dashboard whose whole job is reporting state meant a link and a "Ready to Send" badge rendered identically ,an invitation to read the brand colour as a status. Asked which side should move; the answer was to move the brand. **Brand is now cyan (`#4fd1e0` dark / `#0e7f92` light) and green is reserved for success and positive state.** Cyan was already in the hero glow so it cost nothing elsewhere; the two hardcoded mint values (the primary button's glow shadow, the glow SVG's gradient stops) moved with it, and the glow deliberately no longer reaches green because it sits directly behind the metric tiles. **(2) The looping backdrop now runs behind the admin shell too** (`components/shell/admin-backdrop.tsx`), at the same 60% as the landing hero ,an earlier pass had it at 22%, which was legible but barely visible and did not read as the same design. Contrast comes from a flat scrim under the content rather than a dimmer video: a gradient only guarantees contrast where it happens to be dark, which is fine for a hero with text pooled in one corner and wrong for a table that can occupy every pixel. Visibility through the chrome comes from the `.admin-video` class re-pointing the surface tokens to translucent versions ,no component edits, because everything already reads tokens ,and cards still get NO `backdrop-filter` (20+ per dashboard, blur is per-element). **(3) The player failed silently in three ways**, all found while chasing "the video does not move in Chrome on localhost but does in VS Code": `import('hls.js')` had no `.catch()` so a rejected import looked identical to no video; there was no `Hls.Events.ERROR` handler, so one dropped segment ended playback permanently with nothing logged; and `preload="none"` can leave Chrome not buffering an MSE-attached source at all. All three now report themselves, plus a play-on-first-gesture fallback for a refused autoplay. **The likely cause of that specific report was none of those:** the player skipped the video entirely under `prefers-reduced-motion`, which Windows' "Show animations" setting turns on and which VS Code's embedded browser often does not report ,that skip is removed. If accessibility compliance is wanted back, show a still frame rather than skipping |
| 2026-08-26 | **Full visual redesign: "Liquid Glass / Deep Forest", dark-first, applied through the token layer.** Asked for directly, from a supplied hero spec (full-bleed HLS video, liquid-glass card, quarter-point grid lines, blurred ellipse glow, Inter / Plus Jakarta Sans / Instrument Serif italic, mint `#5ed29c` on near-black `#070b0a`). **The whole re-skin runs through `globals.css`'s semantic tokens** — every component already reads `--surface`, `--primary`, `--border` and friends rather than literal colours, so re-pointing that one block re-themed all 15 routes at once; the per-component edits after it are typography and shape only. Light mode was retuned to the same mint accent rather than dropped, because the top-bar toggle is real. **New:** `components/hero/` — `VideoBackdrop` (hls.js, `enableWorker: false`, lazy-imported, Safari gets native HLS instead, skipped entirely under `prefers-reduced-motion`), `CenterGlow` + `GridLines`, `GlassCard`, `SiteNav` (full-screen mobile overlay, scroll-locked, Escape closes), and `Hero` composing them. The `.glass` / `.glass-frame` utilities live in `globals.css`: the 1.4px gradient border needs BOTH `-webkit-mask-composite: xor` and `mask-composite: exclude` — opposite keywords for the same operation, and shipping one alone fills the element solid in the other engine (both verified present in the built CSS). **Where the video does and does not go, stated because it is a deliberate narrowing:** the hero lands on `/` (the public front page — a genuine marketing surface) and the glow/grid alone on `/login`; the admin routes get the palette, glass highlights, mint accents and typography but NO video and NO `backdrop-filter` on cards. That is not timidity — `backdrop-filter` is the most expensive thing on a page and the dashboard renders 20+ cards, so `Card` uses a raised surface plus an inset highlight that costs nothing and reads nearly identically. Nav links are this app's real destinations, not the spec's `PROJECTS/BLOG/ABOUT/RESUME`, which would 404. **Default theme flipped from `system` to `dark`** in both `theme-script.ts` and `ThemeToggle` (they must agree, or the toggle highlights one option while the page renders another until first click). Verified against a production build and a running server: all four routes 200, hero markup present, all three font variables and `mask-composite` / `background-blend-mode: luminosity` present in the emitted CSS, no server errors. **Corrected same day after review, and worth recording as a rule:** the first pass rewrote page COPY while restyling ,the public page's headline, its full description (a whole sentence about lead identities never being published was dropped), the "Live pipeline data" badge, the "Outreach statistics" subtitle ,and it deleted the `ThemeToggle` from the public header outright, which was a functional regression, not a styling one. All original strings are now restored verbatim and the toggle is back in `SiteNav`; the headline reaches uppercase through CSS rather than by being retyped in caps, so the text still reads as written. **A redesign changes presentation, never wording** ,if a string has to change to fit a layout, the layout is wrong. Also: `pkill` from Git Bash does NOT kill Windows node processes, so a `next start` used for verification survived the session and held port 3000 until `Stop-Process` was used; always verify with `Get-NetTCPConnection` afterwards rather than assuming the kill worked |
| 2026-08-26 | **A failed send now BLOCKS that lead until a human clears it, and failures are collapsed one row per problem — after one bad address wrote 41 identical rejections in fifteen minutes.** Manpower Norge's address carried a stray trailing dot (`firmapost@manpower.no.`), the provider answered `451 4.0.0 Invalid to`, and the scheduler simply tried again every cycle: **41 `send_rejected` rows, 41 wasted send-queue slots**, and it would have continued forever, because no retry can fix a malformed address. `logRefusal()`'s six-hour throttle never applied — that only covers refusals made BEFORE the provider is reached, while a genuine rejection takes the path at the bottom of `sendLeadEmail()`, which UPDATES a freshly-inserted queued row and so was unthrottled by construction. **Throttling it would only have slowed the bleeding, so the retry itself was stopped instead:** `sendLeadEmail()` now refuses any lead holding an unresolved `status='failed'` row (placed beside the archived gate, the one function every send path goes through), and `findDueWork()` filters them out at the end so they cannot occupy a run's `limit` slots and starve healthy leads behind them. Clearing is a human act on `/send-failures` (`clearLeadSendFailures()`): fix the cause, press **Mark fixed**, which DELETES that lead's failure rows — and deleting them IS the unblock, so "is this fixed?" and "are there failure rows?" are one question that cannot drift. Chosen deliberately over a `resolved_at` column (which would have needed a migration this machine cannot apply, and would have left two facts able to disagree); the trade, stated plainly, is that a lead's failure history is gone once cleared — these rows are a work queue, not an audit trail. **Display, all collapsed by (lead, reason):** `/send-failures` shows one row per problem with an attempt count (41 → one row badged "41"), its "why" summary counts problems rather than attempts (41 raw attempts had drowned out two genuinely separate problems beside them), and `/email-logs` now excludes failures entirely — Email Logs is what WAS sent, Send Failures is what was not. **Dashboard:** "Today's Emails" is successes only again (it briefly counted every attempt, on 2026-08-23's reasoning that a hidden failure goes unchased; live that read **101 against 60 real sends** — 68% wrong about the thing it names), and the two permanently-zero tiles "Needs Research" and "Needs Draft" (n8n writes research and drafts before a lead lands, so those stages are empty by construction) were replaced by one **Send Failures** tile linking to the page. That tile counts collapsed problems, not raw rows, because otherwise it would have read 43 against a page of 3 — the "a tile must link to exactly the rows it counted" rule this file is built on. **One-time cleanup, live:** deleted the 2 stale failures for Xtreme fitness and Aracanto (both leads already `sent`, so both had resolved themselves), then hard-deleted 40 of Manpower's 41, keeping only the newest attempt (2026-08-26T12:09:13Z, the one carrying the live `451 4.0.0 Invalid to` text). **43 failure rows in total became 1.** The collapse-by-(lead, reason) display would have shown Manpower's 41 as a single row badged "41" without deleting anything — keeping them was the first instinct and it was overruled deliberately: the attempt count is only worth preserving while a problem is still being diagnosed, and this one was already fixed, so 40 rows of identical evidence for a solved problem is just weight. The badge now reads 1. Verified live afterwards: Today's Emails 60, Send Failures tile 1, page rows 1, Email Logs today 60, leads blocked 1. Checked before deleting that `email_logs_sync_pipeline` fires on `insert or update` only, never `delete`, so removing rows cannot disturb pipeline state. Code only, no migration |
| 2026-08-24 | **Email Schedule: added a "Last 7 days" actual table above the 14-day forecast, and a plain answer at the bottom of the page for "how many more initial emails can I send right now."** The past-week table (`getEmailScheduleForecast()`'s new `pastDays`) reads real `email_logs` sends for each of the 7 calendar days before today in `DISPLAY_TIME_ZONE`, bucketed with one query bounded by `dayBoundsUtc()` on each end (verified live: the window is exactly contiguous with `todayStart`, no gap or overlap, and 420 rows fetched matched 420 counted with zero rows falling outside every day's bucket). The bottom line is just `initialPoolStart` restated as a sentence — the same figure the page already computed, previously buried in a small-print paragraph ("the initial pool started at X") that also mixed in the DISPLAY_TIME_ZONE note; separated it out because the user asked for a single, simple, standalone answer, not a paragraph to parse |
| 2026-08-23 | **The dashboard's Due Today tiles disagreed with the leads page they link to (30/45 on the tiles, 10/0 on `?view=followup1_due`/`followup2_due`) — a FOURTH instance of the server-local-clock bug, in the one place it hadn't been fixed yet.** `idsForView()` in `lib/data/leads.ts` — the function every dashboard tile's `?view=` link resolves through — was still computing "today" as `new Date(); setHours(0,0,0,0)`, the server process's own clock. `getDashboardWidgets()` (fixed 2026-08-20) and `sendsToday()` (fixed 2026-08-22) already use `todayBoundsUtc()` (Asia/Karachi); this file never got the same fix, so on Vercel (UTC) its "today" window sat up to 5 hours off the tile's, and a follow-up due at Karachi midnight — where every due date lands, per 0043 — fell outside it entirely. Fixed the same way as the other three: swapped the bare `Date` math for `todayBoundsUtc()`. **Separately, the Email Schedule forecast (`lib/data/email-schedule.ts`) had two real bugs, not a timezone one — `sending.working_hours` was checked live and is already correctly `09:00–17:00 UTC` = 2pm–10pm PKT, exactly as intended.** (1) Today's row was read as pure history (`email_logs`) and never drew down its own remaining capacity, so everything still due-today-but-unsent at page-load got dumped wholesale into Tomorrow — which is why Tomorrow visibly shrank by exactly `alreadySentToday` (50→43 follow-up 2, matching 7 real sends) every time the page reloaded later in the day: work the cron was still going to attempt before the window closed at 10pm PKT was being shown as if it had already rolled over. Fixed by folding today into the same day-by-day `drawDay()` every later day already gets, seeded with `dailyLimit − alreadySentToday` (zero once the window's actually closed, paused, or not a sending day) — today's row is now one settled number, `alreadySentToday` plus the assumed-successful remainder, same shape as every other row. (2) The 14-day total plus the "still waiting beyond day 14" backlog badge didn't add up to the starting pool (94 initial, reported live) because `successesFrom`/`drawnFor` discounted every projected draw by an observed failure rate — a queue item consumed by a *predicted* failure vanished from the pool without ever appearing in any total on the page. Removed the failure-rate model entirely (`drawDay()` now assumes every draw succeeds, no rounding); verified with a synthetic 94-pool scenario that the 14-day total plus backlog remaining now reconciles exactly. A REAL failure (from an actual attempt, only possible for today) is surfaced instead as `todayFailedCount` — a banner linking to `/send-failures` (the existing "why sends fail" page, unrelated to this fix) rather than a silently reduced number. **Dashboard's "Today's Emails" tile changed the same way, for consistency:** it counted only `sent/delivered/opened/clicked` on `sent_at`, so a failed attempt just wasn't "today's emails" at all — same class of silent omission. Now counts every attempt today on `created_at` (matching `getEmailLogs()`'s own stats row, which already documents "every attempt in range, not just the successful ones"), with a `emailsFailedToday` hint/danger-tone on the tile when nonzero, instead of a number errors could shrink invisibly |
| 2026-08-22 | **0045 — daily-cap-reached email alert, plus `sendsToday()`'s own timezone bug fixed while touching it.** Asked directly: an email whenever the day's send cap is hit, naming who got what (initial / follow-up 1 / follow-up 2, business name, address, time). `notifyDailyCapReachedOnce()` (`lib/services/outreach/scheduler.ts`) hangs off the exact branch that already detects "nothing more can send today" — so it fires whichever run notices the cap first, whether that run's own sends completed it, an earlier run's did, or even a manual Send-button click outside the scheduler did (`sendsToday()` counts every send regardless of origin). Guarded against firing on every subsequent 3-minute tick by a settings ROW (`outreach.daily_cap_alert_date`), not an in-memory flag — each cron invocation is a separate cold process, so "already sent today" has to be a database fact, the identical reasoning `gapRemainingMs()` already applies to send pacing. Recipient is a setting too (`outreach.daily_cap_alert_email`, defaults to rayyanmasroor8@gmail.com) rather than hardcoded, same as every other outreach.* knob in this project. **Found and fixed in passing:** `sendsToday()` — the function that gates the cap this whole feature hangs off — was still using `new Date().setHours(0,0,0,0)`, the SERVER's own local clock, not `DISPLAY_TIME_ZONE`. This is the exact class of bug the 2026-08-20 entries below fixed twice already (`getDashboardWidgets()`'s tiles, `findDueWork()`'s due-date bucketing) and had been explicitly flagged as a known, related, not-yet-fixed gap each time — left alone until it was the actual function the new feature needed to trust. Now reads `todayBoundsUtc()`, same as the other two. Migration is settings-data only, no function changes; NOT YET pasted — see section 2. **Separately surfaced while tracing why a reply-triggered close looked wrong (not yet fixed, flagged for a decision):** `setInboundSentiment()` closes the workflow and sets `auto_followups = false` when set to `unsubscribe`, but changing the sentiment away from `unsubscribe` afterwards does not reopen anything — there is no undo via the Replies buttons. Found live on a real lead (HAMNØY AS) closed with `closed_reason: 'Recipient asked to be removed'` while its sentiment currently reads `positive`, an internally contradictory state produced by exactly that gap |
| 2026-08-20 | **"Ready to Send 79" against 138 genuinely-ready leads ,PostgREST's 1000-row cap, silently truncating a lookup Set.** Chased properly this time after two earlier passes wrongly concluded "stale page": the user named two specific leads, one apparently in the ready set and one not, and a field-by-field probe found them **identical** on every input to `compute_pipeline_stage()` and `compute_send_priority()` (both stage `approved`, both `send_priority` 2, both holding an approved ACTIVE initial version). Nothing about the DATA distinguished them ,so the bug had to be in the reading, and it was. Both `getDashboardWidgets().readyToSend` and `lib/data/leads.ts`'s `ready_to_send` view selected **every** approved+active+initial `email_versions` row with no `.limit()`, built a Set of lead ids, and intersected. This project's PostgREST caps a response at **1000 rows, server-side**: measured live, **1,239** such versions exist, the query returned exactly **1000**, and `.limit(10000)` returned **1000 too** ,the cap is not client-overridable and raises no error, so the Set simply came back missing 239 leads and the intersection produced **exactly 79**, reproducing the reported number precisely. Which 59 ready leads got dropped was decided purely by row order, which is why it looked random and why two identical leads landed on opposite sides of it. Fixed by INVERTING both queries ,fetch the candidate pipeline rows first (138), then look their drafts up with a chunked `.in()` bounded by that list, so a whole-table scan is never involved. `getSendQueuePreview()` already had the correct shape and was unaffected, which is also why the Send Queue card and this tile had been quietly disagreeing. **The general lesson, worth more than this one fix:** on this project any unbounded `select` that can exceed 1000 rows is silently truncated, `.limit(n > 1000)` does NOT lift it, and nothing errors ,prefer `.in()` bounded by a known candidate list, or page with `.range()`, and never trust a big select to be complete. `lib/data/email-schedule.ts` was audited and paged for the same reason in the same session |
| 2026-08-20 | **Email Schedule rebuilt: today is read, not projected; failures priced in; cascades no longer double-counted.** Three corrections after the first version was checked against a hand-run simulation and didn't match. (1) **Today's row now shows what ACTUALLY sent**, read from `email_logs` and broken down by type ,verified live at 2 follow-up 2 / 51 follow-up 1 / 7 initial, matching the user's own dry run exactly. The previous version projected today and rendered all dashes, because 60/60 was already spent; projecting a day that is largely over is predicting the past, and predicting it wrong. (2) **Send failures are measured and applied** to future days at the observed rate (0.27% over 14 days, from real `email_logs` history ,never hardcoded). The mechanic that matters is non-obvious: a failed send does **not** consume a slot in the daily cap, because `sendsToday()` counts only sent/delivered/opened/clicked ,so the sender keeps going until it has `dailyLimit` successes, and a failure drains the QUEUE slightly faster rather than making a day send less. Modelled with rounding, not flooring, so a 0.3% rate cannot invent a failure inside a queue of 23 that the measurement doesn't support. (3) **Cascades from sends that already happened are counted from the database, never re-simulated.** `sync_pipeline_from_email_log()` writes the next step's due date at send time, so today's 51 follow-up 1 sends were ALREADY sitting as 50 `followup2_due` rows on today+2, and today's 7 initial sends as 7 `followup1_due` rows on today+7 ,both confirmed by histogram before writing the code. Re-cascading today's row in the loop would have double-counted every one of them; the loop now cascades only the days it projects. Delays come from `outreach.followup1_delay_days` / `followup2_delay_days`, and the initial pool is a fixed depleting count (138 today) that is explicitly not treated as self-refilling, since a draft nobody has approved yet is a guess this function refuses to make |
| 2026-08-20 | **New page: Email Schedule, a 14-day send forecast.** Asked directly, for the next two weeks, F2/F1/Initial per day. `getEmailScheduleForecast()` (`lib/data/email-schedule.ts`) is deliberately NOT a second scheduler ,it reads the exact same `followup1_due`/`followup2_due` values and the same approved-and-verified initial pool `findDueWork()` reads, and spreads the same priority order (follow-up 2, then follow-up 1, then initial) and the same daily cap across 14 calendar days instead of just "now": a day's leftover backlog rolls into the next day's queue exactly the way "overdue" already works for a single day today. Explicitly does NOT simulate a follow-up 1 sent on a forecast day spawning a new follow-up 2 further down the window ,that would compound a projection on top of a projection, so day 14's number would depend on every guess made about days 1–13. What's shown is "what's already scheduled, spread across the cap," stated as such in the page copy. Respects `sending.paused`, `outreach.auto_followups`/`auto_send_initial`, and `sending.working_hours.days` (a non-working day reads zero, not skipped from the list). Code only, no migration |
| 2026-08-20 | **Three dashboard questions, answered against the live database rather than the code alone ,one was a genuine bug, two were not.** All three probed with the exact filters the real queries use (via `npx tsx --conditions=react-server`, not by reading the source and guessing), per the standing rule in this project that a query returning nothing and a query returning correctly-nothing look identical from the outside. (1) **Stage dropdown showed Researching / Needs Draft / Draft Ready blank instead of 0** ,not a bug: a direct probe of `lead_pipeline.current_stage` (the stored column, ground truth) found genuinely zero leads at all three stages, active or archived. `lead_stage_counts` is a GROUP BY view, so a stage with zero rows to group on ,not even an archived one ,produces no row at all, which is also why Dead Address correctly read 0: at least one archived lead sits there. Fixed anyway, because the blank was misleading regardless of cause: `FilterPanel` now falls back to 0 for a missing facet key instead of hiding the count. (2) **Ready to Send (79) looked much lower than Initial Approved (143)** ,also not a bug: those two numbers are intentionally different (Ready to Send additionally requires `send_priority < 9` and a genuinely matching APPROVED ACTIVE draft version, not just the `lead_pipeline.approved` flag, which 0039 already proved can go stale). A live probe found ALL 138 non-archived approved leads currently clear both extra gates ,so the two figures should read close together right now, and the 79 the user saw was very likely this same live, constantly-advancing pipeline at an earlier moment, or a page that had not yet caught a realtime refresh. (3) **Send Queue showed all-initial, 23 follow-up 2s were reported due, and the last sends were all initial, not F2 ,this one WAS a real, confirmed bug.** A probe of the real scheduler's own query found 0 follow-ups genuinely due right now, which is exactly why it correctly sent initial candidates instead ,nothing was wrong with the sender or the Send Queue preview. But `getDashboardWidgets()`'s "Due Today"/"Overdue" tiles used `startOfToday()`/`endOfToday()`, a bare `new Date().setHours(0,0,0,0)` on the SERVER'S OWN clock ,not `DISPLAY_TIME_ZONE` (Asia/Karachi) the way `findDueWork()` and `getSendQueuePreview()` already correctly do via `dayBoundsUtc()`. This exact gap was already named in this guide as "related, NOT-yet-fixed... correct by accident on a PKT dev machine, wrong on Vercel's UTC" when 0035-era work first noticed it, and this is the day it produced a measurable, reproduced number: 23 leads have `followup2_due = 2026-08-20T19:00:00Z`, which is midnight AUGUST 21 in Karachi ,due tomorrow, not today ,but falls squarely inside a UTC calendar day's "today" window, which is what a Vercel-hosted server actually runs on. Fixed by extracting the three-line day-bounds computation `findDueWork()`/`getSendQueuePreview()` already had duplicated between them into one shared `todayBoundsUtc()` (`lib/utils.ts`) and pointing `getDashboardWidgets()` at it too, so a fourth call site can no longer drift from the other two ,closing the gap this guide flagged as open five entries below (2026-08-10, "Send order: overdue backlog now outranks..."). Code only, no migration |
| 2026-08-18 | **0044 ,`leads.website` rejects social-media links, at write time and retroactively.** Asked directly: leads whose "website" is really a Facebook or Instagram (or other social) profile URL should have it cleared, and it should stay cleared going forward. `normalize_blank_lead_fields()` (0031's trigger, the one BEFORE-write gate every writer of `leads` already passes through ,including n8n's direct inserts, which application code alone cannot reach) now also nulls `website` when it matches a social-media host, plus a one-time backfill of every lead already carrying one. `normalizeWebsite()` in `lib/import/normalize.ts` gets the identical check as a courtesy ,the workbook importer can report it as a visible warning at import time ,but the trigger is the real, comprehensive gate; the importer's copy is a second statement of the same rule, not a substitute for it. Migration NOT YET pasted ,see section 2 |
| 2026-08-18 | **Leads-missing-email round trip: an upload to match the download, and two columns dropped from the file.** The "Leads with no address" download (`missing.csv`) existed with nothing to bring the found addresses back with ,asked for directly, "like I can download and upload email verification ones, I need one for leads missing emails as well." New `importFoundEmailsCsv()` / `uploadMissingEmailsCsv()` round-trips it: since there is no address yet to match rows on, matching falls back to business_name + city + country + niche exactly as the download had them, and only applies when that combination resolves to EXACTLY one lead still missing an address ,zero matches or more than one both leave the row alone rather than guess. The candidate pool for both the download and the upload's matching is now one shared function, `getLeadsMissingEmail()`, so the two halves of the round trip can never disagree about which leads are in scope. Also asked for directly: `website` and `phone` are no longer columns in the download ,dropped from the query itself, not just hidden from the file ,and the file sorts alphabetically by business name now that the old "site first" sort order had nothing on screen to explain it. New Card on the Settings page, "Leads with no address", split out from "Email verification" since sourcing an address and verifying one are different jobs with different files |
| 2026-08-18 | Send Failures rows are now tap targets, both renderings. The mobile card list wraps each `<li>` in a `<Link href="/leads/{id}">`, same pattern as the dashboard's feed lists. The desktop table can't do that ,an `<a>` can't wrap a `<tr>`, that's invalid HTML ,so it uses the stretched-link trick instead: a `<Link>` with `absolute inset-0` inside the first cell, positioned against `position: relative` on the `TR`, which needed `overflow-visible` on that one cell to escape `TD`'s default `overflow-hidden` (otherwise the tap target would be squeezed to just that column's width instead of the full row) |
| 2026-08-17 | **"Due today" now means due, and 286 stale drafts were rewritten to say so.** Three follow-ons from the same session, all asked for directly. (1) **The sender was still waiting for the minute.** `findDueWork()`'s today buckets were bounded `lte(due, now)`, which re-imposed exactly the minute precision 0042/0043 removed ,for the 137 pending rows still carrying a pre-0042 value. Measured, not assumed: 26 follow-ups were due on 17 Aug and **every one was invisible to the cron until 15:12 PKT**, the last until 17:00 PKT, because their due times had fossilised the `*/3` cron pacing of a send made days earlier (15:12, 15:15, 15:18… stepping by three minutes). Bound moved to `dayBoundsUtc().end`. For a row on the current 0043 pattern this is a no-op ,midnight is `<= now` at every hour of its own day ,so only legacy rows change, and tomorrow cannot leak in because the bound is this calendar day's last millisecond in `DISPLAY_TIME_ZONE` (verified: 0 rows due tomorrow fall inside it). `getSendQueuePreview()` changed identically, per that file's own rule that it is a mirror; the dashboard's "Due Today" tile had always used the day bounds, so this ends a real disagreement between the count and the sender. **No migration and no data rewrite** ,the legacy rows keep their values and are simply read correctly, which is reversible in a way an UPDATE would not have been. (2) **`refreshStaleFollowupDrafts()`** (`services/drafts/refresh.ts`), because a template fix only affects the NEXT generation and the scheduler writes a follow-up only when none exists ,so 286 already-written drafts were still holding the old wording and would have gone out that way. Three conditions gate it and each is load-bearing: `generated_by = 'template'` (a human edit is recorded as `manual` by `saveDraft()`, so this provably cannot lose anyone's wording), the step must be UNSENT (a sent version is the record of what went out), and the fresh draft must actually DIFFER ,compared rather than pattern-matched, which is what makes it idempotent and what makes it survive the next template change instead of being tied to one bad phrase. Every rewrite is a new version, so the old wording stays in the history. Run live: 286 rewritten, 0 failed, 0 hand-written drafts touched, and a re-probe confirms 0 advice-shaped drafts remain in the queue. Exposed as its own Settings button, deliberately separate from "Generate missing follow-up drafts" ,that one's safety comes from never overwriting, and blurring the two would cost it. (3) **Copy quality, checked against the real corpus rather than by eye.** Asked to verify the result "shouldn't sound AI generated". It still did, for reasons the measurements named: 62 of 350 subjects were over 60 characters (the limit `prompt.ts` states and the template ignored) and 71 business names carried scraped legal/SEO tails ,`Clean & Pure GmbH \| Gebäudereinigung & Büroreinigung in Hamburg`, one styled in mathematical-bold Unicode to stand out in search results. New `shortName()` normalizes NFKC (which is exactly what maps those code points back to letters) and cuts at the first pipe, bracket, comma or spaced dash, with a word-boundary clamp as a backstop: **62 over-length subjects became 6**. It is used for every place the business is addressed, subject and opener alike. **A second-person rewrite was measured and rejected**: 132 of 350 angles refer to the lead in the third person, but only 4 could be swapped to "you" safely and one of those four produced "you is a pioneering cafetería" ,so instead the follow-up 2 lead-in names the sentence as a note I made when I looked them up, which makes the third person correct rather than wrong, since that is literally what it is. Also fixed two sentences that had lost their punctuation: "never heard back no problem" and "Hi I came across" |
| 2026-08-17 | **The template generator was pasting research NOTES into the mail as body copy, and 782 of them were the word "Offer".** Reported directly: follow-up 2 "makes it seem like we are asking them to offer", quoting a live draft whose middle paragraph read *"Emphasize the unique features and benefits of Chiang Mai as a desirable location for real estate investment…"* ,sent to a real estate agency in Chiang Mai. Confirmed at the source: that is `leads.outreach_angle` for Chiangmai Best Homes, pasted verbatim by `bestAngle()`, which tried that field FIRST. Every research field here is written as advice TO WHOEVER DOES THE OUTREACH, not as a sentence for the lead, and a bare imperative pasted into a body has no subject left except the reader. **Not an edge case: 782 of 958 non-archived leads have an `outreach_angle` opening "Offer to …"**, plus 17 "Highlighting the…", 13 "Given the…", 11 "Highlight the…", 4 "Emphasize the…"; `personalization` adds 107 "Congratulate them on…". One lead had a literal `N/A` in every field, which the old code returned verbatim as body copy (its `return trimmed.slice(0, 220)` fired on the first non-empty candidate instead of continuing, so a short junk value could never fall through). Fixed by SKIPPING advice-shaped candidates rather than trying to rewrite them ,a deterministic template cannot turn arbitrary strategy notes into first-person prose without producing something worse, and there are five more fields to fall through to. `outreach_angle` deliberately KEEPS its first place: a hand-written angle is still the best line on the lead, so the machine-written ones lose by failing the shape test, not by being read last. Gerunds are deliberately not blanket-matched ,"Automating enquiry handling would free up…" is an observation and reads correctly, "Highlighting their expertise could be an effective angle" is advice, and what separates them is the predicate, not the opening word. **Verified by running the real `TemplateGenerator` over all 1000 non-archived leads: 0 advice-shaped angles survive, and only 25 (2.5%) fall through to the generic line** ,22 of those have no research at all and 3 have nothing but a "Congratulate them on…" note, so nothing usable was lost. Separately, follow-up 2's SHAPE was the reason this landed so badly there and not in follow-up 1 (which the user likes and which is unchanged): follow-up 1's closing ASK re-anchors the whole email as ours, while follow-up 2 deliberately has no ask, so the angle paragraph IS the email. It now carries an explicit lead-in naming whose thought it was ,belt and braces with the filter, not a substitute for it. Also fixed in passing: the subject was `Closing the loop ${business_name}` with no separator, now `Closing the loop on …`; and `{{angle}}` is substituted through a replacer FUNCTION, because a string replacement interprets `$&` and `$'` in the replacement and research prose contains bare `$` |
| 2026-08-17 | **"Follow-up 2 due in 3 minutes" ,0042/0043 fixed the data and nothing fixed the display.** Reported directly: "we changed the follow ups to be due wrt the day, not the minute but the code still says follow up 2 due in 3 mins." Both places that render a due date passed it to `formatRelative()`, which is minute-precise by design and correct for the thing it was built for (a send, a reply, a check ,real instants where the minute is part of the fact). A due date is not one of those: it is a whole calendar day stored as that day's midnight, so `formatRelative()` counted down to a boundary that carries no meaning ,"in 11 hours", then "in 3 minutes", then "16 minutes ago" ,and invited exactly the reading that mail was about to leave at 00:03. New `formatDueDay()` counts a difference of CALENDAR DAYS in `DISPLAY_TIME_ZONE`, not elapsed milliseconds over 86,400,000: at 23:00 tonight, midnight tomorrow is one hour away and one day away, and for a date "tomorrow" is the true answer. It also flips at local midnight, the same boundary `dayBoundsUtc()` and the scheduler's own day buckets use, so it cannot disagree with them by a few hours. The old formatter was additionally off by one on these values ,a date 6 calendar days out read "in 5 days" ,because a partial first day rounds down. Wired into `PipelineTracker` ("Due today." / "Due in 3 days.") and the `PipelinePanel` stamps list, where the two kinds of timestamp now render differently on purpose: `day: true` marks the due rows, everything else keeps minute precision. Both carry the exact date as a `title` tooltip. **`Date.UTC(y, month - 1, d)` is load-bearing** ,Intl reports a 1-based month, and passing it straight through makes a comparison that straddles a month boundary silently gain or lose a day (31 Aug → 1 Sep computes as 0 days). Verified across the boundary cases: 23:57 PKT reads "today", 00:03 PKT reads "tomorrow", 31 Aug and 1 Sep read "in 14 days" and "in 15 days". **The 137 pre-0042 pending rows still carry minute-precise due dates** (neither migration is retroactive, deliberately), so for those the display now states the intended rule a few hours before the sender acts on it ,flagged, not silently rewritten, because "deliberately not retroactive" was a recorded decision and reversing it is a data change worth asking about. **Resolved the same day by the entry above**, and not by rewriting those rows: the sender's own day bucket was widened to end of day, so it now agrees with what the display says without any row changing |
| 2026-08-16 | **0043 ,0042 shipped a real Postgres bug, caught the same day it was pasted.** Asked directly: "didn't we already fix follow-ups to be due by date, not the exact minute ,so why does one still say due in 5 hours?" Live data said 0042 HAD been pasted (a fresh send minutes old already had a due date computed), but a deterministic test ,a throwaway lead sent at a known, deliberately odd instant (16 Aug, 21:47:13 PKT) ,showed the computed due date landing on **10:00:00 PKT**, neither the old minute-precise behaviour nor the intended midnight. Root cause: `date AT TIME ZONE zone` is genuinely ambiguous in Postgres ,a bare `date` has implicit casts to BOTH `timestamp` and `timestamptz`, `AT TIME ZONE` is overloaded on both, and it silently resolved to the wrong one, round-tripping the value through the session's UTC default twice (once casting the date to `timestamptz` before converting to Karachi wall-clock, once casting that plain timestamp back to `timestamptz` on assignment) ,exactly a double application of the +5:00 offset, which is exactly the 10-hour gap observed. **This is invisible to `tsc`, to `next build`, and to hand-tracing the logic** ,it only exists once Postgres itself resolves the overload, and this project has no CLI to execute the DDL and catch that before pasting. Fixed with an explicit `::timestamp` cast immediately before the final `AT TIME ZONE`, which leaves no ambiguous operand for Postgres to mis-resolve (an exact type match always wins over one needing a cast). Checked the blast radius before writing the repair: 542 pending due-dates were still safely on the pre-0042 pattern (untouched, as designed), 0 were correctly on the new pattern, exactly 1 had the buggy signature ,migration includes a tightly-scoped repair matching only that third state (provably neither the exact pre-0042 pattern nor an existing midnight), so it cannot touch a row it shouldn't. Applied migrations are immutable in this project, so 0042 stays in the table as-is with a note rather than being rewritten ,same pattern as every other correction here |
| 2026-08-15 | **0042 ,a follow-up's due date is a whole day, not a timestamp.** Directly asked for, and the reasoning behind it turned out to explain a question from earlier the same day: "why did only follow-up 1 send today, not any of the 34 follow-up 2s?" ,live data showed the answer was simply that none of today's follow-up 2s had crossed their due MINUTE yet (they started at 15:18 PKT; the check was at 14:45), and that minute is an accident, not a rule: `followup1_due`/`followup2_due` were computed as `sent_at + N days`, exact timestamp arithmetic, so a whole cohort's due times end up scattered across the day at whatever pace the ORIGINAL send happened to land at (confirmed live: stepping in the same 3-minute intervals the scheduler's own `*/3 * * * *` pacing produces, days later). Asked to fix it directly: "even if the mail is 3 days old at 3pm, its still 3 days old... not counting till minutes." Both functions that compute these ,`sync_pipeline_from_email_log()` (this app's own sends) and `sync_pipeline_from_lead()` (n8n-reported sends, the other writer since Sheets was retired ,0033) ,now truncate to the calendar day (Asia/Karachi, matching `DISPLAY_TIME_ZONE`, deliberately not `sending.working_hours`' own independently-set timezone, live value `UTC`) before adding the delay, landing on that day's midnight: `((sent_at at time zone tz)::date + N) at time zone tz`. Verified against the user's own example (follow-up 1 sent 21:59 PKT on the 12th → follow-up 2 now lands at midnight PKT on the 15th, not 21:59) with a JS reproduction of the exact Postgres arithmetic, since this machine has no CLI to apply and query the real function directly ,see section 2 for the probe to run once it's pasted. **Deliberately not retroactive**: both functions only ever set these columns once (`coalesce(existing, ...)`), so this changes the next computation, not anything already scheduled ,today's real due dates keep their current minute-precise values. Send TIME is unaffected either way; `sending.working_hours` and the min-gap pacing still decide that exactly as before, this only changes when something starts counting as due |
| 2026-08-15 | **Send order: overdue backlog now outranks today's fresh batch, within each step.** Asked directly: 54 follow-up-1s and 34 follow-up-2s were due, the daily cap is 60, so 28 follow-up-1s would be deferred ,"will they go out tomorrow, or do I have to send them by hand, and can the priority be backlog-first?" They do go out on their own (a deferred item's due timestamp does not change, so it is still "due" on every later run until sent), but the OLD order ,all of follow-up 2, then all of follow-up 1, oldest-due-first within each ,had a real starvation hole: a busy follow-up-2 day (one big enough to fill the cap on its own, which 65+ due F2s can) would fully drain the budget before a single OVERDUE follow-up-1 was even attempted, so a backlog could get re-deferred day after day by every new day's "higher priority" step, indefinitely. `findDueWork()` (the real scheduler) and `getSendQueuePreview()` (the dashboard card documented as its mirror ,kept in step, per that file's own rule) both now query four buckets instead of two: follow-up-2-overdue-before-today, follow-up-1-overdue-before-today, follow-up-2-due-today, follow-up-1-due-today, concatenated in that order, then initial sends unchanged. Type priority is preserved WITHIN an age tier (follow-up 2 still beats follow-up 1 at equal age) ,only the priority OF a fresh same-day batch over an older backlog is removed. "Today" is a calendar day in `DISPLAY_TIME_ZONE`, not the server's own clock, using `dayBoundsUtc()` (the same helper built for the Email Logs date filter) rather than the server-local-midnight boundary `sendsToday()`/the dashboard's `startOfToday()` still use elsewhere ,those two are a related, NOT-yet-fixed gap (correct by accident on a PKT dev machine, wrong on Vercel's UTC), flagged but out of scope for this change. **Verified two ways**: live queries confirmed the four-bucket split runs correctly against `DISPLAY_TIME_ZONE`; a pure-logic two-day simulation using the user's exact numbers (54/34, cap 60) proved the actual failure mode ,under the old order, a busy 65-item follow-up-2 day left all 28 of yesterday's deferred follow-up-1s stuck a second time; under the new order, all 28 go out first, before any of that day's follow-up-2 batch. Also fixed in passing: a stale `(0042)` migration reference on `getSendQueuePreview()`'s comment ,that fix was code-only and 0042 is still the next free number, same mislabeling mistake as the earlier `(0040)` one |
| 2026-08-14 | **Charts get hover tooltips, and a Vercel deploy error is fixed.** (1) `charts.tsx` (`LineChart`/`MultiLineChart`/`BarList` ,every trend line and bar list on `/analytics` and the public page, one shared module) is now `'use client'` and tracks the nearest point to the pointer, showing a floating tooltip: date + value for a single line, date + every series' value (colour-matched to the legend) for a multi-line chart, value + share-of-total for a bar. Mouse AND touch (`onTouchStart`/`onTouchMove`/`onTouchEnd` wired to the same handler), so it works on the public page from a phone. **Tooltip HTML lives outside the `<svg>`, positioned by percentage** ,not a `<foreignObject>` inside it, because every chart here uses `preserveAspectRatio="none"`, which stretches x and y by DIFFERENT factors once a card is any width but 640px, and `foreignObject` content would be stretched by that same non-uniform factor into visibly warped type. **Turning the module client-side broke both pages it feeds, past what typecheck/build catch**: `BarList`'s `colorFor?: (label) => string` prop is a plain closure, and a Server Component cannot pass a function to a Client Component ,React has no way to serialize it across that boundary. Every real call site (5, across `analytics/page.tsx` and `stats-page.tsx`) passed a closure that ignored its `label` argument and returned one fixed colour anyway, so the fix was `colorFor` → `color: string`, not a workaround. **This class of bug is invisible to `tsc` and to `next build`** ,both stayed green on the broken version, because it is a *runtime* RSC-serialization rule, not a type error, and the affected routes are dynamic (server-rendered on request), so static generation never actually executes the broken render path. Only caught by really loading the pages: headless Chrome, logged in as a throwaway admin, hit `/analytics` and got Next's generic 500 boundary; the real stack trace was in the dev server's own log, not the browser. Re-verified after the fix with real pointer events (`Input.dispatchMouseEvent`, not just reading React state) against both pages ,analytics tooltip and the public page's "Emails sent: 59 / Replies: 1" both confirmed on screen, zero console errors. (2) **`vercel.json`'s cron was already failing every deploy.** It declared `/api/cron/outreach` on `0 * * * *` (hourly) ,Vercel's Hobby plan now restricts cron jobs to once-per-day, full stop, and a more frequent expression fails at deploy time rather than degrading. Changed to `0 9 * * *` (valid, once daily). **This Vercel-native cron is not what actually drives outreach** ,section 12's "Two scheduled jobs" note already establishes that an external service, cron-job.org, is what calls `/api/cron/outreach` every 3 minutes and `/api/cron/approve-drafts` every 4 hours; this entry looks like a leftover/backup trigger from before that was set up. Left in at a valid schedule rather than deleted, since there is no strong signal either way on whether the redundancy is intentional |
| 2026-08-14 | **Email Logs gets a date filter with a stats row, Leads gets a website filter. Both code-only, no migration.** (1) Email Logs: `?from=`/`?to=` (a date `<input>` each) filter the list to a single day or a period, no filter means all time, same as always. A new stats row above the list ,Total / Initial / Follow-up 1 / Follow-up 2 ,summarises the SAME filtered population the list shows, not a separately-scoped figure, computed by an unpaginated `select('email_type')` scoped to the same bounds. **The one real subtlety**: a date typed into the picker means a calendar day in `DISPLAY_TIME_ZONE` (Asia/Karachi by default), not the server's own clock (UTC on Vercel) ,so `dayBoundsUtc()` (new, in `utils.ts`) resolves "2026-08-14" to the actual UTC instants that day starts and ends at THERE, using `Intl.DateTimeFormat({timeZoneName:'longOffset'})` rather than a fixed-offset assumption, so it stays correct for a zone that observes DST too (checked against America/New_York across a DST boundary, not just the zone this project actually uses, which has none). Verified against a live day's rows: 0 rows inside the computed bounds belonged to any other calendar day. (2) Leads: a "Has website" / "No website" toggle, independent of stage/verification/view ,a website is a fact about the lead, not a pipeline position, so it filters `leads.website` directly (`is null` / `not null`) rather than joining through the `idFilters` intersection those three use, and composes with any of them by plain AND. `website is null` is the complete check ,no orphaned `''` to also handle ,because the column has carried a `website is null or website ~* '^https?://'` CHECK since the table's first migration, confirmed live (0 rows with `website = ''`). **Both verified in a real logged-in browser**, not just against the query: the rendered stats tile, the rendered lead count, and a combined `?website=yes&verify=valid` request all matched the raw database counts exactly (60 / 107 / 300) |
| 2026-08-12 | **Live updates ,pages refresh themselves instead of waiting for a human to.** Asked for as "data is updated automatically instead of a refresh". Built as Supabase Realtime → debounced `router.refresh()`, deliberately NOT as client-side row patching. The reason is this guide's most-repeated rule: every page here is a server component whose rows come from `src/lib/data/*`, and that is where the filtering lives ,archived excluded (0034), `send_priority < 9` (fixed the same day), active-version-approved (0039), the send queue's three-part order mirroring `findDueWork()`. Splicing a realtime row into a client table means re-deciding all of it in a browser, which is the "two implementations of the same rule" mistake that has already put the board and the sender out of step more than once. A refresh costs one re-query and keeps one definition; it also preserves client state (selection, half-typed inline edits, open dialogs, scroll) where a `location.reload()` would not. One subscription mounted in the (app) layout for `role === 'admin'` only, so a page added later is live by default rather than live only if somebody remembered ,the same argument as putting the send gates inside `sendLeadEmail()`. Security is inherited, not rebuilt: every published table already carries `for select to authenticated using (public.is_admin())` and Realtime applies RLS per subscriber. Bursts coalesce on a 400ms quiet window with a **5s ceiling** ,a pure debounce starves under a long send run and would never fire at all. **Verified end to end in headless Chrome**: logged in as a throwaway admin, opened Send Failures, then inserted a row from a SEPARATE Node process (i.e. what another user or the scheduler looks like) ,it appeared in ~4s with `performance.getEntriesByType('navigation').length` still 1, proving no reload, and zero console errors. Migration 0041 publishes the eight tables, but probing found `email_logs`, `leads` and `lead_pipeline` already published on this project, so it is a no-op safety net rather than a prerequisite ,and the first probe of that returned a FALSE NEGATIVE by writing before the replication stream had settled, which is now written down next to the migration so the next person does not re-learn it |
| 2026-08-12 | **"Ready to Send" counted 3 leads the sender would refuse forever.** Asked why they weren't in the Send queue. All 3 (Regimo Zürich, Dr. Roop Saini, Thomas Barry & Co) had `email_verified = true` ,a human had ticked the box ,while `email_verifier_status` was still `'invalid'` from an earlier verifier check nobody had overruled by correcting the address, only by ticking a box. `compute_pipeline_stage()` only ever reads the boolean, so all three cleared the `approved` stage gate and the tile counted them; `compute_send_priority()` reads both and marks that combination 9 ("not sendable"), and `sendLeadEmail()` refuses it unconditionally ,"the machine wins" once a verifier catches a real bounce, by design (see the `email_verifier_status === 'invalid'` gate in `send-lead-email.ts`). Same root cause, no migration: added `.lt('send_priority', 9)` to both the dashboard tile (`admin-dashboard.ts`) and its linked list (`leads.ts`'s `ready_to_send` case, switched from `lead_pipeline` to `pipeline_board` to read the column at all) ,reusing the one computed value the Send queue and the scheduler already trust rather than re-deriving the rule a second time. Verified live: the count dropped from 3 to 0, matching the Send queue's own "0 initial candidates due" exactly. The 3 leads themselves are not a bug ,they genuinely need a new address; ticking "verified" cannot undo a verifier's bounce, only replacing the address can (0028 resets the verdict on an address change) |
| 2026-08-12 | **0040 ,every send refusal is logged now, not just provider-level failures, and there is a page for it.** Asked: whenever an email fails, show why, on a new page below Email Logs. Root cause of "why" being invisible in the first place: `sendLeadEmail()` has nine return points and only the LAST ,a genuine SMTP-level rejection ,ever wrote to `email_logs`; the other eight (archived, no email, verifier says invalid, unverified, no draft, no subject, provider misconfigured, an unresolved placeholder) just returned. Exactly the shape of the bracketed-name bug two rows below this one: a real failure with zero trace anywhere. Added `email_logs.failure_reason` (one nullable text column, no new enum value needed ,`status='failed'` already covers it) and a `logRefusal()` helper that every one of those eight branches now calls, writing `provider = NULL` (a real rejection always has `provider.id`, so the two stay distinguishable) plus a stable reason code. **Throttled to one row per lead+type+reason per six hours** ,the scheduler retries a due lead every tick, and logging unthrottled would recreate the exact "failed on every 3-minute tick for hours" problem `summary.notes` hit three rows below, just in `email_logs` instead of `integration_runs`. New page **Send Failures** at `/send-failures` (sibling route, not nested under `/email-logs` ,nesting it there would have doubled up the sidebar's active-link highlight, since `pathname.startsWith('${href}/')` would mark both Email Logs and the new page active at once; nav ORDER puts it directly below Email Logs instead, which is what "just below" actually asked for), added to `proxy.ts`'s `ADMIN_PREFIXES` since that gate is separate from the nav list. Shows a "why, in the last 14 days" summary (grouped counts, so a bug fixed months ago doesn't outrank what's actually failing today) above the full paginated history; both exclude archived leads, same rule as everywhere else. Migration NOT YET pasted ,see section 2 |
| 2026-08-12 | **GUIDE.md itself audited against the live codebase.** Section 12 was still titled "Audit 2026-08-05 ,open findings, NOTHING FIXED YET" a week after every finding in it had shipped, with a stale numeric snapshot (701 leads, tile counts in the hundreds) that had not been true since the day it was written ,227 lines collapsed to a ~35-line summary, the accurate historical narrative below it (0026 onward) kept as-is. Section 1's "Current state (2026-08-05)" claimed migrations stopped at 0023 and quoted week-old figures; both replaced with today's, and the "never count archived" rule ,until now only in this agent's private memory, not in the project's own source of truth ,is now stated in GUIDE.md itself. **Section 2's migration table was ALSO stale**, including on recent rows: 0031, 0032, 0036, 0037 and 0038 were all marked NOT YET despite being live, because "table exists" is not evidence a migration ran (0035's own lesson, forgotten one section later). Re-verified all nine ,0031 through 0039 ,with a live functional probe apiece (an insert that should be rejected without the fix, a value that should differ without it ,never a bare `select` that merely returns rows, since empty and doesn't-exist-yet look identical from the client). All nine confirmed applied. Section 5's directory map was missing `services/drafts/` (quality.ts, sweep.ts ,a whole subsystem) and the second cron route entirely. Section 10 documented a Google Sheet that no longer exists. A changelog row from earlier today had literal unescaped newlines in the source, silently breaking that table row across three lines |
| 2026-08-12 | **`generateMissingFollowups()` could never reach the leads it existed to fix.** Reported: the button's own copy said 166 leads needed 332 drafts, then clicking it produced "0 generated, 200 already existed" ,every time, no matter how many times pressed. Cause: the candidate query fetched only the OLDEST 100 sent leads (`order(first_email_sent asc).limit(100)`, no pagination, no exclusion of already-resolved ones) and only THEN checked which needed anything. On the live queue, all 100 oldest-sent leads already had both follow-ups ,so the query returned the exact same fully-resolved 100 on every click, forever, and could never see the 167 genuinely missing leads sitting at position 100 and beyond (confirmed by direct probe: `first genuinely-missing lead sits at position 100`). Restructured so the candidate query has no `.limit()` ,every sent, in-play lead is fetched via `lead_send_queue` (not raw `lead_pipeline`, which has no status column and would not have excluded archived leads either ,the same 0034/0035 gap, found a third time), THEN the genuinely-missing (lead, step) pairs are computed, THEN `limit` caps that real work list. `limit`'s meaning changed accordingly: drafts attempted per run, not leads considered. The message now separately reports drafts generated, ones already existing, and ones genuinely missing but deferred (by the cap or the 50s wall-clock stop) ,the old message could not distinguish "done" from "the button is structurally blind to the rest of the backlog" |
| 2026-08-12 | **"Ready to Send" dashboard card renamed Send queue, rebuilt to the scheduler's real order, question asked and answered: is the displayed order the literal send order?** It was not. The card sorted every step ,initial sends AND both follow-ups ,by one column, `approved_at`, which is stamped once when a lead's INITIAL draft is approved and never touched again; a follow-up waiting weeks could render below a brand-new initial candidate the real sender would not touch for hours. Rebuilt as a genuine mirror of `findDueWork()`: follow-up 2s due (oldest first), THEN follow-up 1s due (oldest first), THEN initial sends (verifier tier, then oldest-approved) ,concatenated in that order, not sorted by a shared key, plus a `1. 2. 3.` position number rendered on each row so the order is visible on screen rather than asserted in a description. Initial candidates are also cross-checked against the active version's OWN approval status, not just the `lead_pipeline.approved` flag ,the exact gap 0039 fixed data for; a flag that only ever ORs upward can stay stale-true after a newer, unapproved draft replaces an approved one, which is how three leads sat on this card as "next" while the real scheduler silently refused all three. `getSendQueuePreview()` never calls anything that sends ,a read-only mirror, deliberately, so a dashboard preview can never itself become a second place mail leaves from. Also picked up the 0034/0035-class archived-leak this pass revealed: neither this card's query nor the Approval Queue list's had the `.neq('lead_status', 'archived')` the count tiles got in 0034 ,both now do |
| 2026-08-12 | **A business's own bracketed name permanently blocked it, and the failure had no trace anywhere** (code only, no migration ,labelled without a number here on purpose, since 0040 is the next real migration and this fix never needed one). Reported as "sometimes it sends, sometimes it doesn't ,why didn't it send at 15:57 PKT". Traced to the exact run: `considered:1, sent:0, failed:1`. The lead was **Emirates Dermatology & Cosmetology Center [EDCC]** ,its OWN real name carries a bracketed tag, and `findUnresolvedPlaceholders()`'s `[Title Case]` rule (fitted to catch `[Business Owner]`) cannot tell that apart from a genuine unfilled placeholder. `sendLeadEmail()` refused it, unconditionally, on every single cron tick ,three leads total (`[UNEC] United Engineering...`, `Shiny Smile...[Pasang Behel dan Implan Gigi]`, and this one), forever, since the data itself can never satisfy the guard. Explains the "sometimes" perfectly: the same stuck lead fails on EVERY run, and whether a run also shows a successful send just depends on whether anything else happened to be due at that tick. **Fixed with context**: `findUnresolvedPlaceholders()` takes an optional list of the lead's own real field values (business_name, niche, city, country) and excludes a bracket match whose content is a substring of one of them ,a real `[Business Owner]` still blocks against unrelated data (verified). Threaded through all four places that call it so none can disagree with the send path: `sendLeadEmail()` (the gate itself), `inspectDraft()`/`repairDraft()` in `quality.ts` (now takes an optional `context: DraftContext`), the sweep (already had the exact context built as `contextById`), and the lead-page review UI (`DraftWorkspace` → `DraftEditor` → `useBlockingIssues`/`DraftIssues`, threaded from `page.tsx` ,previously would have shown a blocking warning for a draft that actually sends fine). **The bigger fix is the second half**: the scheduler computes an exact reason for every failure (`summary.notes`, e.g. `${leadId}: ${result.message}`) and had ALWAYS computed it ,but the cron route (the only caller running unattended) passed `summary.message` straight to `finishRun()` without it, so the reason was discarded the moment the function returned. `integration_runs` recorded nothing but a bare `failed:1` next to a run id, forever, for a fully-diagnosable failure. Fixed in `runOutreachCycle()` itself (not each caller): the first failure's reason is now folded into `summary.message`, and the full `notes` array is persisted into `stats` by both the cron route and the settings action. Needs zero new UI ,`TriggerButton` already renders `lastRun.message` in red for a failed run, so Settings → Automation now just says why, next time, without opening the database |
| 2026-08-12 | **Leads table: two approvals, and inline address editing.** The bulk bar's single "Approve" was ambiguous ,it approved the active initial DRAFT, but read as though it also blessed the address, which is how copy gets signed off for an address nobody checked. Split into **Approve drafts** (a judgement about the WORDS) and **Mark verified** (a verdict about the ADDRESS), each with a title saying exactly what it writes; a lead needs both before it can send. `bulkMarkEmailVerified()` records source `manual` so `email_verifier_status` survives (0028) and send priority can still tell a proved address from a hand-confirmed one, and it skips leads with no address or an `invalid` verdict ,a hard bounce is evidence, a tick box is not. **Edit addresses** turns the Email column into an input for the SELECTED rows: sourcing addresses is a batch job, and routing twenty of them through the lead page is the difference between doing it and not. Saving writes each address and puts it back to `unverified` explicitly rather than leaning on 0028's trigger, so the result is the same whether or not 0038 has run. One lead per statement, because `dedupe_key` is UNIQUE and recomputed from the address by trigger ,a typo that collides must fail that one row and name it, not abort thirty. The selection deliberately survives a save so Mark verified can run on the same rows; only Clear drops it. **The `columns` useMemo had `[]` deps** ,fine while every cell was a pure function of its row, fatal once one renders an input from state, so it now depends on the editing state and `saveEmails` is a `useCallback`. Verified end to end in a real browser with a temp admin: save → `unverified`, selection kept, Mark verified → `valid`/`manual` |
| 2026-08-12 | **0039 ,saving the lead form silently demoted approved drafts.** Reported as "I changed the email status and it made another version". Verification had nothing to do with it; the timestamps showed the new version appearing 9–23 seconds BEFORE each "Address marked verified". The real chain: the Business-information form carried the whole draft body in a **hidden input**, so it was re-submitted on every save of that card ,and **HTML form submission normalises line breaks to CRLF**, so the value came back with every LF turned into a CRLF. `updateLead()` wrote it to `leads.draft_email`; `version_lead_draft()` (0015, built for the sheet era) compared byte-for-byte, saw a difference, inserted a new version with `active = true`; `enforce_single_active_version()` then deactivated the approved one. Proof: the replacement was identical to the approved text apart from line endings on **all four** affected leads, with length deltas exactly equal to the newline count (+13, +15, +17). Fixed in three places ,the hidden inputs are gone and `subject_line`/`draft_email` are removed from `leadUpdateSchema` (that action must never write the draft; `email_versions` owns it); the trigger now compares with line endings normalised; and **a new auto-captured version no longer takes `active` from an approved one**, because the approved version is the text a human signed off and the text the sender actually sends. Explicit actions (Regenerate, Save draft, activating from history) still activate what they create ,there a human asked. The 4 leads were repaired directly |
| 2026-08-10 | **0038 ,0028's verdict reset had quietly stopped working for new verdicts.** Asked to confirm that changing an address resets verification to "never checked", the answer is **yes** ,tested live across five branches on a throwaway lead: a verifier verdict, a manual tick and clearing the address all reset to `unverified` with source, verifier status and timestamps cleared, while re-writing the SAME address in different case or whitespace correctly does not. **But the reset is guarded on `email_checked_address is not null`, and nothing ever set that column** except 0028's own one-time backfill. `setVerificationStatus()`, the delivered-proves-valid trigger in 0017, the bounce path and the verifier CSV import all omit it, so every verdict recorded after 0028 landed with it NULL and that lead became permanently immune ,correct a typo and the old verdict follows the new address, which is the exact bug 0028 exists to prevent. **125 of 522 non-unverified leads live, and growing.** Fixed centrally in `set_pipeline_stage()`, the BEFORE trigger every `lead_pipeline` write already passes through, rather than in the four callers plus whoever adds the fifth ,same argument as putting the send gates in `sendLeadEmail()`. 'unverified' clears the column instead of stamping it, which is what keeps it agreeable with the reset trigger writing both in one statement. Existing gap backfilled |
| 2026-08-10 | **Mobile, round three ,measured this time, not reasoned about.** The previous two rounds fixed real bugs but missed the ones actually on screen, so this pass drove a headless Chrome at 386×800 against every page with a temp admin session and asserted `document.scrollWidth === window.innerWidth`, listing any element wider than the viewport. Four more causes, all of them the same family: **(1) `CollapsibleSection`'s badge** was `shrink-0` beside a `min-w-0 flex-1` title, and every Badge is `whitespace-nowrap` ,so a badge reading "From: send@team-automationsolutions.me" (a string this codebase introduced when the sheet name was replaced in 0033) kept its full ~250px and left the title ~30px, rendering "Integrations" as `Int/eg/rat/io/ns` down the card. **`flex-wrap` does not fix this**: with `min-w-0` the browser can always satisfy the row by shrinking the title to nothing instead of wrapping the badge, so the two must be told to STACK below `sm`. **(2) The draft tablist** was a plain `flex` totalling ~400px once each tab carried its version chip and sent icon; it overflowed the card and the shell clips rather than scrolls, so "Follow-up 2" was unreachable ,now `overflow-x-auto` with `shrink-0` tabs. **(3) `Card` now carries `min-w-0` itself.** A dashboard activity card measured **948px** on a 386px screen: `truncate` sets `white-space: nowrap`, whose MIN-CONTENT width is the entire string, and a grid child defaults to `min-width: auto` ,so the text never truncated, it just widened the card. Setting it on the component means the next card dropped into a layout cannot reintroduce it. **(4) `sr-only` on a `<table>` does nothing** ,it hides by setting `width: 1px`, and a table refuses to shrink below min-content, so the chart accessibility fallbacks were ~400px absolutely-positioned elements giving /analytics and the public page a horizontal scrollbar with nothing visible in it. The class belongs on a wrapping `<div>`. Final measurement: all eight pages report `doc = win = 386`, no element exceeding the viewport outside a deliberate `overflow-x-auto` scroller |
| 2026-08-10 | **0037 ,an exhausted sequence closes itself.** A lead that got follow-up 2 and never answered has nothing left to do (`compute_next_step()` already returns `close_workflow`), but nothing ever performed the close, so they piled up at stage `followup2_sent` inside every figure describing live prospects ,56 in the first two days of sending. `closeExhaustedSequences()` runs inside `runOutreachCycle()` rather than in a new cron route: it is one UPDATE that normally touches zero rows, so the existing 3-minute tick carries it for free and there is no third endpoint or cron-job.org schedule to register. Two predicates are load-bearing: **`replied is null` lives in the WHERE clause**, not in a prior SELECT, because a reply landing between a read and a write is the one outcome here that costs a conversation; and **`auto_followups` is required**, because Pause means "try me next quarter" and a timer must never let it decay into a Close. Placed ABOVE the working-hours and daily-limit guards (closing sends nothing, so neither has any bearing on it) but BELOW `sending.paused`, which is documented as a global kill switch. Skipped on a dry run. Threshold is `outreach.close_after_followup2_days`, default 14, 0 to disable. Verified against live data: 0 would close at 14 days, exactly the known 56 at 2 days, and the replied / paused / already-closed rows are all spared |
| 2026-08-10 | **Mobile, round two ,three separate causes, all the same underlying rule.** (1) **Lead detail was unusable on a phone**: the two grid columns had no `min-w-0`, and a grid child defaults to `min-width: auto` ,it refuses to shrink below its widest unbreakable content. One long draft body widened the column, which widened the grid past the viewport, and because `main` clips with `overflow-x-hidden` rather than scrolling, the right edge of every card was cut off. The Save/Cancel row sits at `justify-end`, so the button you most need was the first thing to vanish. This is the identical trap already documented on the shell's own container ,every nested grid re-introduces it. (2) **`CardHeader` now wraps by default**: a header is a title plus controls, and on a narrow screen that pair must become two rows rather than one row wider than the card. (3) **`SecretField`'s label and the settings save bar's paragraph were being crushed by `whitespace-nowrap` siblings** ,every `Badge` and `Button` carries it, so in a non-wrapping `justify-between` row they held full width and the text beside them took all the squeeze, rendering two or three letters per line. `flex-wrap` + `min-w-0` on the text side fixes both |
| 2026-08-10 | **Mobile.** Three real causes, not a styling pass. (1) **Tables were crushed, not scrollable** ,`table-fixed` + `w-full` makes per-column widths a RATIO once they stop fitting, so ten columns declared at 130–240px rendered ~30px each on a phone and every cell became an ellipsis. `TableWrap` always had `overflow-x-auto`; what was missing was a floor to scroll against, so `DataTable` now sets `minWidth` from the sum of its column widths. `overscroll-x-contain` added too, so swiping past the end of a table no longer triggers the browser's back gesture. (2) **`MetricCard` truncated its own label** ,a two-column grid on a 360px screen leaves ~150px, which cut "Initial Approval Queue" to "Initial Appr…"; labels now wrap below `sm` and truncate from `sm` up, and the value steps down to `text-xl`. (3) **Email logs got a real mobile layout** ,seven columns cannot be squeezed into a phone, and horizontal scrolling makes you drag sideways to answer "did this bounce?", which is the whole point of the page. Below `md` each attempt is a card; the table returns at `md`. Both render the same `rows` ,one query, one definition. The two analytics tables got a `min-w-[380px]` scroll floor for the same reason as (1) |
| 2026-08-10 | **0036 ,the public page counts businesses reached, not messages sent.** `emails_sent` counts `email_logs` rows, so ten businesses in a full three-step sequence published as "25 emails sent" ,our activity, not our reach ,and `reply_rate_pct` inherited the same denominator, so it FELL every time a follow-up went out even though the conversations were unchanged. Adds `leads_contacted` (distinct non-archived leads with `first_email_sent`) and re-bases reply rate on it. Counted from `lead_pipeline`, NOT from `email_logs where email_type = 'initial'`: it is one row per lead so it is distinct by construction, and sheet-era upstream sends have no `email_logs` row at all (0015/0018 write `first_email_sent` directly), so counting logs would drop every lead emailed before this CRM recorded sends. `emails_sent` / `emails_attempted` / `emails_bounced` deliberately stay MESSAGE counts ,bounce rate is a per-message property of the sending domain and would be wrong per business. The daily activity chart also stays per-message |
| 2026-08-10 | **0035 ,the scheduled sender has not auto-sent an initial email since 0028, and reported success the whole time.** Symptom: the cron fires every 3 minutes, writes a green `integration_runs` row saying "Nothing is due, considered: 0", while 20 leads sit approved, verified and unsent. Cause: 0028 moved the initial-send query from the `lead_pipeline` table to the `pipeline_board` view because the new `send_priority` is computed there ,but `pipeline_board`'s body ends `where public.is_admin()`, and the scheduler runs on the SERVICE-ROLE key. **Service-role bypasses RLS on a TABLE; it satisfies no predicate written into a VIEW body**, which is an ordinary WHERE clause, not a policy. Verified live: `pipeline_board` returns 0 rows to the service-role client, `lead_pipeline` returns all 809. The failure was invisible because "0 due" and "0 visible" produce the identical run record. Fix: `lead_send_queue`, a machine-facing view with no `is_admin()` gate, protected by GRANTS instead (revoked from anon/authenticated, granted to service_role) ,the same shape as `integration_secrets`, which is protected by having no grants rather than by a policy. It also excludes archived leads, so the extra round trip `findDueWork()` was making for follow-ups is gone. `pipeline_board` is untouched: it feeds the admin UI where `is_admin()` is doing real work. **The trap was already documented** ,the deleted `lib/services/sync/index.ts` carried a comment about exactly this ("the service-role client is not an admin JWT so this is null in practice") while the scheduler made the same mistake three files away |
| 2026-08-10 | **0034 ,an archived lead is counted nowhere.** Reported as Dead Addresses reading 12 against a list of 11. Both queries were right about themselves: the list resolves ids through `lead_pipeline` and then queries `leads`, which excludes archived by default, while every COUNT queried `lead_pipeline` directly ,and **`lead_pipeline` has no status column**, so it structurally cannot express the filter. The same bug class as GUIDE §2's "a tile must link to exactly the rows it counted", through a different door. Fixed in both places: `public_stats_overview`, `public_stats_stages`, `public_stats_leads` and `analytics_stage_distribution` now join `leads` and exclude archived, and every count in `lib/data/admin-dashboard.ts` routes through `activePipelineCount()` / `activePipelineLeadIds()`, which read `pipeline_board` (same rows plus `lead_status`) ,**never reach for `lead_pipeline` directly in that file again**. `public_stats_leads` was also a disclosure fix: with `public.show_leads` on, an archived duplicate could be published by name on the front page. `email_logs` / `replies` figures deliberately still include archived leads, because a message that left the building stays sent. `pipeline_board` itself is unchanged ,the leads list needs to show archived rows when the toggle is on |
| 2026-08-10 | Draft sweep schedule changed to **every 4 hours** (`0 */4 * * *`, six runs a day) from the explicit `0 0,7,14,21 * * *` four-times-a-day list. Safe because 4 divides 24; see the note under the scheduled jobs table for why 7 could not be written that way |
| 2026-08-10 | **n8n output verified good after the prompt fix.** 52 active n8n leads (20 Plumbing, 17 HVAC, 15 Solar); 45 of 52 active drafts pass every check, naming the right business, niche and city with real detail pulled from the site. Remaining 7: three never name the business (generic but not wrong), two run 236–244 words against the prompt's 120–180 target, one still carries a bracket placeholder and will be left by the sweep, and one (`Solar Liberty`) still claims the business has no website when it has one ,the `_websiteFetchStatus` branch bug, an n8n-side fix |
| 2026-08-10 | **The n8n prompt fix verified, and the sweep's semantic blind spot bit for real.** After correcting Workflow 2's expressions (they were still using the Sheets column names with their leading spaces ,`$json[' Niche']` ,against a Supabase row, so every field resolved empty; and the prompt's own example block hardcoded "the travel industry"), output is clean from **08:27:54** onward. `J. Marin Heating` is the A/B: v2 at 08:20 opens "Congratulations on operating in the travel industry", v3 at 08:27:54 reads correctly. **But the draft sweep then ran at ~09:00 and approved three of the pre-fix travel drafts** ,it repaired them structurally (quotes, braces), found zero blocking issues, and signed them off, exactly as section 8 warns: `inspectDraft()` cannot see meaning. A second prompt bug surfaced too ,6 drafts told businesses with live websites that they had none, because the "If NO website exists" branch fires on an empty `_websiteFetchStatus` rather than an absent URL (only 2 of the 6 had actually failed to fetch). Remediation: `outreach.auto_send_initial` set to **false** (10 leads were passing every send gate with the cron 3 minutes away and nothing sent yet), 20 versions across 10 leads rejected, their research and `subject_line`/`draft_email` cleared, and `research_complete`/`draft_ready`/`approved` explicitly turned off. 0 bad active drafts remain; 25 n8n leads sit in Workflow 2's queue for a clean redo |
| 2026-08-10 | **The Google Sheet is retired.** n8n now writes `leads` and `email_versions` straight into Supabase, so the sheet is neither the ingestion layer nor a mirror. Deleted outright: `google-sheets.ts`, `sheet-writer.ts`, `sheet-sync.ts`, the entire `lib/services/sync/` dispatcher, `/api/cron/sheet-sync`, the Sync Data button on the leads toolbar, the Google Sheets settings card and both `runGoogleSheetSync` / `testGoogleSheetsConnection` actions. **The sync layer went with it, not just its target** ,`syncLeadChange()` had exactly one `SyncTarget`, so with the sheet gone every one of its ~20 call sites was spending four queries to resolve a snapshot for nobody, and `appendSyncMessage()` could only ever return its input unchanged. **0033** removes the six `sheets.*` settings rows and both stored Google credentials; `leads.sheet_row_number` / `sheet_synced_at` are deliberately KEPT as provenance for the 762 leads that arrived that way and because `leads:duplicates` still groups by row number. Remember to delete the sheet-sync schedule in cron-job.org and revoke the service-account key at the Google end |
| 2026-08-10 | **n8n's first 39 drafts are structurally perfect and semantically wrong.** Verified by running the real `repairDraft()` / `inspectDraft()` over every live `generated_by = 'n8n:ollama'` version: all 39 repair cleanly and **would be auto-approved by the next sweep**. But 36 of 39 pitch *travel industry* services to New Orleans plumbers and HVAC companies, 26 leak literal schema words into the prose (`Niche`, `City, Country`, `Business Name` used as if they were values), and 27 never name the actual business. Zero were correct. The lesson worth keeping: **`inspectDraft()` is a STRUCTURAL check only** ,placeholders, braces, fences, quotes, missing subject. A fluent, well-formed email selling the wrong thing to the wrong person passes every gate the sweep has. The prompt in n8n's Workflow 2 is not receiving the lead's own `niche`/`city`/`country`/`business_name`; that is an n8n-side fix, and nothing in this codebase can detect it. **All 39 were set to `status = 'rejected'`** with the reason in `review_note`, which takes them out of the sweep queue permanently (rejected is not `draft`) while keeping them readable in version history; 0 leads were left flagged `approved`. A corrected rerun inserts fresh versions that supersede them normally. **The cause was NOT the 20-per-trigger batching** (that was the first hypothesis, and the timestamps do show bursts ~12s apart): zero n8n leads are travel businesses, so nothing could bleed from a sibling item. The contamination is one layer upstream, in `research_summary` itself ,`"Travel Agency, operating in the travel industry"` written for an HVAC company, `"serving [City], [Country]"` with the literal brackets intact, `"in the city of, country"` where the expressions resolved to empty strings. Workflow 2's prompt was written with literal placeholder words instead of `{{ }}` expressions, over leftover travel-agency wording; the email node then faithfully repeated the poisoned research. All 37 n8n leads had their research fields and `researched_at` cleared so the fixed workflow re-picks them up, and `research_complete` / `draft_ready` were explicitly turned OFF ,the triggers never turn a gate off by design, so a blanked field would otherwise have left 10 leads sitting in the Approval Queue claiming research they no longer had |
| 2026-08-10 | **0032 ,`social_links` normalizes to an object too.** Same trigger as 0031, same day, second failure from the same source: n8n's "Update a row" node (Workflow 2, writing research back onto `leads`) sent `social_links` a JSON *string* ,the literal text `"{}"`, or the raw "Social Links" prose un-parsed ,which is valid jsonb but not an object, tripping `leads_social_links_is_object`. `normalize_blank_lead_fields()` now also handles this: a string that parses as a JSON object is unwrapped and used, a string that does not (real prose) survives under `_raw` ,mirroring `normalizeSocialLinks()` in `lib/import/normalize.ts` exactly ,and anything with no sensible object reading (blank, an array, a bare JSON null) becomes `{}`. Redefines the SAME function 0031 created rather than a second trigger, so paste order matters: 0031 then 0032 |
| 2026-08-10 | **0031 ,blank fields from a direct writer stopped tripping the format checks.** n8n's very first live insert (Workflow 1, a lead with no email) failed with `leads_email_format` violated: n8n sends `""` for "no value", and the CHECK constraint only exempts `NULL`. `normalize_blank_lead_fields()`, a BEFORE INSERT OR UPDATE trigger, turns blank/whitespace-only email, website, phone, city, country and niche into NULL before the CHECK constraints (and dedupe-key computation) ever see them ,the same one-rule-enforced-once fix as 0029, rather than asking every n8n expression to remember `\|\| null`. `business_name` is deliberately left alone; a blank one should fail loudly. 0029 and 0030 (previous entry) confirmed pasted and live the same day |
| 2026-08-10 | **Groundwork for n8n writing directly to Supabase, plus the draft sweep stops re-checking itself forever.** Two new migrations, both pending (§2 has the paste instructions): **0029** adds `assign_dedupe_key_on_insert()`, a BEFORE INSERT trigger that computes `leads.dedupe_key` in Postgres whenever a caller leaves it blank ,needed because a direct writer (n8n) has no reason to replicate `buildDedupeKey()` correctly, and getting it wrong silently reproduces the 0028 duplicate-key bug with no `sheet_row_number` to ever catch it. **0030** adds `email_versions.sweep_checked_at`, set by `runDraftSweep()` the moment a draft is examined and still has a blocking issue afterwards; the sweep's query now excludes anything already flagged, so the same permanently-stuck ~10 drafts stop being re-parsed and re-reported as newly blocked four times a day. No manual reset needed ,any new version (an edit, or a repair) starts NULL again. Also discovered and corrected while doing this: the migration status table had 0026–0028 marked NOT YET despite being live on the database since before 2026-08-09 (confirmed by direct probe) ,a stale row that outlived whoever actually pasted them in |
| 2026-08-09 | **Archiving never stopped the sender ,fixed.** `archiveLead()` only ever set `leads.status`, on the stated theory that archiving is "a visibility choice" and the pipeline row should stay untouched. But `findDueWork()` reads `lead_pipeline` (and `pipeline_board` for initial sends) directly and never checked `leads.status`, so an archived lead with a live `followup1_due`/`followup2_due` ,exactly what `leads:duplicates --merge` leaves on every loser ,was still picked up by the `*/3 * * * *` cron and mailed on schedule, usually to the SAME address as the surviving lead. Confirmed live: 6 of the 8 leads archived by today's merge were still armed, one (`Lanka Safe Tours`) sitting due since 2026-08-06. Fixed in the one place every send path goes through: `sendLeadEmail()` now refuses an archived lead outright, and `findDueWork()`'s three candidate queries (followup1, followup2, initial) all exclude `status = 'archived'` too, so the cron's `considered`/`skipped` counts stay honest instead of quietly retrying forever. The 8 already-archived leads had their `lead_pipeline` row closed directly (`closed` set, `auto_followups = false`) so the fix doesn't wait on a deploy. **Archiving a lead now actually stops it being contacted ,not just hides it from the list.** |
| 2026-08-09 | **Audit: DB vs the live Google Sheet, then `leads:duplicates -- --merge`.** Confirmed the count the user was seeing (724 active + 2 archived = 726 leads, sheet at 723 rows) was fully explained by two known, already-documented effects ,nothing new was broken. (1) The eight 0028 leak pairs (see 2026-08-06 below) were never fully cleaned up: two (rows 672 `Lanka Safe Tours`, 674 `Vacation Sri Lanka`) were already archived one-sided; the other six (rows 121 `Modern Mart`, 371 `YourColombia`, 666 `Olanka Travels`, 679 `Three Travels`, 686 `Ali & Sons Contracting`, 723 `Apatchi Cars`) were still two live, active leads apiece, several emailed twice. Every pair matched on email + city + country + niche, i.e. all four fields, not just email. (2) Five sheet rows (3, 216, 286, 472, 662) have no lead of their own ,not deletions, but the documented same-email-collapses-two-businesses-into-one-lead behavior (§10), verified by confirming each row's email resolves to a DB lead under a *different* business name at a *different* row. 718 distinct sheet rows were represented + 5 collapsed elsewhere = all 723 sheet rows accounted for; zero sheet rows pointed at nothing. Ran `npm run leads:duplicates -- --merge`, which archived the 6 remaining duplicate losers (evidence moved onto the richer/keep side first). **Active leads now 718, archived 8, total 726** ,718 matches the sheet's 723 populated rows minus the 5 by-design collapses exactly |
| 2026-08-06 | `PAGE_SIZES` moved to `lib/pagination.ts`. It lived in the `'use client'` pagination component, so importing it into the email-log server page produced a client reference rather than an array and threw at request time ,a class of bug `next build` cannot see on a dynamic page. Four copies of the list collapsed into one, with shared `parsePageSize` / `parsePageNumber` helpers |
| 2026-08-06 | **0028 ,the duplicate-lead leak.** Editing an email left `dedupe_key` holding the old address, so the next sheet sync inserted a second lead for the same row: eight sheet rows in the live data are claimed by two leads each, several emailed twice. The key is now recomputed in a trigger, and `leads:duplicates` groups by sheet row so the pairs are findable. Same root cause fixed for verdicts: `email_checked_address` means a verification result resets when the address changes, which is what makes "a verifier said invalid → never send" enforceable without an override. Adds `email_verifier_status` and send priority 1/2/3, ordering initial sends verifier-proved first. Write-back now sends only the columns whose field group changed, instead of re-stamping every mapped cell and blanking ones filled in by hand upstream. Archived became an only-archived filter |
| 2026-08-06 | Leads table shows a Google **Look up** link where the Website cell would be empty, scoped to the business plus its city and country. 112 of 723 leads, 86 of which have an email that may still need checking by hand |
| 2026-08-06 | The Email address verdict on the lead page stages behind a Save button instead of writing on change, matching Business information. Marking an address Dead removes the lead from every queue, so a stray scroll should not do it |
| 2026-08-06 | Email log gets pagination. The page read `?page=` but rendered no control, so it was stuck on the newest 50 of 87 rows and appeared to hold only today |
| 2026-08-06 | Sending days become a real setting. `updateSettings()` hardcoded `days: [1,2,3,4,5]`, so they could not be changed and every Save reverted them; now a seven-day control with a presence marker. Live window set to every day |
| 2026-08-06 | **Six fixes.** The cleaner now strips MATCHED wrapping quotes and fills bracket placeholders from the lead's own fields, taking the pending queue from **0 clean to 82 of 92**; the 10 left have no answer in the database and stay blocked on purpose. `leads.status` reverted to the ten DB enum values, which is what broke the last deploy ,"Initial Approved" is a LABEL and now lives only in STAGE_META/GATE_LABELS, with the draft chip saying plain "Approved" because a lead has three drafts. Email logs swap the constant Provider column for which step was sent. `min-w-0` on the shell plus `overflow-x: clip` stops every page dragging sideways on a phone. Pause vs Close spelled out on the lead page |
| 2026-08-05 | **Scheduled jobs + layout.** `/api/cron/sheet-sync` (23:59 Asia/Karachi) and `/api/cron/approve-drafts` (00:00, 07:00, 14:00, 21:00) added, sharing `guardCronRequest()` with the outreach route. The draft sweep moved to `lib/services/drafts/sweep.ts` so the button and the schedule run one function. Settings now lists all three jobs with their cron lines. /analytics rebalanced into four even rows, the last rendering `analytics_generation_daily` ,queried since 0014, never displayed until now. The public page pipeline row is 3×3 with a new Dead Address card, without which the `dead_email` split would have dropped 19 leads off it silently |
| 2026-08-05 | **0026 + 0027** (must be pasted in that order ,Postgres will not use a new enum value in the transaction that added it). `dead_email` becomes its own stage, so the stage filter stops reading 326 where the tiles read 307 and 19. New `lead_stage_counts` view makes the filter facets honour the archived toggle, fixing a chip that said `initial_sent 94` against a page of 93. The lead detail page stops rendering `leads.status` ,the "Researching" badge and the editable Status dropdown are gone, replaced by the derived stage ,and `StatusBadge` / `LEAD_STATUS_LABELS` / `STATUS_CHART_COLORS` are deleted, so nothing renders lead status anywhere. `dashboard_lead_status_counts`, `public_stats_statuses` and `dashboard_leads_safe` dropped |
| 2026-08-05 | **Chunks 2 and 3.** **0025**: the stage becomes the FIRST UNMET GATE, so it names what is blocking a lead instead of the last thing that got done ,497 leads move backwards into need_email / need_verification, keeping their drafts and approvals. Every dashboard tile and named view is now a `current_stage` query, which is what makes a count and the page it opens the same query by construction. "Emails Waiting Review" removed (it was the Approval Queue plus follow-up drafts); "Checked, Inconclusive" added for the 173 addresses a verifier answered on and could not prove. Campaigns and templates deleted outright, along with ten unread views, `leads.category`, `leads.next_followup_at` and three orphan settings rows. The lead page gets a five-state verification dropdown; the leads list swaps Status for Stage with Archived as a toggle; approval writes the version and nothing else |
| 2026-08-05 | **Audit + chunk 1.** Read-only probe of the live database found twelve problems (section 12). Fixed: Ready to Send now requires all four gates (103 → 7, of which 96 could never have been sent ,62 had no address, 4 were proven dead); the verification gate moved into `sendLeadEmail()` so the Send button and the API are covered and not just the cron; `saveResearch()` stopped nulling `researched_at`; overdue follow-ups measured from the start of today so they no longer double-count against due-today. `auto_send_initial` paused |
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
