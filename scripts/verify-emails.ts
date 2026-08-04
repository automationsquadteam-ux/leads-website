/**
 * Email verification round trip.
 *
 *   npm run emails:export                      # unverified addresses -> CSV
 *   npm run emails:import -- --file=result.csv # apply a verifier's results
 *   npm run emails:import -- --file=x.csv --dry-run
 *   npm run emails:status                      # what is verified right now
 *
 * The loop this supports:
 *   1. `emails:export` writes unverified-emails.csv
 *   2. upload it to NeverBounce / ZeroBounce / Bouncer
 *   3. download their result CSV
 *   4. `emails:import -- --file=<their file>`
 *
 * No verifier API key lives in this project. That is the point: nothing to
 * bill, nothing to leak, and any tool that exports a CSV works.
 *
 * Uses the service-role key and therefore bypasses RLS. Trusted machines only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { config as loadEnv } from 'dotenv';

import {
  buildUnverifiedCsv,
  importVerificationCsv,
  parseCsv,
  normaliseVerificationStatus,
} from '../src/lib/services/email-verification';
import { createServiceClient } from '../src/lib/supabase/service-client';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

const HELP = `
Email verification round trip.

Usage:
  npm run emails:export -- [--out=unverified-emails.csv]
  npm run emails:import -- --file=<verifier result.csv> [--source=neverbounce] [--dry-run]
  npm run emails:status

  --file=<path>     Verifier result CSV to apply
  --out=<path>      Where to write the export  (default: unverified-emails.csv)
  --source=<name>   Recorded against each result (default: neverbounce)
  --dry-run         Parse and report, write nothing
  --help            Show this message
`.trim();

function flagValue(argv: string[], key: string): string | undefined {
  for (const arg of argv) {
    if (arg === `--${key}`) return 'true';
    if (arg.startsWith(`--${key}=`)) return arg.slice(key.length + 3);
  }
  return undefined;
}

async function exportUnverified(out: string): Promise<void> {
  const { csv, count } = await buildUnverifiedCsv();

  if (count === 0) {
    console.log('\nEvery address already has a definite verdict. Nothing to export.\n');
    return;
  }

  writeFileSync(out, csv, 'utf8');
  console.log(`\n  Wrote ${count} address(es) to ${out}`);
  console.log('\n  Next: upload that file to your verifier, then run');
  console.log('    npm run emails:import -- --file=<their result.csv>\n');
}

async function showStatus(): Promise<void> {
  const db = createServiceClient();
  const statuses = ['unverified', 'valid', 'invalid', 'accept_all', 'unknown'] as const;

  console.log('\n  Verification state');
  console.log('  ' + '─'.repeat(40));
  for (const status of statuses) {
    const { count } = await db
      .from('lead_pipeline')
      .select('*', { count: 'exact', head: true })
      .eq('email_verification_status', status);
    console.log(`  ${status.padEnd(14)} ${String(count ?? 0).padStart(6)}`);
  }

  const { count: noEmail } = await db
    .from('lead_pipeline')
    .select('*', { count: 'exact', head: true })
    .eq('email_found', false);
  console.log('  ' + '─'.repeat(40));
  console.log(`  ${'no address'.padEnd(14)} ${String(noEmail ?? 0).padStart(6)}\n`);
}

/** Report what a file would do, without touching the database. */
function dryRun(text: string): void {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.log('\n  That file has no data rows.\n');
    return;
  }

  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  console.log(`\n  Headers: ${headers.join(', ')}`);

  const statusIndex = ['email_status', 'status', 'result', 'verification_status']
    .map((h) => headers.indexOf(h))
    .find((i) => i >= 0);

  if (statusIndex === undefined || statusIndex < 0) {
    console.log('  No recognised result column.\n');
    return;
  }

  const tally = new Map<string, number>();
  for (const row of rows.slice(1)) {
    const raw = (row[statusIndex] ?? '').trim();
    if (raw === '') continue;
    const mapped = normaliseVerificationStatus(raw) ?? `UNRECOGNISED(${raw})`;
    tally.set(mapped, (tally.get(mapped) ?? 0) + 1);
  }

  console.log(`  Data rows: ${rows.length - 1}\n`);
  console.log('  Would apply:');
  for (const [status, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(6)}  ${status}`);
  }
  console.log('\n  Dry run nothing was written.\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (flagValue(argv, 'help')) {
    console.log(HELP);
    return;
  }

  const mode = argv.find((a) => !a.startsWith('--')) ?? 'export';

  if (mode === 'status') {
    await showStatus();
    return;
  }

  if (mode === 'export') {
    await exportUnverified(flagValue(argv, 'out') ?? 'unverified-emails.csv');
    return;
  }

  if (mode === 'import') {
    const file = flagValue(argv, 'file');
    if (!file) {
      console.error('\n  --file=<path> is required for import.\n');
      process.exitCode = 1;
      return;
    }

    const text = readFileSync(file, 'utf8');

    if (flagValue(argv, 'dry-run')) {
      dryRun(text);
      return;
    }

    const summary = await importVerificationCsv(text, flagValue(argv, 'source') ?? 'neverbounce');
    const line = '  ' + '─'.repeat(58);

    console.log(`\n${line}`);
    console.log(`  Verification import${summary.ok ? '' : ' FAILED'}`);
    console.log(line);
    console.log(`  Rows read        ${String(summary.totalRows).padStart(6)}`);
    console.log(`  Leads updated    ${String(summary.matched).padStart(6)}`);
    console.log(`  Unmatched        ${String(summary.unmatched).padStart(6)}`);
    console.log(line);
    console.log(`  valid            ${String(summary.applied.valid).padStart(6)}`);
    console.log(`  invalid          ${String(summary.applied.invalid).padStart(6)}   -> back to Need Email`);
    console.log(`  accept_all       ${String(summary.applied.accept_all).padStart(6)}   -> recorded, not auto-verified`);
    console.log(`  unknown          ${String(summary.applied.unknown).padStart(6)}`);
    console.log(line);

    if (summary.unrecognisedStatuses.length > 0) {
      console.log(`  ! Unrecognised results: ${summary.unrecognisedStatuses.join(', ')}`);
    }
    console.log(`\n  ${summary.message}\n`);

    if (!summary.ok) process.exitCode = 1;
    return;
  }

  console.error(`\n  Unknown mode ${JSON.stringify(mode)}.\n\n${HELP}\n`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
