import { BulkUploadRowDto } from './dto/bulk-upload.dto';

function isNullish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  return lower === 'null' || lower === 'undefined' || lower === 'n/a' || lower === '-';
}

function str(r: Record<string, unknown>, key: string): string {
  return String(r[key] ?? '').trim();
}

function requireString(
  r: Record<string, unknown>,
  key: string,
  label: string,
): string | { error: string } {
  if (isNullish(r[key])) {
    return { error: `${label} is required` };
  }
  const v = str(r, key);
  if (!v) return { error: `${label} is required` };
  return v;
}

function normalizeDateToken(raw: string): string {
  const value = raw.trim();
  if (!value) return value;

  // Already numeric DD-MM-YYYY
  const ddmmyyyy = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    const year = ddmmyyyy[3];
    return `${day}-${month}-${year}`;
  }

  // Convert DD-MMM-YYYY (e.g. 11-feb-2026) to DD-MM-YYYY
  const ddMonYyyy = value.match(/^(\d{1,2})-([a-zA-Z]{3,9})-(\d{4})$/);
  if (!ddMonYyyy) return value;

  const day = ddMonYyyy[1].padStart(2, '0');
  const mon = ddMonYyyy[2].toLowerCase();
  const year = ddMonYyyy[3];

  const monthMap: Record<string, string> = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    sept: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12',
  };

  const month = monthMap[mon];
  if (!month) return value;

  return `${day}-${month}-${year}`;
}

function requirePositiveInt(
  r: Record<string, unknown>,
  key: string,
  label: string,
): number | { error: string } {
  if (isNullish(r[key])) {
    return { error: `${label} is required` };
  }
  const n = Number(r[key]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return { error: `${label} must be a positive integer` };
  }
  return n;
}

export type ParseBulkRowResult =
  | { ok: true; row: BulkUploadRowDto }
  | { ok: false; message: string };

/**
 * Validates one bulk row; `client_name`, `client_id`, and `year` are checked first
 * with explicit errors when null/empty.
 */
export function parseBulkUploadRow(raw: unknown): ParseBulkRowResult {
  let candidate: unknown = raw;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, message: 'Invalid row: expected an object' };
    }
  }

  if (Array.isArray(candidate)) {
    const looksLikeEntries = candidate.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string',
    );
    if (looksLikeEntries) {
      candidate = Object.fromEntries(candidate as [string, unknown][]);
    } else {
      return { ok: false, message: 'Invalid row: expected an object' };
    }
  }

  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    return { ok: false, message: 'Invalid row: expected an object' };
  }

  const r = candidate as Record<string, unknown>;

  if (isNullish(r.client_name)) {
    return { ok: false, message: 'client_name is required' };
  }
  const client_id = requirePositiveInt(r, 'client_id', 'client_id');
  if (typeof client_id === 'object') return { ok: false, message: client_id.error };

  const year = requirePositiveInt(r, 'year', 'year');
  if (typeof year === 'object') return { ok: false, message: year.error };

  const client_name = str(r, 'client_name');
  if (!client_name) {
    return { ok: false, message: 'client_name is required' };
  }

  const login_id = requireString(r, 'login_id', 'login_id');
  if (typeof login_id === 'object') return { ok: false, message: login_id.error };

  const password = requireString(r, 'password', 'password');
  if (typeof password === 'object') return { ok: false, message: password.error };

  const date_from = requireString(r, 'date_from', 'date_from');
  if (typeof date_from === 'object') return { ok: false, message: date_from.error };

  const lead_url = requireString(r, 'lead_url', 'lead_url');
  if (typeof lead_url === 'object') return { ok: false, message: lead_url.error };

  const medium_url = requireString(r, 'medium_url', 'medium_url');
  if (typeof medium_url === 'object') return { ok: false, message: medium_url.error };

  const row: BulkUploadRowDto = {
    login_id,
    password,
    client_name,
    date_from,
    lead_url,
    medium_url,
    client_id,
    year,
  };

  const login_url = str(r, 'login_url');
  if (login_url) row.login_url = login_url;

  const client_source = str(r, 'client_source');
  if (client_source) row.client_source = client_source;

  const date_to = str(r, 'date_to');
  if (date_to) row.date_to = normalizeDateToken(date_to);

  row.date_from = normalizeDateToken(row.date_from);

  return { ok: true, row };
}
