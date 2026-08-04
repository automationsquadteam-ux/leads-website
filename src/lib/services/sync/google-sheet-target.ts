import 'server-only';

import { getIntegrationConfig } from '../config';
import { writeLeadToSheet } from '../sheet-writer';
import type { SyncField, SyncSnapshot, SyncTarget } from './types';

/**
 * The Google Sheet target.
 *
 * The sheet is the lead-generation side's working document, so pushing CRM
 * edits back is how the two halves stay in agreement. The heavy lifting
 * (header matching, A1 ranges, RAW value input) stays in sheet-writer.ts; this
 * file is only the adapter that makes it look like every other target.
 */
export class GoogleSheetTarget implements SyncTarget {
  id = 'google_sheets';
  label = 'Google Sheet';

  async isEnabled(): Promise<boolean> {
    const config = await getIntegrationConfig();
    return config.sheets.writeBack;
  }

  async push(snapshot: SyncSnapshot, _fields: SyncField[]) {
    // Field-level granularity is ignored on purpose: a batchUpdate of the whole
    // row costs one HTTP call either way, and writing every mapped cell keeps
    // the row internally consistent even when an earlier push failed.
    const result = await writeLeadToSheet(snapshot);
    return {
      target: this.id,
      attempted: result.attempted,
      ok: result.ok,
      message: result.message,
    };
  }
}
