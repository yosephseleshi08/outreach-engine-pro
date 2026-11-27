import { ChannelLead } from '../types';
import {
  addCadenceDays,
  getLocalTodayStr,
  isEmailOnlyLead,
  normalizeToLocalDateStr,
  toCleanDateStr,
} from './cadenceEngine';

export interface BulkScheduleMismatchError {
  rowNumber: number;
  leadId: string;
  uploadedName: string;
  expectedName: string;
  attemptedDate: string;
  message: string;
}

export interface BulkScheduleResult {
  updatedLeads: ChannelLead[];
  scheduledCount: number;
  mismatchErrors: BulkScheduleMismatchError[];
  notFoundCount: number;
  notFoundIds: string[];
  invalidDateCount: number;
  summaryToast: string;
  hasMismatches: boolean;
}

export interface ParsedScheduleRow {
  rowNumber: number;
  leadId: string;
  leadName: string;
  rawDate: unknown;
}

/**
 * Case-insensitive normalization collapsing extra spaces for strict Lead Name comparison.
 */
export function normalizeLeadNameForMatch(name: unknown): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeHeader(header: unknown): string {
  return String(header ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isLeadIdHeader(h: string): boolean {
  return (
    h === 'lead id' ||
    h === 'lead_id' ||
    h === 'leadid' ||
    h === 'id'
  );
}

function isLeadNameHeader(h: string): boolean {
  return (
    h === 'lead name' ||
    h === 'lead_name' ||
    h === 'leadname' ||
    h === 'prospect name' ||
    h === 'prospect_name' ||
    h === 'prospectname' ||
    h === 'business name' ||
    h === 'business_name' ||
    h === 'restaurant name' ||
    h === 'restaurant_name' ||
    h === 'name'
  );
}

/**
 * Strictly matches ONLY the Day 0 column header.
 * Ignores "Scheduled Date", "Day 4", "Day 8", "Day 14", etc.
 */
function isDay0Header(h: string): boolean {
  return (
    h === 'day 0' ||
    h === 'day0' ||
    h === 'day_0' ||
    h === 'day-0' ||
    h === 'd0'
  );
}

function excelSerialToDateStr(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 10000 || serial >= 100000) {
    return null;
  }
  const wholeDays = Math.floor(serial);
  const adjustedDays = wholeDays > 60 ? wholeDays : wholeDays + 1;
  const utcMs = Date.UTC(1899, 11, 30) + adjustedDays * 86400000;
  const d = new Date(utcMs);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parses an Excel date serial, Date object, or string (including "2026-11-11 00:00:00")
 * into clean YYYY-MM-DD local date format by stripping any time component.
 */
export function parseScheduleDateValue(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  // Excel serial date number (e.g. 46337 or 46337.5) -> exact calendar YYYY-MM-DD
  if (typeof rawValue === 'number') {
    return excelSerialToDateStr(rawValue);
  }

  if (rawValue instanceof Date) {
    return normalizeToLocalDateStr(rawValue);
  }

  const str = String(rawValue).trim();
  if (!str) return null;

  // Stringified Excel serial number (e.g. "46337" or "46337.0")
  if (/^\d{5}(?:\.\d+)?$/.test(str)) {
    const parsedSerial = excelSerialToDateStr(Number(str));
    if (parsedSerial) return parsedSerial;
  }

  // Handle formatted weekday strings like "Wed, Nov 24, 2026"
  const withoutWeekday = str.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '').trim();

  // Strip trailing time components (e.g., "2026-11-11 00:00:00", "11/11/2026 00:00:00", "2026-11-11T00:00:00.000Z")
  const strippedTime = withoutWeekday
    .replace(/T.*$/i, '')
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?(?:\s*UTC|[+-]\d{2}:?\d{2})?$/i, '')
    .trim();

  const clean =
    toCleanDateStr(strippedTime) ||
    normalizeToLocalDateStr(strippedTime) ||
    toCleanDateStr(withoutWeekday) ||
    normalizeToLocalDateStr(withoutWeekday) ||
    normalizeToLocalDateStr(str);

  return clean && /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : null;
}

/**
 * Extracts normalized schedule rows from a 2D spreadsheet matrix.
 * Requires Lead ID, Lead Name (or PROSPECT NAME), and ONLY the Day 0 column.
 * Any Day 4 / Day 8 / Day 14 columns in the spreadsheet are ignored.
 */
export function extractScheduleRowsFromMatrix(matrix: unknown[][]): ParsedScheduleRow[] {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error('The uploaded spreadsheet is empty.');
  }

  let headerRowIndex = -1;
  let idCol = -1;
  let nameCol = -1;
  let day0Col = -1;

  let fallbackHeaderRowIndex = -1;
  let fallbackIdCol = -1;
  let fallbackNameCol = -1;
  let fallbackDay0Col = -1;

  const scanLimit = Math.min(matrix.length, 10);
  for (let r = 0; r < scanLimit; r++) {
    const row = matrix[r];
    if (!Array.isArray(row)) continue;

    let foundId = -1;
    let foundName = -1;
    let foundDay0 = -1;

    for (let c = 0; c < row.length; c++) {
      const h = normalizeHeader(row[c]);
      if (!h) continue;
      if (foundId === -1 && isLeadIdHeader(h)) foundId = c;
      else if (foundName === -1 && isLeadNameHeader(h)) foundName = c;
      else if (foundDay0 === -1 && isDay0Header(h)) foundDay0 = c;
    }

    if (foundId !== -1 && foundName !== -1 && foundDay0 !== -1) {
      headerRowIndex = r;
      idCol = foundId;
      nameCol = foundName;
      day0Col = foundDay0;
      break;
    }

    if (
      fallbackHeaderRowIndex === -1 &&
      foundId !== -1 &&
      (foundName !== -1 || foundDay0 !== -1)
    ) {
      fallbackHeaderRowIndex = r;
      fallbackIdCol = foundId;
      fallbackNameCol = foundName;
      fallbackDay0Col = foundDay0;
    }
  }

  if (headerRowIndex === -1 && fallbackHeaderRowIndex !== -1) {
    headerRowIndex = fallbackHeaderRowIndex;
    idCol = fallbackIdCol;
    nameCol = fallbackNameCol;
    day0Col = fallbackDay0Col;
  }

  if (headerRowIndex === -1 || idCol === -1) {
    throw new Error(
      'Missing required "Lead ID" column header. Include columns: Lead ID, Lead Name (or PROSPECT NAME), Day 0.'
    );
  }
  if (nameCol === -1) {
    throw new Error(
      'Missing required "Lead Name" (or "PROSPECT NAME") column header for safety verification.'
    );
  }
  if (day0Col === -1) {
    throw new Error(
      'Missing required "Day 0" column header. Upload a spreadsheet with Lead ID, Lead Name (or PROSPECT NAME), and Day 0.'
    );
  }

  const rows: ParsedScheduleRow[] = [];
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!Array.isArray(row)) continue;

    const rawId = String(row[idCol] ?? '').trim();
    const rawName = String(row[nameCol] ?? '').trim();
    const rawDate = row[day0Col];

    const hasDate = rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== '';
    if (!rawId && !rawName && !hasDate) continue;
    if (!rawId) continue;

    rows.push({
      rowNumber: r + 1,
      leadId: rawId,
      leadName: rawName,
      rawDate,
    });
  }

  return rows;
}

/**
 * Parses an Excel (.xlsx/.xls) or CSV/TSV File into schedule rows.
 */
export async function parseScheduleFile(file: File): Promise<ParsedScheduleRow[]> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv') || lowerName.endsWith('.txt')) {
    const text = await file.text();
    return parseScheduleText(text);
  }

  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('No worksheets found in the uploaded file.');
  }
  const sheet = workbook.Sheets[firstSheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  return extractScheduleRowsFromMatrix(matrix);
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Parses pasted CSV or tab-delimited text into schedule rows.
 */
export function parseScheduleText(text: string): ParsedScheduleRow[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error('Please provide spreadsheet rows to import.');
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('Could not parse spreadsheet rows.');
  }
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const matrix = lines.map((line) => parseDelimitedLine(line, delimiter));
  return extractScheduleRowsFromMatrix(matrix);
}

/**
 * Shared single-lead date assignment rule matching manual Schedule editing:
 * - Past dates write to initialSentDate and generate D4/D8/D14 follow-ups
 * - Today/future dates write to scheduledDate
 * - Empty date clears scheduledDate (and resets unsent cadence if no followup history)
 */
export function applyScheduledDateToLead(
  lead: ChannelLead,
  normalizedDate: string | null,
  todayStr = getLocalTodayStr()
): ChannelLead {
  const emailOnly = isEmailOnlyLead(lead);

  if (!normalizedDate) {
    const hasRecordedFollowups = Boolean(
      lead.followup1SentDate || lead.followup2SentDate || lead.followup3SentDate || lead.repliedAt
    );
    if (hasRecordedFollowups) {
      return {
        ...lead,
        scheduledDate: undefined,
        dismissedDate: undefined,
      };
    }
    return {
      ...lead,
      scheduledDate: undefined,
      initialSentDate: undefined,
      dispatchDate: undefined,
      dmSent: false,
      status: undefined,
      followup1Date: undefined,
      followup2Date: undefined,
      followup3Date: undefined,
      followupCount: 0,
      leadStatus: 'not_sent' as const,
      cadenceStatus: undefined,
      isCompleted: false,
      warmupStatus: emailOnly ? ('warmed' as const) : undefined,
      isWarmedUp: emailOnly ? true : false,
      dismissedDate: undefined,
    };
  }

  // Past date -> Save as initialSentDate so Cadence Engine calculates Day 4 / 8 / 14 from Day 0
  if (normalizedDate < todayStr) {
    return {
      ...lead,
      initialSentDate: normalizedDate,
      dispatchDate: normalizedDate,
      dmSent: true,
      status: 'dispatched' as const,
      leadStatus: lead.isSeen ? ('seen' as const) : ('waiting_reply' as const),
      cadenceStatus: 'running' as const,
      isCompleted: false,
      followupCount:
        typeof lead.followupCount === 'number' && !Number.isNaN(lead.followupCount)
          ? lead.followupCount
          : 0,
      followup1Date: addCadenceDays(normalizedDate, 4),
      followup2Date: addCadenceDays(normalizedDate, 8),
      followup3Date: addCadenceDays(normalizedDate, 14),
      warmupStatus: 'warmed' as const,
      isWarmedUp: true,
      warmedUpAt: lead.warmedUpAt || normalizedDate,
      scheduledDate: undefined,
      dismissedDate: undefined,
    };
  }

  // Today or future date -> Save as scheduledDate
  const existingInitial = normalizeToLocalDateStr(lead.initialSentDate);
  const hasPastInitial = Boolean(existingInitial && existingInitial < todayStr);

  if (hasPastInitial) {
    return {
      ...lead,
      scheduledDate: normalizedDate,
      warmupStatus: 'warmed' as const,
      isWarmedUp: true,
      dismissedDate: undefined,
    };
  }

  return {
    ...lead,
    scheduledDate: normalizedDate,
    warmupStatus: emailOnly
      ? ('warmed' as const)
      : (lead.warmupStatus || (lead.isWarmedUp ? 'warmed' : 'locked')),
    isWarmedUp: emailOnly ? true : lead.isWarmedUp,
    dismissedDate: undefined,
  };
}

function findLeadByUploadedId(
  leads: ChannelLead[],
  rawLeadId: string
): ChannelLead | undefined {
  const trimmed = rawLeadId.trim();
  if (!trimmed) return undefined;

  const upper = trimmed.toUpperCase();
  const exact = leads.find((l) => l.id.trim().toUpperCase() === upper);
  if (exact) return exact;

  // Fallback only when uploaded ID is purely numeric (e.g. "12" matching numericId 12)
  if (/^\d+$/.test(trimmed)) {
    const numeric = parseInt(trimmed, 10);
    return leads.find((l) => l.numericId === numeric);
  }

  return undefined;
}

/**
 * Validates BOTH Lead ID and Lead Name before assigning schedule dates.
 * - ID + Name match (case-insensitive, collapsed spaces): assigns date
 * - ID matches but Name differs: skips row and logs mismatch error
 * - ID not found: skips row
 */
export function applyBulkScheduleWithValidation(
  existingLeads: ChannelLead[],
  rows: ParsedScheduleRow[],
  todayStr = getLocalTodayStr()
): BulkScheduleResult {
  const mismatchErrors: BulkScheduleMismatchError[] = [];
  const notFoundIds: string[] = [];
  let scheduledCount = 0;
  let invalidDateCount = 0;

  // Map lead.id -> validated target date
  const approvedUpdates = new Map<string, string>();

  for (const row of rows) {
    const matchedLead = findLeadByUploadedId(existingLeads, row.leadId);

    // Rule 5: If the ID is not found -> Skip it
    if (!matchedLead) {
      notFoundIds.push(row.leadId);
      continue;
    }

    const uploadedNormName = normalizeLeadNameForMatch(row.leadName);
    const dbNormName = normalizeLeadNameForMatch(matchedLead.name);
    const parsedDate = parseScheduleDateValue(row.rawDate);

    // Rule 2 & 4: Verify Lead Name matches (case-insensitive, ignoring extra spaces)
    if (!uploadedNormName || uploadedNormName !== dbNormName) {
      const errorMsg = `Row ${row.rowNumber} (${matchedLead.id}): Name mismatch — Excel had "${row.leadName || '(empty)'}", CRM has "${matchedLead.name}".`;
      console.error('[BulkScheduleUpload] Validation failed:', errorMsg);
      mismatchErrors.push({
        rowNumber: row.rowNumber,
        leadId: matchedLead.id,
        uploadedName: row.leadName || '(empty)',
        expectedName: matchedLead.name,
        attemptedDate: parsedDate || String(row.rawDate ?? ''),
        message: errorMsg,
      });
      continue;
    }

    if (!parsedDate) {
      invalidDateCount++;
      continue;
    }

    // Rule 3: Perfect ID + Name match -> Approve date assignment
    approvedUpdates.set(matchedLead.id, parsedDate);
  }

  const updatedLeads = existingLeads.map((lead) => {
    const nextDate = approvedUpdates.get(lead.id);
    if (!nextDate) return lead;
    scheduledCount++;
    return applyScheduledDateToLead(lead, nextDate, todayStr);
  });

  const notFoundCount = notFoundIds.length;
  const mismatchCount = mismatchErrors.length;

  let summaryToast: string;
  if (mismatchCount > 0) {
    summaryToast = `${scheduledCount} ${scheduledCount === 1 ? 'lead' : 'leads'} scheduled. ${mismatchCount} failed because the name didn't match the ID.`;
  } else if (notFoundCount > 0) {
    summaryToast = `${scheduledCount} ${scheduledCount === 1 ? 'lead' : 'leads'} scheduled. ${notFoundCount} skipped (ID not found).`;
  } else {
    summaryToast = `${scheduledCount} ${scheduledCount === 1 ? 'lead' : 'leads'} scheduled successfully.`;
  }

  return {
    updatedLeads,
    scheduledCount,
    mismatchErrors,
    notFoundCount,
    notFoundIds,
    invalidDateCount,
    summaryToast,
    hasMismatches: mismatchCount > 0,
  };
}
