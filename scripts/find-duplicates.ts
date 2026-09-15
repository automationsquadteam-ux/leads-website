/**
 * Report leads that are the same business twice.
 *
 *   npm run leads:duplicates
 *   npm run leads:duplicates -- --merge              # keep the richest, archive the rest
 *   npm run leads:duplicates -- --merge --pair a,b   # merge two specific leads (id or 8-char prefix)
 *
 * Three ways two rows are found to be one business, checked in this order:
 *
 *   same NAME + country + niche   the sheet lists a business twice, usually
 *                                 under two domains (gccuae.com / gcc-uae.net)
 *                                 or two spellings ("Al-Romansiah" /
 *                                 "Al Romansiah - الرومانسية"). Neither the
 *                                 address nor the sheet row matches, so this
 *                                 is the check that catches most of them.
 *   same NAME + website domain    the same business filed under two countries
 *                                 (DP World Logistics in Sweden AND Portugal,
 *                                 one site, one contact). A branch is not a
 *                                 second lead. The domain ALONE is not enough:
 *                                 linktr.ee is the "website" of four unrelated
 *                                 businesses, and lamborghini.com is shared by
 *                                 two dealerships with two different inboxes.
 *   same SHEET ROW                two leads pointing at one row of the sheet.
 *
 * Names are compared after normalising: case, punctuation, accents and legal
 * suffixes (LLC, W.L.L, Ltd, Co., ...) are dropped. Websites are compared by
 * registrable domain (www. and subdomains dropped, so order.example.com is
 * example.com).
 *
 * Two more kinds of match are LISTED but not merged by --merge, because each
 * has real false positives; merge one deliberately with --pair:
 *
 *   same EMAIL, different name    usually one business, sometimes a dealer
 *                                 group's shared customer-care inbox behind
 *                                 two brands (Infiniti Kuwait / Babtain).
 *   near-miss name                one name is the other plus a branch or an
 *                                 abbreviation. "Lanka Travels" and "Beauty
 *                                 Lanka Travels" are two businesses.
 *
 * Archived leads are ignored throughout: a row already archived by an earlier
 * merge must never become the survivor of the next one.
 *
 * WHY THIS HAPPENS, despite leads.dedupe_key being UNIQUE:
 *
 * dedupe_key is computed ONCE, at import, from whatever the row had at the
 * time:
 *
 *     email:<address>    when there was a usable address
 *     site:<host+path>   when there was not
 *     name:<name>|<city> last resort
 *
 * A sheet row with no email gets `site:` or `name:`. If the address is filled
 * in later ,upstream, or by hand in the CRM ,the key is NOT recomputed,
 * because it is not in REFRESHABLE_FIELDS and nothing else touches it. So two
 * rows for one business can end up with different keys and the same address,
 * and the UNIQUE index is perfectly happy.
 *
 * Recomputing keys automatically would be worse: it would collide with the
 * surviving row and fail the whole sync, and merging is a judgement call about
 * which research and which drafts to keep. Hence a report, and an opt-in merge.
 *
 * --merge keeps the lead with the most filled-in fields, moves email logs,
 * replies, versions and activity onto it, and ARCHIVES the others. Nothing is
 * deleted.
 *
 * Uses the service-role key and bypasses RLS. Trusted machines only.
 */
import process from 'node:process';

import { config as loadEnv } from 'dotenv';

import { createServiceClient } from '../src/lib/supabase/service-client';
import type { Lead } from '../src/lib/supabase/database.types';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

/**
 * How much real content a lead carries. The richest row wins a merge.
 *
 * `history` outranks everything: a row that already has send logs, a reply or a
 * confirmed verification is the one the outside world has interacted with.
 * Content can be copied across; a conversation cannot, and picking the other
 * row would mean relinking evidence for no reason.
 */
function score(lead: Lead, history = 0): number {
  const filled = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? 1 : 0);
  return (
    history * 100 +
    // An address outranks any single piece of research: a survivor without
    // one cannot be contacted, and the merge does not copy fields across.
    filled(lead.email) * 4 +
    filled(lead.research_summary) * 3 +
    filled(lead.draft_email) * 3 +
    filled(lead.subject_line) +
    filled(lead.website_observations) +
    filled(lead.automation_opportunities) +
    filled(lead.ai_chatbot_opportunities) +
    filled(lead.website_improvement_opportunities) +
    filled(lead.personalization) +
    filled(lead.outreach_angle) +
    filled(lead.interesting_facts) +
    filled(lead.notes) +
    filled(lead.website) +
    filled(lead.phone) +
    (lead.sheet_row_number ? 1 : 0)
  );
}

/**
 * Legal-form and filler tokens that say nothing about WHICH business this is.
 * "General Construction Co W.L.L" and "General Construction Co. L.L.C" are one
 * company; the suffix is the only thing that differs.
 */
const NOISE_TOKENS = new Set([
  'the', 'and', 'of',
  'llc', 'wll', 'ltd', 'limited', 'inc', 'corp', 'corporation', 'co', 'company',
  'fze', 'fzc', 'fzco', 'fz', 'est', 'establishment', 'pvt', 'private',
  'sdn', 'bhd', 'gmbh', 'ag', 'sa', 'srl', 'sl', 'pty', 'plc',
]);

/** "General Construction Co. L.L.C - GCC" -> "general construction gcc" */
function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    // Dotted abbreviations: "w.l.l" -> "wll", "l.l.c" -> "llc", so the token
    // filter can recognise them. Any other dot becomes a separator below.
    .replace(/\.(?=\p{L}(?:\.|\s|$))/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t !== '' && !NOISE_TOKENS.has(t))
    .join(' ');
}

const lower = (v: string | null) => (v ?? '').trim().toLowerCase();

function nameKey(lead: Lead): string | null {
  const name = normaliseName(lead.business_name);
  if (name === '') return null;
  return `name:${name}|${lower(lead.country)}|${lower(lead.niche)}`;
}

/**
 * Second-level labels under which the registrable name sits one level deeper:
 * onehair.com.my, example.co.uk. Without this, every ".com.my" site would
 * collapse to "com.my" and match every other one.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** "https://www.dpworld.com/en/supply-chain" -> "dpworld.com" */
function registrableDomain(website: string | null): string | null {
  if (!website) return null;
  const raw = website.trim().toLowerCase();
  if (raw === '') return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
    const labels = url.hostname.replace(/^www\./, '').split('.').filter(Boolean);
    if (labels.length < 2) return null;
    const keep = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
    return labels.slice(-keep).join('.');
  } catch {
    return null;
  }
}

function siteKey(lead: Lead): string | null {
  const name = normaliseName(lead.business_name);
  const domain = registrableDomain(lead.website);
  if (name === '' || !domain) return null;
  return `site:${domain}|${name}`;
}

/** `--pair a,b` accepts full ids or the 8-char prefixes the report prints. */
function readPair(): string[] | null {
  const at = process.argv.indexOf('--pair');
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error('--pair needs two or more ids, comma-separated');
  const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length < 2) throw new Error('--pair needs at least two ids');
  return ids;
}

async function main(): Promise<void> {
  const merge = process.argv.includes('--merge');
  const pair = readPair();
  const db = createServiceClient();

  const all: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('leads')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  // An archived row is either a merge loser already or junk. Either way it
  // must not be grouped again ,it could win and demote the live survivor.
  const live = all.filter((lead) => lead.status !== 'archived');

  const groups = new Map<string, Lead[]>();
  const seen = new Set<string>();
  const markGrouped = () => {
    for (const [, rows] of groups) {
      if (rows.length > 1) for (const r of rows) seen.add(r.id);
    }
  };

  if (pair) {
    const rows = pair.map((wanted) => {
      const hits = live.filter((l) => l.id === wanted || l.id.startsWith(wanted));
      if (hits.length === 0) throw new Error(`--pair: no live lead matches "${wanted}"`);
      if (hits.length > 1) throw new Error(`--pair: "${wanted}" is ambiguous, use a longer id`);
      return hits[0]!;
    });
    groups.set(`pair:${rows.map((r) => r.id.slice(0, 8)).join('+')}`, rows);
  } else {
    /*
     * Order matters: a row joins the FIRST group that claims it, so the check
     * that best describes "same business" goes first.
     *
     *   same NAME+country+niche   the sheet has the business twice ,two
     *                             domains, two spellings, an old and a new
     *                             row. Nothing else matches.
     *   same NAME+domain          the same business under two countries. The
     *                             name alone would be a branch; the domain
     *                             alone would merge every linktr.ee page.
     *   same SHEET ROW            two leads pointing at one row of the sheet.
     *                             This is what editing an email used to cause
     *                             before 0028, when dedupe_key kept the old
     *                             address and the next sync inserted a second
     *                             lead:
     *
     *                               row 723  email:showroom@apatchicars.com
     *                                        email:info@apatchicars.com
     *
     * A shared EMAIL with a different name is reported separately, below, and
     * is not merged by --merge (see the header).
     */
    for (const lead of live) {
      const key = nameKey(lead);
      if (key) groups.set(key, [...(groups.get(key) ?? []), lead]);
    }
    markGrouped();

    for (const lead of live) {
      if (seen.has(lead.id)) continue;
      const key = siteKey(lead);
      if (key) groups.set(key, [...(groups.get(key) ?? []), lead]);
    }
    markGrouped();

    for (const lead of live) {
      if (!lead.sheet_row_number || seen.has(lead.id)) continue;
      const key = `row:${lead.sheet_row_number}`;
      groups.set(key, [...(groups.get(key) ?? []), lead]);
    }
    markGrouped();
  }

  const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  const line = '─'.repeat(72);

  console.log(`\n${line}`);
  console.log(`  Leads that are one business twice${merge ? '  (MERGING)' : ''}`);
  console.log(line);
  console.log(`  Live leads              ${live.length}  (${all.length - live.length} archived, ignored)`);
  console.log(`  Duplicate groups        ${dupes.length}`);
  console.log(`  Extra rows involved     ${dupes.reduce((n, [, r]) => n + r.length - 1, 0)}`);
  console.log(line);

  if (dupes.length === 0) {
    console.log('\n  No duplicates. Nothing to do.\n');
  }

  for (const [groupKey, rows] of dupes) {
    const [kind, rest] = [groupKey.slice(0, groupKey.indexOf(':')), groupKey.slice(groupKey.indexOf(':') + 1)];
    const email =
      kind === 'row'
        ? `sheet row ${rest}`
        : kind === 'name'
          ? `same name ,${rest.replace(/\|/g, ' / ')}`
          : kind === 'site'
            ? `same name and website ,${rest.split('|').reverse().join(' / ')}`
            : `--pair ${rest}`;
    // Gather the evidence BEFORE ranking, so the survivor is chosen on it
    // rather than on field counts alone.
    const detail = new Map<string, { logs: number; replied: boolean; verified: boolean; stage: string; verif: string }>();

    for (const lead of rows) {
      const [{ count: logs }, { count: replies }, { data: p }] = await Promise.all([
        db.from('email_logs').select('*', { count: 'exact', head: true }).eq('lead_id', lead.id),
        db.from('replies').select('*', { count: 'exact', head: true }).eq('lead_id', lead.id),
        db
          .from('lead_pipeline')
          .select('email_verification_status, current_stage, replied')
          .eq('lead_id', lead.id)
          .maybeSingle(),
      ]);

      detail.set(lead.id, {
        logs: logs ?? 0,
        replied: Boolean(p?.replied) || (replies ?? 0) > 0,
        verified: p?.email_verification_status === 'valid',
        stage: p?.current_stage ?? '?',
        verif: p?.email_verification_status ?? '?',
      });
    }

    const historyOf = (id: string) => {
      const d = detail.get(id);
      if (!d) return 0;
      return (d.logs > 0 ? 2 : 0) + (d.replied ? 3 : 0) + (d.verified ? 1 : 0);
    };

    const ranked = [...rows].sort(
      (a, b) => score(b, historyOf(b.id)) - score(a, historyOf(a.id)),
    );
    const keep = ranked[0]!;

    console.log(`\n  ${email}`);
    for (const lead of ranked) {
      const d = detail.get(lead.id)!;
      const logs = d.logs;
      const p = { current_stage: d.stage, email_verification_status: d.verif, replied: d.replied };

      const tag = lead.id === keep.id ? 'KEEP  ' : 'ARCHIVE';
      console.log(
        `    ${tag} ${lead.id.slice(0, 8)}  score=${String(score(lead, historyOf(lead.id))).padStart(4)}  ` +
          `status=${lead.status.padEnd(11)} stage=${p.current_stage.padEnd(16)} ` +
          `verif=${p.email_verification_status.padEnd(10)} logs=${logs}` +
          `${p.replied ? ' REPLIED' : ''}`,
      );
      console.log(`             key=${lead.dedupe_key.slice(0, 58)}`);
    }

    if (!merge) continue;

    const losers = ranked.slice(1);
    for (const loser of losers) {
      // Move the evidence onto the surviving lead before archiving.
      await db.from('email_logs').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('replies').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('lead_activity').update({ lead_id: keep.id }).eq('lead_id', loser.id);
      await db.from('inbound_messages').update({ lead_id: keep.id }).eq('lead_id', loser.id);

      // Versions carry a UNIQUE (lead_id, type, version_number), so moving them
      // would collide. The survivor already has its own drafts; the loser's stay
      // attached to the archived row, readable but out of the way.
      await db
        .from('leads')
        .update({
          status: 'archived',
          notes: `${loser.notes ? `${loser.notes}\n\n` : ''}Merged into ${keep.id} by leads:duplicates on ${new Date().toISOString().slice(0, 10)}.`,
        })
        .eq('id', loser.id);
    }

    console.log(`    -> merged ${losers.length} row(s) into ${keep.id.slice(0, 8)}`);
  }

  console.log(`\n${line}`);
  if (merge) {
    console.log('  Merged. Losing rows are ARCHIVED, not deleted, and say so in their notes.');
  } else if (dupes.length > 0) {
    console.log('  Dry report. Re-run with --merge to move logs/replies onto the KEEP row');
    console.log('  and archive the others. Nothing is ever deleted.');
  }
  console.log(`${line}\n`);

  if (pair) return;

  const ungrouped = live.filter((lead) => !seen.has(lead.id));
  printReviewList(
    'Share an email address, under different names',
    sharedEmailGroups(ungrouped),
    line,
  );
  printReviewList(
    'Near misses ,same country and niche, one name contains the other',
    nearMissPairs(ungrouped),
    line,
  );
}

/**
 * One address, two names. Usually one business ("One Hair Design Center" on
 * its site and on its Facebook page), but a dealer group can put one
 * customer-care inbox behind two brands, and those are two leads that happen
 * to reach the same desk. Listed for a human.
 */
function sharedEmailGroups(leads: Lead[]): Lead[][] {
  const byEmail = new Map<string, Lead[]>();
  for (const lead of leads) {
    if (!lead.email) continue;
    const key = lead.email.trim().toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), lead]);
  }
  return [...byEmail.values()].filter((rows) => rows.length > 1);
}

/**
 * Same country and niche, and one normalised name is the other with words
 * added at the start or the end. That covers a branch ("Fitness Extreme Qatar"
 * / "... Cinema C Ring Road"), an abbreviation ("General Construction Co" /
 * "... - GCC") and a spelling ("Al-Romansiah" / "Al Romansiah - الرومانسية")
 * ,but also "Lanka Travels" / "Beauty Lanka Travels", which are two
 * businesses. So these are listed for a human, never merged on their own.
 */
function nearMissPairs(leads: Lead[]): Lead[][] {
  const byMarket = new Map<string, Lead[]>();
  for (const lead of leads) {
    const key = `${lower(lead.country)}|${lower(lead.niche)}`;
    byMarket.set(key, [...(byMarket.get(key) ?? []), lead]);
  }

  const pairs: Lead[][] = [];
  for (const rows of byMarket.values()) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = normaliseName(rows[i]!.business_name);
        const b = normaliseName(rows[j]!.business_name);
        if (a === '' || b === '' || a === b) continue;
        const [short, long] = a.length <= b.length ? [a, b] : [b, a];
        // One-word names ("Physio") would match half the niche.
        if (!short.includes(' ')) continue;
        if (long.startsWith(`${short} `) || long.endsWith(` ${short}`)) {
          pairs.push([rows[i]!, rows[j]!]);
        }
      }
    }
  }
  return pairs;
}

function printReviewList(title: string, groups: Lead[][], line: string): void {
  if (groups.length === 0) return;

  console.log(line);
  console.log(`  ${title}`);
  console.log(`  NOT merged. Merge one with:  -- --merge --pair <id>,<id>`);
  console.log(line);
  for (const rows of groups) {
    console.log('');
    for (const lead of rows) {
      console.log(
        `    ${lead.id.slice(0, 8)}  status=${lead.status.padEnd(11)} ${(lead.country ?? '-').padEnd(14)} ` +
          `${(lead.email ?? '(no email)').padEnd(36)} ${lead.business_name}`,
      );
    }
  }
  console.log(`\n${line}\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
