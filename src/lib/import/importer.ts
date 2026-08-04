import { randomUUID } from 'node:crypto';

import type { LeadInsert, TablesUpdate } from '@/lib/supabase/database.types';
import type { ServiceClient } from '@/lib/supabase/service-client';
import type { KeyMode } from './dedupe';
import { mapRow, REFRESHABLE_FIELDS, type MappingError } from './mapping';
import { readSheet } from './workbook';

export interface ImportOptions {
  filePath: string;
  sheet: string | number;
  /** Value written to leads.source. Defaults to `<file>:<sheet>`. */
  source?: string;
  keyMode?: KeyMode;
  /** Validate and report without writing anything. */
  dryRun?: boolean;
  /** Refresh REFRESHABLE_FIELDS on leads that already exist. */
  update?: boolean;
  /** Stop after N worksheet rows (debugging). */
  limit?: number;
  batchSize?: number;
  onProgress?: (processed: number, total: number) => void;
}

export interface InvalidRow {
  rowNumber: number;
  businessName: string | null;
  errors: MappingError[];
}

export interface DuplicateRow {
  rowNumber: number;
  businessName: string;
  dedupeKey: string;
  /** Row number of the first occurrence that won. */
  firstSeenAtRow: number;
  firstSeenBusinessName: string;
}

export interface RowWarning {
  rowNumber: number;
  businessName: string | null;
  warning: string;
}

export interface ImportSummary {
  batchId: string;
  file: string;
  sheet: string;
  dryRun: boolean;
  keyMode: KeyMode;

  totalRows: number;
  imported: number;
  skipped: number;
  duplicates: number;
  invalid: number;
  updated: number;

  invalidRows: InvalidRow[];
  duplicateRows: DuplicateRow[];
  warnings: RowWarning[];
  errors: string[];
  durationMs: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Import leads from a worksheet.
 *
 * Idempotency comes from the UNIQUE index on leads.dedupe_key plus an
 * `ON CONFLICT DO NOTHING` insert: re-running imports nothing and reports every
 * row as skipped. Counters are:
 *
 *   imported   inserted on this run
 *   skipped    already present in the database
 *   duplicates a second row in the file resolving to an identity already seen
 *   invalid    failed validation, never sent to the database
 *   updated    existing rows refreshed (only with `update: true`)
 */
export async function importLeads(
  client: ServiceClient | null,
  options: ImportOptions,
): Promise<ImportSummary> {
  const startedAt = Date.now();
  const batchId = randomUUID();
  const importedAt = new Date().toISOString();
  const keyMode: KeyMode = options.keyMode ?? 'email';
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 200;

  if (!dryRun && !client) {
    throw new Error('A Supabase client is required unless dryRun is set.');
  }

  const sheetData = await readSheet(options.filePath, options.sheet);
  const source = options.source ?? `${options.filePath.split(/[\\/]/).pop()}:${sheetData.sheetName}`;

  const summary: ImportSummary = {
    batchId,
    file: options.filePath,
    sheet: sheetData.sheetName,
    dryRun,
    keyMode,
    totalRows: 0,
    imported: 0,
    skipped: 0,
    duplicates: 0,
    invalid: 0,
    updated: 0,
    invalidRows: [],
    duplicateRows: [],
    warnings: [],
    errors: [],
    durationMs: 0,
  };

  const rows = options.limit ? sheetData.rows.slice(0, options.limit) : sheetData.rows;
  summary.totalRows = rows.length;

  // ---------------------------------------------------------------------
  // Pass 1 validate, normalize and de-duplicate within the file itself.
  // ---------------------------------------------------------------------
  const pending = new Map<string, { lead: LeadInsert; rowNumber: number }>();

  for (const { rowNumber, values } of rows) {
    const result = mapRow(values, { source, keyMode, importBatchId: batchId, importedAt });

    if (!result.ok) {
      summary.invalid += 1;
      summary.invalidRows.push({
        rowNumber,
        businessName: result.businessName,
        errors: result.errors,
      });
      continue;
    }

    const { lead, warnings } = result.value;
    for (const warning of warnings) {
      summary.warnings.push({ rowNumber, businessName: lead.business_name, warning });
    }

    const existing = pending.get(lead.dedupe_key);
    if (existing) {
      summary.duplicates += 1;
      summary.duplicateRows.push({
        rowNumber,
        businessName: lead.business_name,
        dedupeKey: lead.dedupe_key,
        firstSeenAtRow: existing.rowNumber,
        firstSeenBusinessName: existing.lead.business_name,
      });
      continue;
    }

    pending.set(lead.dedupe_key, { lead, rowNumber });
  }

  const candidates = [...pending.values()].map((entry) => entry.lead);

  if (dryRun || !client) {
    // Nothing is written, so everything that survived pass 1 would be inserted.
    summary.imported = candidates.length;
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  // ---------------------------------------------------------------------
  // Pass 2 write.
  // ---------------------------------------------------------------------
  let processed = 0;

  for (const batch of chunk(candidates, batchSize)) {
    // ON CONFLICT DO NOTHING ... RETURNING gives back only the rows actually
    // inserted, so inserted/skipped is exact and safe against a concurrent run.
    const { data, error } = await client
      .from('leads')
      .upsert(batch, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('dedupe_key');

    if (error) {
      summary.errors.push(`Insert batch failed (${batch.length} rows): ${error.message}`);
      processed += batch.length;
      options.onProgress?.(processed, candidates.length);
      continue;
    }

    const insertedKeys = new Set((data ?? []).map((r) => r.dedupe_key));
    summary.imported += insertedKeys.size;

    const untouched = batch.filter((lead) => !insertedKeys.has(lead.dedupe_key));
    summary.skipped += untouched.length;

    if (options.update && untouched.length > 0) {
      for (const lead of untouched) {
        const patch: TablesUpdate<'leads'> = {
          import_batch_id: batchId,
          imported_at: importedAt,
        };
        // Field names come from REFRESHABLE_FIELDS, which is constrained to
        // keys of LeadInsert, so the indexed write is sound.
        const writable = patch as Record<string, unknown>;
        for (const field of REFRESHABLE_FIELDS) {
          const value = lead[field];
          // Never blank out a populated column with an empty cell.
          if (value !== null && value !== undefined) writable[field] = value;
        }

        const { error: updateError } = await client
          .from('leads')
          .update(patch)
          .eq('dedupe_key', lead.dedupe_key);

        if (updateError) {
          summary.errors.push(`Update failed for ${lead.dedupe_key}: ${updateError.message}`);
        } else {
          summary.updated += 1;
          summary.skipped -= 1;
        }
      }
    }

    processed += batch.length;
    options.onProgress?.(processed, candidates.length);
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
