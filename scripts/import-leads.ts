/**
 * Import leads from the workbook into Supabase.
 *
 *   npm run import:leads              # import Sheet2 (default)
 *   npm run import:leads:dry          # validate only, write nothing
 *   npm run import:leads -- --sheet=Sheet1
 *   npm run import:leads -- --update  # also refresh leads that already exist
 *
 * Safe to run repeatedly: leads.dedupe_key is UNIQUE and inserts use
 * ON CONFLICT DO NOTHING, so a second run imports 0 and skips everything.
 *
 * Uses the service-role key and therefore bypasses RLS. Run it from a trusted
 * machine only.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { config as loadEnv } from 'dotenv';

import type { KeyMode } from '../src/lib/import/dedupe';
import { importLeads, type ImportSummary } from '../src/lib/import/importer';
import { listSheets } from '../src/lib/import/workbook';
import { createServiceClient } from '../src/lib/supabase/service-client';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

interface Args {
  file: string;
  sheet: string;
  dryRun: boolean;
  update: boolean;
  keyMode: KeyMode;
  limit?: number;
  report: boolean;
  reportPath: string;
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

  const str = (key: string, fallback: string): string => {
    const value = flags.get(key);
    return typeof value === 'string' && value !== '' ? value : fallback;
  };
  const bool = (key: string): boolean => flags.get(key) === true || flags.get(key) === 'true';

  const rawLimit = flags.get('limit');
  const limit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : undefined;

  const keyModeRaw = str('key-mode', 'email');
  if (keyModeRaw !== 'email' && keyModeRaw !== 'business') {
    throw new Error(`--key-mode must be "email" or "business", got ${JSON.stringify(keyModeRaw)}`);
  }

  return {
    file: str('file', process.env.LEADS_XLSX_PATH || 'Leads.xlsx'),
    sheet: str('sheet', process.env.LEADS_XLSX_SHEET || 'Sheet2'),
    dryRun: bool('dry-run'),
    update: bool('update'),
    keyMode: keyModeRaw,
    limit: Number.isFinite(limit) && (limit as number) > 0 ? limit : undefined,
    report: !bool('no-report'),
    reportPath: str('report-path', 'import-report.json'),
    help: bool('help'),
  };
}

const HELP = `
Import leads from an Excel workbook into Supabase.

Usage: npm run import:leads -- [options]

  --file=<path>          Workbook path        (default: $LEADS_XLSX_PATH or Leads.xlsx)
  --sheet=<name|index>   Worksheet            (default: $LEADS_XLSX_SHEET or Sheet2)
  --dry-run              Validate only; write nothing
  --update               Refresh contact/research/draft fields on existing leads
  --key-mode=email       Identity: email > website > name+city   (default, per spec)
  --key-mode=business    Identity: business name + city
  --limit=<n>            Process only the first n rows
  --no-report            Do not write import-report.json
  --report-path=<path>   Report location      (default: import-report.json)
  --help                 Show this message
`.trim();

function bar(count: number, total: number, width = 28): string {
  if (total <= 0) return '';
  const filled = Math.round((count / total) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function printSummary(summary: ImportSummary): void {
  const {
    totalRows, imported, skipped, duplicates, invalid, updated,
  } = summary;

  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log(`  Import summary${summary.dryRun ? '  (DRY RUN — nothing was written)' : ''}`);
  console.log(line);
  console.log(`  File            ${summary.file}`);
  console.log(`  Sheet           ${summary.sheet}`);
  console.log(`  Identity        ${summary.keyMode}`);
  console.log(`  Batch id        ${summary.batchId}`);
  console.log(line);
  console.log(`  Rows read       ${String(totalRows).padStart(6)}`);
  console.log(`  Imported        ${String(imported).padStart(6)}  ${bar(imported, totalRows)}`);
  console.log(`  Skipped (in DB) ${String(skipped).padStart(6)}  ${bar(skipped, totalRows)}`);
  console.log(`  Duplicates      ${String(duplicates).padStart(6)}  ${bar(duplicates, totalRows)}`);
  console.log(`  Invalid rows    ${String(invalid).padStart(6)}  ${bar(invalid, totalRows)}`);
  if (updated > 0) {
    console.log(`  Updated         ${String(updated).padStart(6)}  ${bar(updated, totalRows)}`);
  }
  console.log(line);

  const accounted = imported + skipped + duplicates + invalid + updated;
  if (accounted !== totalRows) {
    console.log(`  ! ${totalRows - accounted} row(s) unaccounted for — check errors below.`);
  }

  if (summary.invalidRows.length > 0) {
    console.log(`\n  Invalid rows (first 10 of ${summary.invalidRows.length}):`);
    for (const row of summary.invalidRows.slice(0, 10)) {
      const reasons = row.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
      console.log(`    row ${row.rowNumber}  ${row.businessName ?? '(no name)'} — ${reasons}`);
    }
  }

  if (summary.duplicateRows.length > 0) {
    console.log(`\n  Duplicates collapsed (first 10 of ${summary.duplicateRows.length}):`);
    for (const row of summary.duplicateRows.slice(0, 10)) {
      console.log(
        `    row ${row.rowNumber}  ${row.businessName}\n` +
        `        merged into row ${row.firstSeenAtRow} (${row.firstSeenBusinessName})\n` +
        `        shared identity: ${row.dedupeKey}`,
      );
    }
  }

  if (summary.warnings.length > 0) {
    console.log(`\n  Field warnings (first 10 of ${summary.warnings.length}):`);
    for (const w of summary.warnings.slice(0, 10)) {
      console.log(`    row ${w.rowNumber}  ${w.businessName ?? ''} — ${w.warning}`);
    }
  }

  if (summary.errors.length > 0) {
    console.log(`\n  Database errors (${summary.errors.length}):`);
    for (const e of summary.errors.slice(0, 10)) console.log(`    ${e}`);
  }

  console.log(`\n  Finished in ${(summary.durationMs / 1000).toFixed(2)}s\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }

  const filePath = path.resolve(process.cwd(), args.file);

  let sheets: string[];
  try {
    sheets = await listSheets(filePath);
  } catch (error) {
    console.error(`\n  Could not read workbook at ${filePath}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  if (!sheets.includes(args.sheet)) {
    const asIndex = Number.parseInt(args.sheet, 10);
    if (!Number.isFinite(asIndex) || asIndex < 1 || asIndex > sheets.length) {
      console.error(
        `\n  Worksheet ${JSON.stringify(args.sheet)} not found. Available: ${sheets.join(', ')}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // The dry run never touches the network, so it must not demand credentials.
  const client = args.dryRun ? null : createServiceClient();

  const summary = await importLeads(client, {
    filePath,
    sheet: args.sheet,
    keyMode: args.keyMode,
    dryRun: args.dryRun,
    update: args.update,
    limit: args.limit,
    onProgress: (processed, total) => {
      process.stdout.write(`\r  Writing ${processed}/${total} …`);
      if (processed >= total) process.stdout.write('\r' + ' '.repeat(40) + '\r');
    },
  });

  printSummary(summary);

  if (args.report) {
    const reportPath = path.resolve(process.cwd(), args.reportPath);
    writeFileSync(reportPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`  Full report written to ${args.reportPath}\n`);
  }

  if (summary.errors.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('\n  Import failed:');
  console.error(`  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
