import 'server-only';

import type { SyncSnapshot } from './sync/types';
import { getIntegrationConfig } from './config';
import { getAccessToken, readSheetHeaders, SheetsError, SHEETS_API } from './google-sheets';

/**
 * Write CRM edits back to the Google Sheet.
 *
 * Only possible with service-account auth: a Google API key grants read-only
 * access to public sheets and can never write. The service account must also be
 * shared on the sheet as **Editor**, not Viewer.
 *
 * Targeting is by `leads.sheet_row_number`, captured during sync that is
 * precisely why it is stored. Leads that did not come from the sheet (workbook
 * imports, manual entries) have no row number and are skipped.
 *
 * Called through lib/services/sync, never directly from an action: that is what
 * keeps "push this change outward" one decision rather than one per call site.
 */

/**
 * CRM value -> candidate sheet headers, first match wins.
 *
 * Several candidates per column because the sheet is written by a lead-gen
 * process outside this codebase, and its headers drift ("Follow-up 1",
 * "Followup 1", "Follow Up 1"). Headers are matched case-insensitively after
 * whitespace normalisation. A value whose headers are all absent from the sheet
 * is skipped rather than guessed at **columns are never created**.
 */
interface WritebackColumn {
  key: string;
  headers: string[];
  /** Null clears the cell; undefined means "this lead has nothing to say here". */
  value: (snapshot: SyncSnapshot) => string | null | undefined;
}

const WRITEBACK_COLUMNS: WritebackColumn[] = [
  { key: 'business_name', headers: ['business name'], value: (s) => s.lead.business_name },
  { key: 'website', headers: ['website'], value: (s) => s.lead.website },
  { key: 'email', headers: ['email'], value: (s) => s.lead.email },
  { key: 'phone', headers: ['phone'], value: (s) => s.lead.phone },
  { key: 'city', headers: ['city'], value: (s) => s.lead.city },
  { key: 'country', headers: ['country'], value: (s) => s.lead.country },
  { key: 'niche', headers: ['niche'], value: (s) => s.lead.niche },

  { key: 'research', headers: ['business summary', 'research summary'], value: (s) => s.lead.research_summary },
  { key: 'personalization', headers: ['personalization notes', 'personalization'], value: (s) => s.lead.personalization },
  { key: 'outreach_angle', headers: ['suggested outreach angle', 'outreach angle'], value: (s) => s.lead.outreach_angle },

  {
    key: 'initial_subject',
    headers: ['email header', 'email subject', 'subject line'],
    value: (s) => s.activeDrafts.initial?.subject ?? s.lead.subject_line,
  },
  {
    key: 'initial_body',
    headers: ['email body', 'email draft', 'draft email'],
    value: (s) => s.activeDrafts.initial?.content ?? s.lead.draft_email,
  },
  {
    key: 'followup1_subject',
    headers: ['follow-up 1 subject', 'followup 1 subject', 'follow up 1 subject'],
    value: (s) => s.activeDrafts.followup1?.subject,
  },
  {
    key: 'followup1_body',
    headers: ['follow-up 1', 'followup 1', 'follow up 1', 'follow-up 1 body', 'followup email 1'],
    value: (s) => s.activeDrafts.followup1?.content,
  },
  {
    key: 'followup2_subject',
    headers: ['follow-up 2 subject', 'followup 2 subject', 'follow up 2 subject'],
    value: (s) => s.activeDrafts.followup2?.subject,
  },
  {
    key: 'followup2_body',
    headers: ['follow-up 2', 'followup 2', 'follow up 2', 'follow-up 2 body', 'followup email 2'],
    value: (s) => s.activeDrafts.followup2?.content,
  },

  /*
   * Status flags the lead-gen sheet already keeps its own columns for.
   *
   * "Email Data Done" is the upstream pipeline's marker that a draft exists. If
   * an admin writes a draft here for a lead the sheet still thinks is
   * undrafted, the sheet must learn that otherwise the upstream automation
   * happily generates a second one over the top. Writing "Yes" the moment an
   * active initial draft exists is what keeps the two halves in agreement.
   */
  {
    key: 'email_data_done',
    headers: ['email data done', 'email draft done', 'draft done'],
    value: (s) => {
      const draft = s.activeDrafts.initial?.content ?? s.lead.draft_email;
      // undefined, not null, when there is no draft: never overwrite an upstream
      // "Yes" with a blank just because this CRM has not caught up yet.
      return draft && draft.trim() !== '' ? 'Yes' : undefined;
    },
  },
  // "Email draft Status" was removed from the sheet on 2026-08-04 and its
  // mapping is gone from both directions. Nothing read it: whether a draft
  // exists is answered by the draft itself.
  {
    key: 'email_sent_status',
    headers: ['email sent status', 'email status'],
    value: (s) => (s.pipeline?.first_email_sent ? 'Yes' : undefined),
  },
  {
    /*
     * Date Sent is the anchor the whole follow-up schedule hangs off.
     *
     * For emails the upstream pipeline sent, this column is the ONLY record of
     * when it happened — there is no email_logs row — and the sync reads it
     * back into leads.last_contacted_at, which sets first_email_sent and
     * therefore followup1_due. Writing it on every send keeps the sheet and the
     * schedule describing the same day.
     *
     * Date only, not a full timestamp: the importer's normalizer handles
     * YYYY-MM-DD, Excel serials and DD-MM-YYYY, so this round-trips cleanly.
     * An ISO timestamp would not.
     */
    key: 'date_sent',
    headers: ['date sent'],
    value: (s) => (s.pipeline?.first_email_sent ? s.pipeline.first_email_sent.slice(0, 10) : undefined),
  },
  {
    key: 'research_status',
    headers: ['research status'],
    value: (s) => (s.pipeline?.research_complete ? 'Done' : undefined),
  },
  {
    key: 'reply',
    headers: ['reply'],
    value: (s) => (s.pipeline?.replied ? 'Yes' : undefined),
  },

  /*
   * `leads.status` used to be pushed here under 'status' / 'crm status' /
   * 'lead status'. The sheet has none of those columns, so it wrote nowhere —
   * and everything the sheet DOES receive (Email sent status, research status,
   * Date Sent, Reply) is derived from the pipeline just below, which is the
   * record that is actually true. The mapping is gone rather than repointed:
   * the stage is already published on its own line.
   */
  {
    key: 'stage',
    headers: ['stage', 'pipeline stage', 'crm stage'],
    value: (s) => s.pipeline?.current_stage,
  },
  { key: 'next_step', headers: ['next step', 'next action'], value: (s) => s.nextStep },
  { key: 'notes', headers: ['notes', 'internal notes', 'crm notes'], value: (s) => s.lead.notes },
];

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Quote a sheet name for an A1 range; embedded apostrophes are doubled. */
function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export interface WriteBackResult {
  ok: boolean;
  /** False when the lead simply has no sheet origin not an error. */
  attempted: boolean;
  message: string;
  cellsUpdated: number;
}

export async function writeLeadToSheet(snapshot: SyncSnapshot): Promise<WriteBackResult> {
  const { lead } = snapshot;
  const config = await getIntegrationConfig();

  if (!config.sheets.writeBack) {
    return { ok: true, attempted: false, message: 'Write-back is disabled.', cellsUpdated: 0 };
  }
  if (!lead.sheet_row_number) {
    return {
      ok: true,
      attempted: false,
      message: 'This lead did not come from the sheet, so there is no row to update.',
      cellsUpdated: 0,
    };
  }
  if (config.sheets.authMode !== 'service_account') {
    return {
      ok: false,
      attempted: true,
      message:
        'Write-back needs service-account auth. A Google API key is read-only. Switch auth mode and share the sheet with the service account as Editor.',
      cellsUpdated: 0,
    };
  }

  let headers: string[];
  let token: string;
  try {
    headers = await readSheetHeaders();
    token = await getAccessToken();
  } catch (error) {
    return {
      ok: false,
      attempted: true,
      message: error instanceof SheetsError ? error.message : 'Could not reach Google Sheets.',
      cellsUpdated: 0,
    };
  }

  const columnFor = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header && !columnFor.has(header)) columnFor.set(header, index);
  });

  const sheetName = quoteSheetName(config.sheets.sheetName);
  const data: Array<{ range: string; values: string[][] }> = [];

  for (const spec of WRITEBACK_COLUMNS) {
    const header = spec.headers.find((candidate) => columnFor.has(candidate));
    if (header === undefined) continue;
    const column = columnFor.get(header)!;

    const raw = spec.value(snapshot);
    // undefined means "nothing to say" and leaves the cell alone; null means the
    // admin cleared the value in the CRM, which is a deliberate blanking. A
    // follow-up that has never been drafted must not wipe a column somebody
    // filled in by hand upstream.
    if (raw === undefined) continue;
    const value = raw === null ? '' : String(raw);

    data.push({
      range: `${sheetName}!${columnLetter(column)}${lead.sheet_row_number}`,
      values: [[value]],
    });
  }

  if (data.length === 0) {
    return {
      ok: false,
      attempted: true,
      message: 'None of the CRM fields matched a column in the sheet. Check the header row.',
      cellsUpdated: 0,
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${SHEETS_API}/${encodeURIComponent(config.sheets.spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // RAW, not USER_ENTERED: a draft beginning with "=" or "+" must land as
        // text, not be evaluated by Sheets as a formula.
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    return {
      ok: false,
      attempted: true,
      message: 'Could not reach Google Sheets to write the update.',
      cellsUpdated: 0,
    };
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const reason = detail.error?.message ?? response.statusText;
    return {
      ok: false,
      attempted: true,
      message:
        response.status === 403
          ? `Google denied the write (403): ${reason}. Share the sheet with the service account as Editor.`
          : `Google Sheets write failed (${response.status}): ${reason}`,
      cellsUpdated: 0,
    };
  }

  const body = (await response.json().catch(() => ({}))) as { totalUpdatedCells?: number };
  const cells = body.totalUpdatedCells ?? data.length;

  return {
    ok: true,
    attempted: true,
    message: `Row ${lead.sheet_row_number} updated in the sheet (${cells} cell${cells === 1 ? '' : 's'}).`,
    cellsUpdated: cells,
  };
}
