import 'server-only';

import { randomUUID } from 'node:crypto';

import { createServiceClient } from '@/lib/supabase/service-client';
import type { Lead, LeadInsert } from '@/lib/supabase/database.types';
import { mapRow, REFRESHABLE_FIELDS, type MappingError } from '@/lib/import/mapping';
import { getIntegrationConfig } from './config';
import { readSheet, SheetsError } from './google-sheets';

/**
 * Google Sheet -> Supabase sync.
 *
 * The sheet is the ingestion layer: lead generation and enrichment happen
 * upstream and land there. This only mirrors rows into Supabase.
 *
 * Identity, validation and normalization are deliberately NOT reimplemented
 * here they come from src/lib/import, the same code the workbook importer
 * uses. One definition of "which lead is this", so the CLI and the sheet sync
 * can never disagree and produce duplicates of each other's rows.
 *
 * Idempotency rests on the UNIQUE index on leads.dedupe_key:
 *   email:<address>   preferred
 *   site:<host+path>  when there is no usable email
 *   name:<name>|<city> last resort
 *
 * Pure function of (sheet, database) with no scheduling of its own, so a cron
 * job or a route handler can call it exactly as the button does.
 */

export interface InvalidSyncRow {
  rowNumber: number;
  businessName: string | null;
  errors: MappingError[];
}

export interface SyncSummary {
  ok: boolean;
  message: string;
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  invalid: number;
  duplicatesInSheet: number;
  invalidRows: InvalidSyncRow[];
  warnings: string[];
  durationMs: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Has anything the sheet owns actually changed on this lead? */
function diffFields(incoming: LeadInsert, existing: Lead): Partial<LeadInsert> {
  const patch: Record<string, unknown> = {};

  for (const field of REFRESHABLE_FIELDS) {
    const next = incoming[field];
    const current = existing[field as keyof Lead];

    // A blank cell never erases data already in the CRM an operator may have
    // filled it in by hand, and the sheet not knowing about it is not a reason
    // to delete it.
    if (next === null || next === undefined) continue;

    if (field === 'social_links') {
      if (JSON.stringify(next) !== JSON.stringify(current)) patch[field] = next;
      continue;
    }

    if (next !== current) patch[field] = next;
  }

  return patch as Partial<LeadInsert>;
}

export interface SyncOptions {
  /** Refresh leads that already exist. Defaults to the stored setting. */
  updateExisting?: boolean;
  /** Validate and report without writing. */
  dryRun?: boolean;
  triggeredBy?: string;
}

export async function syncFromGoogleSheet(options: SyncOptions = {}): Promise<SyncSummary> {
  const started = Date.now();
  const config = await getIntegrationConfig();
  const updateExisting = options.updateExisting ?? config.sheets.updateExisting;
  const dryRun = options.dryRun ?? false;

  const summary: SyncSummary = {
    ok: false,
    message: '',
    totalRows: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    invalid: 0,
    duplicatesInSheet: 0,
    invalidRows: [],
    warnings: [],
    durationMs: 0,
  };

  let sheet;
  try {
    sheet = await readSheet();
  } catch (error) {
    summary.message =
      error instanceof SheetsError ? error.message : 'Could not read the Google Sheet.';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  summary.totalRows = sheet.totalRows;

  if (sheet.rows.length === 0) {
    summary.ok = true;
    summary.message = 'The sheet has no data rows. Nothing to sync.';
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // ---------------------------------------------------------------------
  // Pass 1 validate and collapse duplicates inside the sheet itself.
  // ---------------------------------------------------------------------
  const batchId = randomUUID();
  const syncedAt = new Date().toISOString();
  const source = `google-sheets:${config.sheets.sheetName}`;

  const candidates = new Map<string, { lead: LeadInsert; rowNumber: number }>();

  for (const { rowNumber, values } of sheet.rows) {
    const result = mapRow(values, {
      source,
      keyMode: 'email',
      importBatchId: batchId,
      importedAt: syncedAt,
    });

    if (!result.ok) {
      summary.invalid += 1;
      summary.invalidRows.push({
        rowNumber,
        businessName: result.businessName,
        errors: result.errors,
      });
      continue;
    }

    for (const warning of result.value.warnings) {
      summary.warnings.push(`Row ${rowNumber}: ${warning}`);
    }

    const lead: LeadInsert = {
      ...result.value.lead,
      sheet_row_number: rowNumber,
      sheet_synced_at: syncedAt,
    };

    if (candidates.has(lead.dedupe_key)) {
      summary.duplicatesInSheet += 1;
      continue;
    }
    candidates.set(lead.dedupe_key, { lead, rowNumber });
  }

  if (dryRun) {
    summary.ok = true;
    summary.imported = candidates.size;
    summary.message = `Dry run: ${candidates.size} row(s) would be processed, nothing was written.`;
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // ---------------------------------------------------------------------
  // Pass 2 look up what already exists, then insert or update.
  // ---------------------------------------------------------------------
  const admin = createServiceClient();
  const keys = [...candidates.keys()];
  const existingByKey = new Map<string, Lead>();

  // Chunked: a single .in() with hundreds of keys builds a URL long enough to
  // be rejected by PostgREST.
  for (const keyChunk of chunk(keys, 200)) {
    const { data, error } = await admin.from('leads').select('*').in('dedupe_key', keyChunk);
    if (error) {
      summary.message = `Could not read existing leads: ${error.message}`;
      summary.durationMs = Date.now() - started;
      return summary;
    }
    for (const lead of data ?? []) existingByKey.set(lead.dedupe_key, lead);
  }

  const toInsert: LeadInsert[] = [];
  const toUpdate: Array<{ id: string; patch: Partial<LeadInsert> }> = [];

  for (const [key, { lead, rowNumber }] of candidates) {
    const existing = existingByKey.get(key);

    if (!existing) {
      toInsert.push(lead);
      continue;
    }

    if (!updateExisting) {
      summary.skipped += 1;
      continue;
    }

    const patch = diffFields(lead, existing);

    // Keep the row pointer current even when no content changed rows move
    // when the sheet is sorted or edited above.
    const rowMoved = existing.sheet_row_number !== rowNumber;
    if (Object.keys(patch).length === 0 && !rowMoved) {
      summary.skipped += 1;
      continue;
    }

    toUpdate.push({
      id: existing.id,
      patch: { ...patch, sheet_row_number: rowNumber, sheet_synced_at: syncedAt },
    });
  }

  // Insert. ON CONFLICT DO NOTHING guards against a concurrent run creating the
  // same key between the read above and this write.
  for (const batch of chunk(toInsert, 200)) {
    const { data, error } = await admin
      .from('leads')
      .upsert(batch, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('dedupe_key');

    if (error) {
      summary.message = `Insert failed: ${error.message}`;
      summary.durationMs = Date.now() - started;
      return summary;
    }

    const insertedCount = (data ?? []).length;
    summary.imported += insertedCount;
    // Anything the database refused was inserted by someone else concurrently.
    summary.skipped += batch.length - insertedCount;
  }

  for (const { id, patch } of toUpdate) {
    const { error } = await admin.from('leads').update(patch).eq('id', id);
    if (error) {
      summary.warnings.push(`Update failed for lead ${id}: ${error.message}`);
      continue;
    }
    summary.updated += 1;
  }

  summary.ok = true;
  summary.message =
    `Synced ${summary.totalRows} row(s): ` +
    `${summary.imported} imported, ${summary.updated} updated, ` +
    `${summary.skipped} unchanged, ${summary.invalid} invalid.`;
  summary.durationMs = Date.now() - started;

  return summary;
}
