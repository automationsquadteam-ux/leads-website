import 'server-only';

import { createSign } from 'node:crypto';

import { getIntegrationConfig } from './config';
import { getSecret } from './secrets';

/**
 * Google Sheets reader.
 *
 * Deliberately avoids the `googleapis` package: that dependency is tens of
 * megabytes for what amounts to one REST call. Service-account auth is a signed
 * JWT exchanged for an access token, which node:crypto does directly.
 *
 * Two auth modes:
 *   api_key          sheet must be shared as "anyone with the link can view"
 *   service_account  sheet shared with the service account's email; works for
 *                    private sheets and is the right choice for production
 */

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Read/write scope, not `.readonly` — the same token is used to push CRM edits
// back to the sheet (see sheet-writer.ts).
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface SheetData {
  /** Normalized header names, in column order. */
  headers: string[];
  /** Each row keyed by normalized header, plus its 1-based sheet row number. */
  rows: Array<{ rowNumber: number; values: Record<string, string> }>;
  totalRows: number;
}

export class SheetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetsError';
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SheetsError('The service account credential is not valid JSON.');
  }

  const account = parsed as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new SheetsError(
      'The service account JSON is missing client_email or private_key. Paste the whole key file.',
    );
  }
  return {
    client_email: account.client_email,
    // JSON-escaped newlines survive a copy/paste into a textarea; normalise them
    // or the PEM parser rejects the key.
    private_key: account.private_key.replace(/\\n/g, '\n'),
  };
}

/** Sign a JWT assertion and exchange it for a short-lived access token. */
async function getServiceAccountToken(rawCredential: string): Promise<string> {
  const account = parseServiceAccount(rawCredential);
  const now = Math.floor(Date.now() / 1000);

  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  let signature: string;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    signature = base64Url(signer.sign(account.private_key));
  } catch {
    throw new SheetsError('Could not sign with the service account private key. Is the key intact?');
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new SheetsError(
      `Google rejected the service account: ${body.error_description ?? response.statusText}`,
    );
  }
  return body.access_token;
}

/** Trim, collapse whitespace and lower-case, matching the workbook importer. */
export function normalizeHeader(header: string): string {
  return header.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Access token for the configured service account.
 *
 * Service-account mode only — an API key cannot authorise a write, which is why
 * write-back requires this path.
 */
export async function getAccessToken(): Promise<string> {
  const credential = await getSecret('sheets.service_account_json');
  if (!credential) {
    throw new SheetsError('No service account JSON is stored. Add it under Settings → Integrations.');
  }
  return getServiceAccountToken(credential);
}

/** Just the header row, normalized — used to map CRM fields onto columns. */
export async function readSheetHeaders(): Promise<string[]> {
  const config = await getIntegrationConfig();
  const { spreadsheetId, sheetName, headerRow, authMode } = config.sheets;

  if (!spreadsheetId.trim()) throw new SheetsError('No Google spreadsheet id configured.');

  const range = encodeURIComponent(`${sheetName}!${headerRow}:${headerRow}`);
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  const headers: Record<string, string> = {};

  if (authMode === 'service_account') {
    headers.Authorization = `Bearer ${await getAccessToken()}`;
  } else {
    const apiKey = await getSecret('sheets.api_key');
    if (!apiKey) throw new SheetsError('No Google API key is stored.');
    params.set('key', apiKey);
  }

  const response = await fetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}?${params}`,
    { headers, signal: AbortSignal.timeout(20_000), cache: 'no-store' },
  );

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new SheetsError(
      `Could not read the header row (${response.status}): ${detail.error?.message ?? response.statusText}`,
    );
  }

  const payload = (await response.json()) as { values?: unknown[][] };
  const row = payload.values?.[0] ?? [];
  return row.map((cell) => normalizeHeader(cell === null || cell === undefined ? '' : String(cell)));
}

/**
 * Read an entire worksheet.
 *
 * Uses the A1 range `'<sheet>'` (whole tab) so no column-count guessing is
 * needed, and requests UNFORMATTED_VALUE so dates arrive as serial numbers that
 * the existing normalizer already understands.
 */
export async function readSheet(): Promise<SheetData> {
  const config = await getIntegrationConfig();
  const { spreadsheetId, sheetName, headerRow, authMode } = config.sheets;

  if (!spreadsheetId.trim()) {
    throw new SheetsError('No Google spreadsheet id configured. Add it under Settings → Integrations.');
  }

  const range = encodeURIComponent(`${sheetName}`);
  const params = new URLSearchParams({
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
    majorDimension: 'ROWS',
  });

  const headers: Record<string, string> = {};

  if (authMode === 'service_account') {
    const credential = await getSecret('sheets.service_account_json');
    if (!credential) {
      throw new SheetsError('Auth mode is service_account but no service account JSON is stored.');
    }
    headers.Authorization = `Bearer ${await getServiceAccountToken(credential)}`;
  } else {
    const apiKey = await getSecret('sheets.api_key');
    if (!apiKey) {
      throw new SheetsError('Auth mode is api_key but no Google API key is stored.');
    }
    params.set('key', apiKey);
  }

  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}?${params}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000), cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SheetsError('Google Sheets did not respond in time.');
    }
    throw new SheetsError('Could not reach the Google Sheets API. Check network connectivity.');
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const reason = detail.error?.message ?? response.statusText;
    if (response.status === 403) {
      throw new SheetsError(
        `Google denied access (403): ${reason}. ` +
          (authMode === 'service_account'
            ? 'Share the sheet with the service account email.'
            : 'For API key auth the sheet must be shared as "anyone with the link can view".'),
      );
    }
    if (response.status === 404) {
      throw new SheetsError(`Spreadsheet or tab not found (404): ${reason}. Check the id and tab name.`);
    }
    throw new SheetsError(`Google Sheets API error ${response.status}: ${reason}`);
  }

  const payload = (await response.json()) as { values?: unknown[][] };
  const grid = payload.values ?? [];

  const headerIndex = Math.max(1, headerRow) - 1;
  const headerCells = grid[headerIndex] ?? [];
  const normalizedHeaders = headerCells.map((cell) =>
    normalizeHeader(cell === null || cell === undefined ? '' : String(cell)),
  );

  if (normalizedHeaders.every((h) => h === '')) {
    throw new SheetsError(
      `Row ${headerRow} of "${sheetName}" is empty — expected column headers there.`,
    );
  }

  const rows: SheetData['rows'] = [];
  for (let i = headerIndex + 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    const values: Record<string, string> = {};
    let hasContent = false;

    normalizedHeaders.forEach((header, column) => {
      if (!header) return;
      const cell = cells[column];
      const text = cell === null || cell === undefined ? '' : String(cell);
      if (text.trim() !== '') hasContent = true;
      values[header] = text;
    });

    // Sheet rows are 1-based and the grid starts at row 1.
    if (hasContent) rows.push({ rowNumber: i + 1, values });
  }

  return {
    headers: normalizedHeaders.filter(Boolean),
    rows,
    totalRows: rows.length,
  };
}

/** Lightweight reachability probe used by the Test Connection button. */
export async function testSheetsConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const data = await readSheet();
    return {
      ok: true,
      message: `Connected. Found ${data.totalRows} data row(s) and ${data.headers.length} column(s).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error reading the sheet.',
    };
  }
}
