import ExcelJS from 'exceljs';

/** A worksheet row keyed by normalized header name. */
export type SheetRow = Record<string, unknown>;

export interface SheetData {
  sheetName: string;
  headers: string[];
  rows: Array<{ rowNumber: number; values: SheetRow }>;
}

/** Headers in the source file carry stray leading spaces and mixed casing. */
export function normalizeHeader(header: string): string {
  return header.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * ExcelJS cell values are a union: primitives, Date, and objects for rich text,
 * hyperlinks, formulas and errors. Flatten to something the mappers can use.
 */
function cellToPrimitive(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('text' in value && value.text !== undefined) {
      return typeof value.text === 'string' ? value.text : String(value.text);
    }
    if ('result' in value) {
      const result = (value as { result?: unknown }).result;
      return result === undefined ? null : result;
    }
    if ('error' in value) return null;
    if ('hyperlink' in value) return (value as { hyperlink?: string }).hyperlink ?? null;
  }

  return String(value);
}

/**
 * Read one worksheet into header-keyed rows.
 *
 * `sheet` accepts a name or a 1-based index. Rows that are entirely empty are
 * dropped here rather than being reported as invalid downstream.
 */
export async function readSheet(filePath: string, sheet: string | number): Promise<SheetData> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet =
    typeof sheet === 'number' ? workbook.worksheets[sheet - 1] : workbook.getWorksheet(sheet);

  if (!worksheet) {
    const available = workbook.worksheets.map((w) => w.name).join(', ');
    throw new Error(`Worksheet ${JSON.stringify(sheet)} not found. Available: ${available}`);
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const raw = cellToPrimitive(cell.value);
    headers[colNumber - 1] = raw === null ? '' : normalizeHeader(String(raw));
  });

  const rows: SheetData['rows'] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const values: SheetRow = {};
    let hasContent = false;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber - 1];
      if (!header) return;

      const value = cellToPrimitive(cell.value);
      if (value !== null && String(value).trim() !== '') hasContent = true;
      values[header] = value;
    });

    if (hasContent) rows.push({ rowNumber, values });
  });

  return { sheetName: worksheet.name, headers: headers.filter(Boolean), rows };
}

/** List worksheet names without reading all the data. */
export async function listSheets(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((w) => w.name);
}
