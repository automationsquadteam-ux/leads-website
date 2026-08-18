/*
 * Deliberately NOT marked `server-only`.
 *
 * scripts/verify-emails.ts imports this under plain Node, where the
 * `server-only` package's default export throws on load. It depends solely on
 * `service-client.ts`, which is marker-free for exactly this reason (see the
 * note at the top of that file). Nothing here reaches for a request context, so
 * there is no client bundle to protect and the service-role key it uses is
 * guarded by `getServiceRoleKey()`, which throws if it is ever read in a
 * browser.
 */
import { createServiceClient } from '@/lib/supabase/service-client';
import { EMAIL_PATTERN } from '@/lib/import/normalize';
import type { EmailVerificationStatus } from '@/lib/supabase/database.types';

/**
 * Email verification results, in and out.
 *
 * The workflow this supports is deliberately manual and free of a paid API:
 *
 *   1. export the addresses nobody has checked          -> CSV
 *   2. upload that CSV to NeverBounce (or ZeroBounce, Bouncer, ...)
 *   3. download their result CSV
 *   4. import it here                                   -> statuses applied
 *
 * No verifier credentials live in this codebase, which also means no bill and
 * nothing to leak. The cost is one round trip through a browser.
 *
 * What each result does to the lead:
 *
 *   valid       email_verified = true. Eligible for the scheduled sender.
 *   invalid     email_verified = false AND the stage falls back to need_email,
 *               so it appears in "Leads Missing Email" and someone sources a
 *               new address. leads.email is kept knowing what was tried and
 *               failed is worth more than the row being tidy.
 *   accept_all  recorded, NOT auto-verified. A catch-all domain accepts
 *               everything, so the check proved nothing; a human decides.
 *   unknown     same treatment as accept_all.
 */

/** Column headers various verifiers use for the address. First match wins. */
const EMAIL_HEADERS = ['email', 'email address', 'email_address', 'address', 'e-mail'];

/** Column headers for the verdict. */
const STATUS_HEADERS = [
  'email_status',
  'status',
  'result',
  'verification_status',
  'neverbounce_result',
  'nb_result',
];

/**
 * Verifier verdicts -> our enum.
 *
 * Deliberately generous: NeverBounce says `catchall`, ZeroBounce says
 * `catch-all`, Bouncer says `accept_all`. Normalising here means the import
 * accepts whichever tool the operator happened to use.
 */
const STATUS_MAP: Record<string, EmailVerificationStatus> = {
  valid: 'valid',
  deliverable: 'valid',
  ok: 'valid',

  invalid: 'invalid',
  undeliverable: 'invalid',
  bad: 'invalid',
  disposable: 'invalid',
  spamtrap: 'invalid',
  abuse: 'invalid',

  accept_all: 'accept_all',
  'accept-all': 'accept_all',
  accept_all_unverifiable: 'accept_all',
  catchall: 'accept_all',
  'catch-all': 'accept_all',
  catch_all: 'accept_all',

  unknown: 'unknown',
  risky: 'unknown',
  'do_not_mail': 'unknown',
  unverifiable: 'unknown',
};

export function normaliseVerificationStatus(raw: string): EmailVerificationStatus | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return STATUS_MAP[key] ?? null;
}

/* -------------------------------------------------------------------------- */
/* CSV parsed and generated here rather than pulling in a dependency          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal RFC-4180 reader: quoted fields, embedded commas, doubled quotes and
 * both line endings. Verifier exports are machine-generated and well-formed;
 * this is not trying to be a general CSV library.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const source = text.replace(/^﻿/, ''); // strip a BOM from Excel exports

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const escape = (value: string | number | null): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n');
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

export interface UnverifiedRow {
  email: string;
  business_name: string;
  city: string | null;
  country: string | null;
}

/**
 * Addresses to send to a verifier.
 *
 * **Never-checked only, by default.** The first version also exported
 * `unknown` and `accept_all` on the theory that a re-run might resolve them.
 * In practice that re-bills every one of those addresses on every export, and
 * a catch-all domain returns catch-all every single time — you pay again for
 * an answer that cannot change.
 *
 * `includeInconclusive` re-checks them deliberately, which is worth doing
 * occasionally (a domain that was misconfigured may since have been fixed) but
 * should be a decision, not a default.
 *
 * Leads with no address are excluded here, which is the whole point of the
 * export. Note that they also count as `unverified` in the tallies, so the
 * count on a status tile is NOT the number of rows this returns — see
 * getVerificationCounts(), which separates the two.
 */
export async function getUnverifiedEmails(
  options: { includeInconclusive?: boolean } = {},
): Promise<UnverifiedRow[]> {
  const admin = createServiceClient();
  const out: UnverifiedRow[] = [];
  const pageSize = 1000;

  const statuses: EmailVerificationStatus[] = options.includeInconclusive
    ? ['unverified', 'unknown', 'accept_all']
    : ['unverified'];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from('lead_pipeline')
      .select('lead_id, email_verification_status')
      .in('email_verification_status', statuses)
      // Cannot verify an address we do not have. Filtering here as well as on
      // the lead keeps the paging honest.
      .eq('email_found', true)
      .is('closed', null)
      .order('lead_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    const batch = data ?? [];
    if (batch.length === 0) break;

    const { data: leads } = await admin
      .from('leads')
      .select('id, email, business_name, city, country, status')
      .in('id', batch.map((r) => r.lead_id))
      .not('email', 'is', null);

    for (const lead of leads ?? []) {
      if (!lead.email) continue;
      if (lead.status === 'archived' || lead.status === 'invalid') continue;
      out.push({
        email: lead.email,
        business_name: lead.business_name,
        city: lead.city,
        country: lead.country,
      });
    }

    if (batch.length < pageSize) break;
  }

  // A verifier charges per address, not per lead. Two leads sharing an address
  // is a documented reality of this dataset, so de-duplicate before export.
  const seen = new Set<string>();
  return out.filter((row) => {
    const key = row.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function buildUnverifiedCsv(
  options: { includeInconclusive?: boolean } = {},
): Promise<{ csv: string; count: number }> {
  const rows = await getUnverifiedEmails(options);
  return {
    // `email` first and named exactly that: every verifier auto-detects it.
    csv: toCsv(
      ['email', 'business_name', 'city', 'country'],
      rows.map((r) => [r.email, r.business_name, r.city, r.country]),
    ),
    count: rows.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

export interface VerificationImportSummary {
  ok: boolean;
  message: string;
  totalRows: number;
  matched: number;
  unmatched: number;
  applied: Record<EmailVerificationStatus, number>;
  unrecognisedStatuses: string[];
  /** Leads pushed back to need_email because the address is dead. */
  needNewEmail: number;
}

function emptyTally(): Record<EmailVerificationStatus, number> {
  return { unverified: 0, valid: 0, invalid: 0, accept_all: 0, unknown: 0 };
}

/**
 * Apply a verifier's result CSV.
 *
 * Matches on the address, not on a row id, so the file can come back from any
 * tool in any order with any extra columns.
 */
export async function importVerificationCsv(
  text: string,
  source = 'neverbounce',
): Promise<VerificationImportSummary> {
  const summary: VerificationImportSummary = {
    ok: false,
    message: '',
    totalRows: 0,
    matched: 0,
    unmatched: 0,
    applied: emptyTally(),
    unrecognisedStatuses: [],
    needNewEmail: 0,
  };

  const rows = parseCsv(text);
  if (rows.length < 2) {
    summary.message = 'That file has no data rows.';
    return summary;
  }

  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const emailIndex = EMAIL_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;
  const statusIndex = STATUS_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;

  if (emailIndex < 0) {
    summary.message = `No email column found. Expected one of: ${EMAIL_HEADERS.join(', ')}.`;
    return summary;
  }
  if (statusIndex < 0) {
    summary.message = `No result column found. Expected one of: ${STATUS_HEADERS.join(', ')}.`;
    return summary;
  }

  // address -> verdict. A later row for the same address wins, which matches
  // how a re-verified export is usually ordered.
  const verdicts = new Map<string, EmailVerificationStatus>();
  const unrecognised = new Set<string>();

  for (const row of rows.slice(1)) {
    const email = (row[emailIndex] ?? '').trim().toLowerCase();
    const rawStatus = (row[statusIndex] ?? '').trim();
    if (email === '') continue;

    summary.totalRows += 1;
    const status = normaliseVerificationStatus(rawStatus);
    if (!status) {
      if (rawStatus !== '') unrecognised.add(rawStatus);
      continue;
    }
    verdicts.set(email, status);
  }

  summary.unrecognisedStatuses = [...unrecognised];

  if (verdicts.size === 0) {
    summary.message = 'No rows carried a result we recognise.';
    return summary;
  }

  const admin = createServiceClient();
  const checkedAt = new Date().toISOString();
  const emails = [...verdicts.keys()];

  // Resolve addresses to leads in chunks a single .in() with hundreds of
  // values builds a URL PostgREST rejects.
  const leadsByEmail = new Map<string, string[]>();
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data, error } = await admin.from('leads').select('id, email').in('email', chunk);
    if (error) {
      summary.message = `Could not match addresses: ${error.message}`;
      return summary;
    }
    for (const lead of data ?? []) {
      if (!lead.email) continue;
      const key = lead.email.toLowerCase();
      leadsByEmail.set(key, [...(leadsByEmail.get(key) ?? []), lead.id]);
    }
  }

  // Group lead ids by verdict so each distinct status is one UPDATE.
  const byStatus = new Map<EmailVerificationStatus, string[]>();
  for (const [email, status] of verdicts) {
    const ids = leadsByEmail.get(email);
    if (!ids || ids.length === 0) {
      summary.unmatched += 1;
      continue;
    }
    summary.matched += ids.length;
    summary.applied[status] += ids.length;
    byStatus.set(status, [...(byStatus.get(status) ?? []), ...ids]);
  }

  for (const [status, ids] of byStatus) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await admin
        .from('lead_pipeline')
        .update({
          email_verification_status: status,
          email_verification_source: source,
          email_checked_at: checkedAt,
        })
        .in('lead_id', chunk);

      if (error) {
        summary.message = `Applied ${summary.matched} row(s), then failed: ${error.message}`;
        return summary;
      }
    }

    // An invalid address also means the lead's own status should stop
    // advertising it as workable.
    if (status === 'invalid') {
      summary.needNewEmail = ids.length;
      for (let i = 0; i < ids.length; i += 200) {
        await admin.from('leads').update({ status: 'invalid' }).in('id', ids.slice(i, i + 200));
      }
    }
  }

  summary.ok = true;
  summary.message =
    `${summary.matched} lead(s) updated: ` +
    `${summary.applied.valid} valid, ${summary.applied.invalid} invalid, ` +
    `${summary.applied.accept_all} accept-all, ${summary.applied.unknown} unknown. ` +
    (summary.unmatched > 0 ? `${summary.unmatched} address(es) matched no lead. ` : '') +
    (summary.needNewEmail > 0
      ? `${summary.needNewEmail} lead(s) now need a new email address.`
      : '');

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Leads with no address at all — export and the matching import              */
/* -------------------------------------------------------------------------- */

export interface MissingEmailRow {
  id: string;
  business_name: string;
  city: string | null;
  country: string | null;
  niche: string | null;
  social_links: unknown;
}

/**
 * Every lead with no address, excluding archived and invalid ones.
 *
 * Shared by `missing.csv`'s GET (the download) and `importFoundEmailsCsv()`
 * below (the upload), so the two halves of the round trip always agree on
 * exactly which leads are in play — the same reasoning `pipeline_board` and
 * its counters follow elsewhere in this app. "No address" is the PIPELINE's
 * answer (`lead_pipeline.email_found`), not a raw `leads.email is null`
 * check, so this always matches the "No address" tile and the `?view=
 * missing_email` list.
 */
export async function getLeadsMissingEmail(): Promise<MissingEmailRow[]> {
  const admin = createServiceClient();

  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from('lead_pipeline')
      .select('lead_id')
      .eq('email_found', false)
      .is('closed', null)
      .order('lead_id', { ascending: true })
      .range(from, from + 999);

    const batch = data ?? [];
    ids.push(...batch.map((r) => r.lead_id));
    if (batch.length < 1000) break;
  }

  const rows: MissingEmailRow[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await admin
      .from('leads')
      .select('id, business_name, city, country, niche, social_links, status')
      .in('id', ids.slice(i, i + 300));

    for (const lead of data ?? []) {
      if (lead.status === 'archived' || lead.status === 'invalid') continue;
      rows.push(lead);
    }
  }
  return rows;
}

const BUSINESS_NAME_HEADERS = ['business_name', 'business name'];
const CITY_HEADERS = ['city'];
const COUNTRY_HEADERS = ['country'];
const NICHE_HEADERS = ['niche'];

/** business_name + city + country + niche, lowercased and trimmed — the same tuple this app already uses to spot duplicate leads (0028). */
function missingEmailMatchKey(
  businessName: string,
  city: string,
  country: string,
  niche: string,
): string {
  return [businessName, city, country, niche].map((v) => v.trim().toLowerCase()).join('|');
}

export interface FoundEmailImportSummary {
  ok: boolean;
  message: string;
  totalRows: number;
  applied: number;
  unmatched: number;
  ambiguous: number;
  failures: string[];
}

/**
 * Apply a "Leads with no address" file the operator filled in by hand.
 *
 * There is no address to match on — that is the entire reason this file
 * exists — so matching falls back to business_name + city + country + niche,
 * exactly as `missing.csv` exported them. A row is only applied when that
 * combination resolves to EXACTLY one lead currently missing an address:
 * zero matches means the row cannot be placed, and more than one means it is
 * ambiguous and is left alone rather than guessed at. The candidate pool is
 * `getLeadsMissingEmail()` — the same leads the file was built from — so a
 * name that happens to collide with a lead that already has an address can
 * never overwrite it.
 */
export async function importFoundEmailsCsv(text: string): Promise<FoundEmailImportSummary> {
  const summary: FoundEmailImportSummary = {
    ok: false,
    message: '',
    totalRows: 0,
    applied: 0,
    unmatched: 0,
    ambiguous: 0,
    failures: [],
  };

  const rows = parseCsv(text);
  if (rows.length < 2) {
    summary.message = 'That file has no data rows.';
    return summary;
  }

  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const emailIndex = EMAIL_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;
  const nameIndex = BUSINESS_NAME_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;
  const cityIndex = CITY_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;
  const countryIndex = COUNTRY_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;
  const nicheIndex = NICHE_HEADERS.map((h) => headers.indexOf(h)).find((i) => i >= 0) ?? -1;

  if (emailIndex < 0) {
    summary.message = `No email column found. Expected one of: ${EMAIL_HEADERS.join(', ')}.`;
    return summary;
  }
  if (nameIndex < 0) {
    summary.message = 'No business_name column found — is this the "Leads with no address" file?';
    return summary;
  }

  const candidates: Array<{ email: string; key: string }> = [];
  for (const row of rows.slice(1)) {
    const email = (row[emailIndex] ?? '').trim().toLowerCase();
    if (email === '') continue;

    summary.totalRows += 1;
    if (!EMAIL_PATTERN.test(email)) {
      summary.failures.push(`${email}: not a valid address`);
      continue;
    }

    candidates.push({
      email,
      key: missingEmailMatchKey(
        row[nameIndex] ?? '',
        cityIndex >= 0 ? (row[cityIndex] ?? '') : '',
        countryIndex >= 0 ? (row[countryIndex] ?? '') : '',
        nicheIndex >= 0 ? (row[nicheIndex] ?? '') : '',
      ),
    });
  }

  if (candidates.length === 0) {
    summary.message = 'No rows carried a usable email address.';
    return summary;
  }

  const byKey = new Map<string, string[]>();
  for (const lead of await getLeadsMissingEmail()) {
    const key = missingEmailMatchKey(
      lead.business_name,
      lead.city ?? '',
      lead.country ?? '',
      lead.niche ?? '',
    );
    byKey.set(key, [...(byKey.get(key) ?? []), lead.id]);
  }

  const admin = createServiceClient();

  for (const { email, key } of candidates) {
    const ids = byKey.get(key);
    if (!ids || ids.length === 0) {
      summary.unmatched += 1;
      continue;
    }
    if (ids.length > 1) {
      summary.ambiguous += 1;
      continue;
    }

    const id = ids[0]!;
    const { error } = await admin.from('leads').update({ email }).eq('id', id);

    if (error) {
      summary.failures.push(
        error.code === '23505'
          ? `${email}: already belongs to another lead`
          : `${email}: ${error.message}`,
      );
      continue;
    }

    /*
     * A brand new address on a lead that had none: nothing has ever been
     * checked against it, but stated explicitly rather than left for a
     * trigger to infer, same reasoning as bulkUpdateEmails().
     */
    await admin
      .from('lead_pipeline')
      .update({
        email_verification_status: 'unverified',
        email_verification_source: null,
        email_verifier_status: null,
        email_checked_at: null,
        email_checked_address: null,
      })
      .eq('lead_id', id);

    summary.applied += 1;
  }

  summary.ok = true;
  summary.message =
    `${summary.applied} lead(s) got a new address.` +
    (summary.unmatched > 0 ? ` ${summary.unmatched} row(s) matched no lead with no address.` : '') +
    (summary.ambiguous > 0
      ? ` ${summary.ambiguous} row(s) matched more than one lead and were left alone.`
      : '') +
    (summary.failures.length > 0 ? ` ${summary.failures.length} failed: ${summary.failures.slice(0, 5).join('; ')}.` : '');

  return summary;
}
