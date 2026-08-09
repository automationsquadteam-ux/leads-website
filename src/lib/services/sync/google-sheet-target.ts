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

  async push(snapshot: SyncSnapshot, fields: SyncField[]) {
    /*
     * The changed fields are passed through, not ignored.
     *
     * The old comment here argued that writing every mapped cell was free
     * because a batchUpdate costs one HTTP call either way. It is not free: a
     * column the CRM holds as NULL is written as an empty string, so editing one
     * note re-stamped a dozen unrelated cells and blanked any that had been
     * filled in by hand upstream. Cost was never the issue — clobbering was.
     */
    const result = await writeLeadToSheet(snapshot, fields);
    return {
      target: this.id,
      attempted: result.attempted,
      ok: result.ok,
      message: result.message,
    };
  }
}
