/**
 * Delete leads from Supabase, with a restorable backup.
 *
 *   npm run leads:purge                              # DRY RUN — shows what would go
 *   npm run leads:purge -- --yes                     # delete everything
 *   npm run leads:purge -- --source="google-sheets:Sheet1" --yes
 *   npm run leads:purge -- --restore=backups/leads-....json
 *
 * Deleting a lead CASCADES to email_versions, lead_pipeline, lead_activity,
 * email_logs and replies — every one of those tables declares
 * `on delete cascade` on lead_id. So this is a much bigger operation than the
 * lead count suggests, and the summary spells that out before doing anything.
 *
 * Every real run writes a timestamped JSON backup of the lead rows FIRST, and
 * refuses to proceed if that write fails. A purge you cannot undo is not a
 * maintenance tool, it is an accident waiting for a typo — the whole reason the
 * backup exists is that `--source` is easy to get subtly wrong.
 *
 * What the backup does NOT capture: email_versions, activity and pipeline
 * timestamps. Restoring re-creates the leads (and the pipeline rows follow from
 * the trigger); draft history is gone. Prefer `--source` over a full purge.
 *
 * Uses the service-role key and therefore bypasses RLS. Trusted machines only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { config as loadEnv } from 'dotenv';

import type { Lead, LeadInsert } from '../src/lib/supabase/database.types';
import { createServiceClient } from '../src/lib/supabase/service-client';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

const HELP = `
Delete leads from Supabase. Cascades to versions, pipeline, activity, logs and replies.

Usage: npm run leads:purge -- [options]

  (no options)         DRY RUN — report what would be deleted, write nothing
  --yes                Actually delete. Writes a backup first.
  --source=<value>     Only leads with this exact leads.source
  --no-backup          Skip the backup file (refused unless --source is given)
  --backup-dir=<path>  Backup location            (default: backups)
  --restore=<file>     Re-insert leads from a backup file and exit
  --help               Show this message
`.trim();

interface Args {
  yes: boolean;
  source?: string;
  noBackup: boolean;
  backupDir: string;
  restore?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, ...rest] = arg.slice(2).split('=');
    const key = (rawKey ?? '').trim();
    if (!key) continue;
    flags.set(key, rest.length > 0 ? rest.join('=') : true);
  }
  const str = (key: string): string | undefined => {
    const value = flags.get(key);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const bool = (key: string): boolean => flags.get(key) === true || flags.get(key) === 'true';

  return {
    yes: bool('yes'),
    source: str('source'),
    noBackup: bool('no-backup'),
    backupDir: str('backup-dir') ?? 'backups',
    restore: str('restore'),
    help: bool('help'),
  };
}

type Client = ReturnType<typeof createServiceClient>;

/** PostgREST caps a response at 1000 rows, so every read here pages. */
async function fetchAllLeads(db: Client, source?: string): Promise<Lead[]> {
  const pageSize = 1000;
  const rows: Lead[] = [];

  for (let from = 0; ; from += pageSize) {
    let query = db.from('leads').select('*').order('id', { ascending: true }).range(from, from + pageSize - 1);
    if (source !== undefined) query = query.eq('source', source);

    const { data, error } = await query;
    if (error) throw new Error(`Could not read leads: ${error.message}`);

    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }

  return rows;
}

async function countRows(db: Client, table: string): Promise<number | null> {
  const { count, error } = await db.from(table as 'leads').select('*', { count: 'exact', head: true });
  return error ? null : (count ?? 0);
}

async function restore(db: Client, file: string): Promise<void> {
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as { leads?: Lead[] } | Lead[];
  const leads = Array.isArray(parsed) ? parsed : (parsed.leads ?? []);

  if (leads.length === 0) {
    console.log('Backup contains no leads. Nothing to restore.');
    return;
  }

  console.log(`Restoring ${leads.length} lead(s) from ${file} ...`);

  let restored = 0;
  for (let i = 0; i < leads.length; i += 200) {
    const batch = leads.slice(i, i + 200).map((lead) => {
      // search_vector is a generated column and cannot be written back.
      const { search_vector: _ignored, ...rest } = lead as Lead & { search_vector?: unknown };
      return rest as LeadInsert;
    });

    const { data, error } = await db
      .from('leads')
      .upsert(batch, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('id');

    if (error) throw new Error(`Restore failed: ${error.message}`);
    restored += (data ?? []).length;
  }

  console.log(`Restored ${restored} lead(s). ${leads.length - restored} already existed and were left alone.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const db = createServiceClient();

  if (args.restore) {
    await restore(db, args.restore);
    return;
  }

  const line = '─'.repeat(60);

  // What is here now, including the tables that will cascade.
  const [leadCount, versions, pipeline, activity, logs, replies] = await Promise.all([
    countRows(db, 'leads'),
    countRows(db, 'email_versions'),
    countRows(db, 'lead_pipeline'),
    countRows(db, 'lead_activity'),
    countRows(db, 'email_logs'),
    countRows(db, 'replies'),
  ]);

  const targets = await fetchAllLeads(db, args.source);

  console.log(`\n${line}`);
  console.log(`  Purge leads${args.yes ? '' : '  (DRY RUN — nothing will be deleted)'}`);
  console.log(line);
  console.log(`  Filter            ${args.source ? `source = ${JSON.stringify(args.source)}` : 'ALL LEADS'}`);
  console.log(`  Leads in database ${String(leadCount ?? '?').padStart(6)}`);
  console.log(`  Matching filter   ${String(targets.length).padStart(6)}   <- would be deleted`);
  console.log(line);
  console.log('  Cascades (rows currently in each table):');
  console.log(`    email_versions  ${String(versions ?? 'table missing').padStart(6)}`);
  console.log(`    lead_pipeline   ${String(pipeline ?? 'table missing').padStart(6)}`);
  console.log(`    lead_activity   ${String(activity ?? 'table missing').padStart(6)}`);
  console.log(`    email_logs      ${String(logs ?? 'table missing').padStart(6)}`);
  console.log(`    replies         ${String(replies ?? 'table missing').padStart(6)}`);
  console.log(line);

  const withDraft = targets.filter((l) => (l.draft_email ?? '').trim() !== '').length;
  const withResearch = targets.filter((l) => (l.research_summary ?? '').trim() !== '').length;
  console.log(`  Of the leads being deleted:`);
  console.log(`    carry a draft   ${String(withDraft).padStart(6)}`);
  console.log(`    carry research  ${String(withResearch).padStart(6)}`);
  console.log(line);

  if (targets.length === 0) {
    console.log('\nNothing matches. Done.\n');
    return;
  }

  if (!args.yes) {
    console.log('\nThis was a dry run. Re-run with --yes to delete.\n');
    return;
  }

  // Back up before touching anything.
  if (args.noBackup && !args.source) {
    console.error('\nRefusing --no-backup on a full purge. Drop the flag, or narrow it with --source.\n');
    process.exitCode = 1;
    return;
  }

  let backupPath: string | null = null;
  if (!args.noBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(args.backupDir);
    mkdirSync(dir, { recursive: true });
    backupPath = path.join(dir, `leads-${stamp}.json`);

    writeFileSync(
      backupPath,
      JSON.stringify(
        {
          takenAt: new Date().toISOString(),
          filter: args.source ?? null,
          leadCount: targets.length,
          note: 'Restore with: npm run leads:purge -- --restore=<this file>',
          leads: targets,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\nBackup written: ${backupPath}`);
  }

  console.log('Deleting ...');

  let deleted = 0;
  for (let i = 0; i < targets.length; i += 200) {
    const ids = targets.slice(i, i + 200).map((lead) => lead.id);
    const { data, error } = await db.from('leads').delete().in('id', ids).select('id');
    if (error) throw new Error(`Delete failed after ${deleted} row(s): ${error.message}`);
    deleted += (data ?? []).length;
  }

  const [leadsAfter, versionsAfter, pipelineAfter] = await Promise.all([
    countRows(db, 'leads'),
    countRows(db, 'email_versions'),
    countRows(db, 'lead_pipeline'),
  ]);

  console.log(`\n${line}`);
  console.log(`  Deleted ${deleted} lead(s).`);
  console.log(`  Remaining: leads ${leadsAfter}, email_versions ${versionsAfter}, lead_pipeline ${pipelineAfter}`);
  if (backupPath) console.log(`  Backup:    ${backupPath}`);
  console.log(`${line}\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
