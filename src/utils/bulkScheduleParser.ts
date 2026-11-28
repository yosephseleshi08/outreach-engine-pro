import * as XLSX from 'xlsx';
import { ChannelLead } from '../types';
import {
  calculateCadenceFollowupDates,
  getLocalTodayStr,
  isEmailOnlyLead,
  normalizeToLocalDateStr,
} from './cadenceEngine';

export interface ParsedScheduleRow {
  rowIndex: number;
  rawId?: string;
  rawName?: string;
  day0: string | null;
  day4: string | null;
  day8: string | null;
  day14: string | null;
}

export interface DetectedColumnMap {
  headerRowIndex: number; // -1 if headerless
  idCol: number;
  nameCol: number;
  day0Col: number;
  day4Col: number;
  day8Col: number;
  day14Col: number;
}

export interface BulkSchedulePreviewRow {
  parsed: ParsedScheduleRow;
  matchedLead: ChannelLead | null;
  matchMethod: 'id' | 'name' | 'unmatched';
  updatedPreview: ChannelLead | null;
}

export interface ParsedWorkbookData {
  sheetNames: string[];
  sheets: Record<string, unknown[][]>;
  defaultSheet: string;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function formatYmd(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1990 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses any Excel serial date number, Date object, or string date directly into an exact
 * YYYY-MM-DD calendar string with zero timezone shift and zero Cadence Engine recalculation.
 */
export function parseSpreadsheetDateCell(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel serial dates for 1990..2100 fall between ~32874 and ~73415
    if (raw >= 20000 && raw <= 90000) {
      const dc = XLSX.SSF.parse_date_code(raw);
      if (dc && dc.y && dc.m && dc.d) {
        return formatYmd(dc.y, dc.m, dc.d);
      }
    }
    return null;
  }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return formatYmd(raw.getFullYear(), raw.getMonth() + 1, raw.getDate());
  }

  const str = String(raw).trim();
  if (!str) return null;

  const lower = str.toLowerCase();
  if (['-', '--', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd'].includes(lower)) {
    return null;
  }

  // Exact YYYY-MM-DD or ISO timestamp ("2026-11-27T00:00:00.000Z" -> "2026-11-27")
  const isoCandidate = str.includes('T') ? str.split('T')[0].trim() : str;
  const isoExact = isoCandidate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoExact) {
    return formatYmd(Number(isoExact[1]), Number(isoExact[2]), Number(isoExact[3]));
  }

  // YYYY-MM-DD HH:mm:ss or YYYY/M/D or YYYY.M.D
  const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s.*)?$/);
  if (ymdMatch) {
    return formatYmd(Number(ymdMatch[1]), Number(ymdMatch[2]), Number(ymdMatch[3]));
  }

  // MM/DD/YYYY or DD/MM/YYYY (4-digit year)
  const slash4Match = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s.*)?$/);
  if (slash4Match) {
    const a = Number(slash4Match[1]);
    const b = Number(slash4Match[2]);
    const y = Number(slash4Match[3]);
    if (a > 12 && b <= 12) {
      return formatYmd(y, b, a);
    }
    return formatYmd(y, a, b);
  }

  // M/D/YY or M-D-YY (2-digit year)
  const slash2Match = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?:\s.*)?$/);
  if (slash2Match) {
    const a = Number(slash2Match[1]);
    const b = Number(slash2Match[2]);
    const yy = Number(slash2Match[3]);
    const y = yy < 70 ? 2000 + yy : 1900 + yy;
    if (a > 12 && b <= 12) {
      return formatYmd(y, b, a);
    }
    return formatYmd(y, a, b);
  }

  // Textual month formats: "Nov 27, 2026", "Fri, Nov 27, 2026", "27-Nov-2026", "27 Nov 2026"
  const monthFirstMatch = str.match(
    /(?:^[a-z]{3,9},?\s+)?([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i
  );
  if (monthFirstMatch) {
    const m = MONTH_NAME_MAP[monthFirstMatch[1].toLowerCase()];
    const d = Number(monthFirstMatch[2]);
    const y = Number(monthFirstMatch[3]);
    if (m) return formatYmd(y, m, d);
  }

  const dayFirstMatch = str.match(
    /^(\d{1,2})[-\s]+([a-z]{3,9})[-\s,]+(\d{4})/i
  );
  if (dayFirstMatch) {
    const d = Number(dayFirstMatch[1]);
    const m = MONTH_NAME_MAP[dayFirstMatch[2].toLowerCase()];
    const y = Number(dayFirstMatch[3]);
    if (m) return formatYmd(y, m, d);
  }

  return normalizeToLocalDateStr(str);
}

/**
 * Extracts raw 2D grid from an Excel workbook buffer, reading raw cell values (`v`) so
 * Excel serial numbers & cached formula outputs (like WORKDAY.INTL) convert directly to exact YYYY-MM-DD.
 */
export function parseWorkbookBuffer(buffer: ArrayBuffer): ParsedWorkbookData {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheets: Record<string, unknown[][]> = {};

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) {
      sheets[name] = [];
      continue;
    }

    const range = XLSX.utils.decode_range(ws['!ref']);
    const grid: unknown[][] = [];

    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: unknown[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) {
          row.push('');
        } else if (cell.t === 'n' && typeof cell.v === 'number') {
          // Preserve serial date number directly for exact calendar conversion
          row.push(cell.v);
        } else if (cell.t === 'd' && cell.v instanceof Date) {
          row.push(cell.v);
        } else if (cell.v !== undefined && cell.v !== null && cell.v !== '') {
          row.push(cell.v);
        } else {
          row.push(cell.w ?? '');
        }
      }
      grid.push(row);
    }

    sheets[name] = grid;
  }

  let defaultSheet = wb.SheetNames[0] || '';
  for (const name of wb.SheetNames) {
    const rows = sheets[name];
    if (!rows || rows.length === 0) continue;
    const cols = detectScheduleColumns(rows);
    if (
      cols.day0Col !== -1 ||
      cols.day4Col !== -1 ||
      cols.day8Col !== -1 ||
      cols.day14Col !== -1
    ) {
      defaultSheet = name;
      break;
    }
  }

  return {
    sheetNames: wb.SheetNames,
    sheets,
    defaultSheet,
  };
}

/**
 * Parses CSV / TSV / Excel copy-pasted text into a 2D array.
 */
export function parseDelimitedScheduleText(text: string): unknown[][] {
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!trimmed) return [];

  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  // Prefer tab delimiter when pasted straight from Excel / Google Sheets
  const firstSample = lines.slice(0, 5).join('\n');
  const delimiter = firstSample.includes('\t')
    ? '\t'
    : firstSample.includes(';') && !firstSample.includes(',')
    ? ';'
    : ',';

  const parseLine = (line: string): string[] => {
    if (delimiter === '\t') {
      return line.split('\t').map((cell) => cell.trim());
    }
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
  };

  return lines.map(parseLine);
}

function normalizeHeaderToken(val: unknown): string {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:()./]+/g, '');
}

type HeaderRole = 'id' | 'name' | 'day0' | 'day4' | 'day8' | 'day14';

function classifyHeaderCell(val: unknown): HeaderRole | null {
  const rawLower = String(val ?? '').trim().toLowerCase();
  const token = normalizeHeaderToken(val);
  if (!token) return null;

  // Lead ID
  if (
    token === 'id' ||
    token === 'leadid' ||
    token === 'crmid' ||
    token === 'leadcode' ||
    token === 'code' ||
    token === '#'
  ) {
    return 'id';
  }

  // Lead / Prospect Name
  if (
    token === 'name' ||
    token === 'leadname' ||
    token === 'prospect' ||
    token === 'prospectname' ||
    token === 'restaurant' ||
    token === 'restaurantname' ||
    token === 'business' ||
    token === 'businessname' ||
    token === 'company' ||
    token === 'lead'
  ) {
    return 'name';
  }

  // Exact Day 14 (check before Day 4 / Day 1 to avoid prefix collisions)
  if (
    token === 'day14' ||
    token === 'day14date' ||
    token === 'd14' ||
    token === 'd14date' ||
    token === 'followup3' ||
    token === 'followup3date' ||
    token === 'fu3' ||
    token === 'f3' ||
    token === 'breakup' ||
    token === 'breakupdate' ||
    token === 'day14breakup' ||
    /^day\s*14\b/.test(rawLower) ||
    /^d14\b/.test(rawLower)
  ) {
    return 'day14';
  }

  // Exact Day 8
  if (
    token === 'day8' ||
    token === 'day8date' ||
    token === 'd8' ||
    token === 'd8date' ||
    token === 'followup2' ||
    token === 'followup2date' ||
    token === 'fu2' ||
    token === 'f2' ||
    token === 'day8followup' ||
    /^day\s*8\b/.test(rawLower) ||
    /^d8\b/.test(rawLower)
  ) {
    return 'day8';
  }

  // Exact Day 4
  if (
    token === 'day4' ||
    token === 'day4date' ||
    token === 'd4' ||
    token === 'd4date' ||
    token === 'followup1' ||
    token === 'followup1date' ||
    token === 'fu1' ||
    token === 'f1' ||
    token === 'day4followup' ||
    /^day\s*4\b/.test(rawLower) ||
    /^d4\b/.test(rawLower)
  ) {
    return 'day4';
  }

  // Exact Day 0
  if (
    token === 'day0' ||
    token === 'day0date' ||
    token === 'd0' ||
    token === 'd0date' ||
    token === 'initial' ||
    token === 'initialdate' ||
    token === 'initialsent' ||
    token === 'initialsentdate' ||
    token === 'scheduleddate' ||
    token === 'scheduled' ||
    token === 'startdate' ||
    token === 'day0initial' ||
    /^day\s*0\b/.test(rawLower) ||
    /^d0\b/.test(rawLower)
  ) {
    return 'day0';
  }

  return null;
}

/**
 * Scans top rows for explicit column headers (`Lead ID`, `Name`, `Day 0`, `Day 4`, `Day 8`, `Day 14`).
 * Falls back to positional detection if pasted data has no header row.
 */
export function detectScheduleColumns(rows: unknown[][]): DetectedColumnMap {
  let bestRowIndex = -1;
  let bestScore = 0;
  let bestMap: DetectedColumnMap = {
    headerRowIndex: -1,
    idCol: -1,
    nameCol: -1,
    day0Col: -1,
    day4Col: -1,
    day8Col: -1,
    day14Col: -1,
  };

  const scanLimit = Math.min(rows.length, 15);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;

    const candidate: DetectedColumnMap = {
      headerRowIndex: r,
      idCol: -1,
      nameCol: -1,
      day0Col: -1,
      day4Col: -1,
      day8Col: -1,
      day14Col: -1,
    };

    let dateHeaderHits = 0;
    let totalHits = 0;

    for (let c = 0; c < row.length; c++) {
      const role = classifyHeaderCell(row[c]);
      if (!role) continue;
      if (role === 'id' && candidate.idCol === -1) {
        candidate.idCol = c;
        totalHits++;
      } else if (role === 'name' && candidate.nameCol === -1) {
        candidate.nameCol = c;
        totalHits++;
      } else if (role === 'day0' && candidate.day0Col === -1) {
        candidate.day0Col = c;
        dateHeaderHits++;
        totalHits++;
      } else if (role === 'day4' && candidate.day4Col === -1) {
        candidate.day4Col = c;
        dateHeaderHits++;
        totalHits++;
      } else if (role === 'day8' && candidate.day8Col === -1) {
        candidate.day8Col = c;
        dateHeaderHits++;
        totalHits++;
      } else if (role === 'day14' && candidate.day14Col === -1) {
        candidate.day14Col = c;
        dateHeaderHits++;
        totalHits++;
      }
    }

    const score = dateHeaderHits * 3 + totalHits;
    if (dateHeaderHits >= 1 && score > bestScore) {
      bestScore = score;
      bestRowIndex = r;
      bestMap = candidate;
    }
  }

  if (bestRowIndex !== -1) {
    return bestMap;
  }

  // Fallback: Headerless rows (detect ID column + up to 4 date columns in order)
  const firstDataRow = rows.find((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== ''));
  if (!firstDataRow) return bestMap;

  const dateCols: number[] = [];
  let idCol = -1;
  let nameCol = -1;

  for (let c = 0; c < firstDataRow.length; c++) {
    const val = firstDataRow[c];
    const parsedDate = parseSpreadsheetDateCell(val);
    if (parsedDate) {
      dateCols.push(c);
      continue;
    }
    const str = String(val ?? '').trim();
    if (!str) continue;
    if (idCol === -1 && /^(?:ig|cm|fb|em)-?\d+$/i.test(str)) {
      idCol = c;
    } else if (nameCol === -1) {
      nameCol = c;
    }
  }

  if (idCol === -1 && nameCol !== -1) {
    idCol = nameCol;
    nameCol = -1;
  }

  return {
    headerRowIndex: -1,
    idCol,
    nameCol,
    day0Col: dateCols[0] ?? -1,
    day4Col: dateCols[1] ?? -1,
    day8Col: dateCols[2] ?? -1,
    day14Col: dateCols[3] ?? -1,
  };
}

export function extractScheduleRows(
  rows: unknown[][],
  colMap: DetectedColumnMap
): ParsedScheduleRow[] {
  const startRow = colMap.headerRowIndex >= 0 ? colMap.headerRowIndex + 1 : 0;
  const result: ParsedScheduleRow[] = [];

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    const rawId = colMap.idCol >= 0 ? String(row[colMap.idCol] ?? '').trim() : undefined;
    const rawName = colMap.nameCol >= 0 ? String(row[colMap.nameCol] ?? '').trim() : undefined;

    const day0 = colMap.day0Col >= 0 ? parseSpreadsheetDateCell(row[colMap.day0Col]) : null;
    const day4 = colMap.day4Col >= 0 ? parseSpreadsheetDateCell(row[colMap.day4Col]) : null;
    const day8 = colMap.day8Col >= 0 ? parseSpreadsheetDateCell(row[colMap.day8Col]) : null;
    const day14 = colMap.day14Col >= 0 ? parseSpreadsheetDateCell(row[colMap.day14Col]) : null;

    if (!rawId && !rawName) continue;
    if (!day0 && !day4 && !day8 && !day14) continue;

    result.push({
      rowIndex: r + 1,
      rawId: rawId || undefined,
      rawName: rawName || undefined,
      day0,
      day4,
      day8,
      day14,
    });
  }

  return result;
}

function normalizeLookupText(val?: string): string {
  return (val || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findMatchingLead(
  row: ParsedScheduleRow,
  byNormalizedId: Map<string, ChannelLead>,
  byNumericId: Map<number, ChannelLead>,
  byNormalizedName: Map<string, ChannelLead>
): { lead: ChannelLead | null; method: 'id' | 'name' | 'unmatched' } {
  if (row.rawId) {
    const idNorm = row.rawId.trim().toLowerCase();
    const direct = byNormalizedId.get(idNorm);
    if (direct) return { lead: direct, method: 'id' };

    // Also accept compact ID without hyphen (e.g. "IG36" -> "ig-36") or bare numeric ID ("36")
    const compact = idNorm.replace(/[\s_-]+/g, '');
    for (const [key, candidate] of byNormalizedId.entries()) {
      if (key.replace(/[\s_-]+/g, '') === compact) {
        return { lead: candidate, method: 'id' };
      }
    }

    if (/^\d+$/.test(idNorm)) {
      const numMatch = byNumericId.get(parseInt(idNorm, 10));
      if (numMatch) return { lead: numMatch, method: 'id' };
    }

    // Fallback: what if ID column actually holds the lead name?
    const nameViaIdCol = byNormalizedName.get(normalizeLookupText(row.rawId));
    if (nameViaIdCol) return { lead: nameViaIdCol, method: 'name' };
  }

  if (row.rawName) {
    const byName = byNormalizedName.get(normalizeLookupText(row.rawName));
    if (byName) return { lead: byName, method: 'name' };
  }

  return { lead: null, method: 'unmatched' };
}

/**
 * Applies exact Day 0, Day 4, Day 8, and Day 14 dates from a parsed row onto a ChannelLead
 * WITHOUT running Cadence Engine recalculation or Sunday-shifting.
 */
export function applyExactScheduleDatesToLead(
  lead: ChannelLead,
  row: ParsedScheduleRow,
  todayStr = getLocalTodayStr()
): ChannelLead {
  const emailOnly = isEmailOnlyLead(lead);

  if (!row.day0) {
    return {
      ...lead,
      followup1Date: row.day4 ?? lead.followup1Date,
      followup2Date: row.day8 ?? lead.followup2Date,
      followup3Date: row.day14 ?? lead.followup3Date,
      dismissedDate: undefined,
    };
  }

  const day0 = row.day0;
  const recalculated = calculateCadenceFollowupDates(day0);

  // Use explicit spreadsheet follow-up columns if present; otherwise recalculate from new Day 0
  // (4, 8, and 14 working days skipping Sundays and Freeze Days) instead of keeping old stale dates.
  const exactFu1 = row.day4 ?? recalculated.followup1Date;
  const exactFu2 = row.day8 ?? recalculated.followup2Date;
  const exactFu3 = row.day14 ?? recalculated.followup3Date;

  // Past Day 0 -> already sent/dispatched in sequence, preserve exact followup1Date/2Date/3Date
  if (day0 < todayStr) {
    const preservedCompleted =
      lead.cadenceStatus === 'completed' ||
      lead.leadStatus === 'replied' ||
      lead.leadStatus === 'completed' ||
      lead.isCompleted;

    return {
      ...lead,
      initialSentDate: day0,
      dispatchDate: day0,
      dmSent: true,
      dispatchedAt: lead.dispatchedAt || `${day0}T12:00:00`,
      dmSentAt: lead.dmSentAt || `${day0}T12:00:00`,
      status: 'dispatched',
      leadStatus:
        lead.leadStatus === 'replied' || lead.leadStatus === 'completed'
          ? lead.leadStatus
          : lead.isSeen
          ? 'seen'
          : 'waiting_reply',
      cadenceStatus:
        lead.cadenceStatus === 'cancelled'
          ? 'cancelled'
          : preservedCompleted
          ? 'completed'
          : 'running',
      isCompleted: Boolean(preservedCompleted),
      followupCount:
        typeof lead.followupCount === 'number' && !Number.isNaN(lead.followupCount)
          ? lead.followupCount
          : 0,
      followup1Date: exactFu1,
      followup2Date: exactFu2,
      followup3Date: exactFu3,
      warmupStatus: 'warmed',
      isWarmedUp: true,
      warmedUpAt: lead.warmedUpAt || day0,
      scheduledDate: undefined,
      dismissedDate: undefined,
    };
  }

  // Day 0 === today and lead was already marked sent on that exact Day 0: keep sent state & store exact D4/D8/D14
  const existingInitial = normalizeToLocalDateStr(lead.initialSentDate);
  if (day0 === todayStr && lead.dmSent && existingInitial === day0) {
    return {
      ...lead,
      followup1Date: exactFu1,
      followup2Date: exactFu2,
      followup3Date: exactFu3,
      dismissedDate: undefined,
    };
  }

  // Day 0 is today or future (unsent): assign exact scheduledDate + exact D4/D8/D14
  const hasAnySentFollowup = Boolean(
    lead.followup1SentDate || lead.followup2SentDate || lead.followup3SentDate
  );

  if (hasAnySentFollowup) {
    return {
      ...lead,
      scheduledDate: day0,
      followup1Date: exactFu1,
      followup2Date: exactFu2,
      followup3Date: exactFu3,
      dismissedDate: undefined,
    };
  }

  return {
    ...lead,
    scheduledDate: day0,
    initialSentDate: undefined,
    dispatchDate: undefined,
    dmSent: false,
    status: undefined,
    followupCount: 0,
    followup1Date: exactFu1,
    followup2Date: exactFu2,
    followup3Date: exactFu3,
    leadStatus: 'not_sent',
    cadenceStatus: lead.cadenceStatus === 'cancelled' ? 'cancelled' : undefined,
    isCompleted: false,
    warmupStatus: emailOnly ? 'warmed' : (lead.warmupStatus || (lead.isWarmedUp ? 'warmed' : 'locked')),
    isWarmedUp: emailOnly ? true : lead.isWarmedUp,
    dismissedDate: undefined,
  };
}

export function buildBulkSchedulePreview(
  leads: ChannelLead[],
  parsedRows: ParsedScheduleRow[],
  todayStr = getLocalTodayStr()
): {
  previewRows: BulkSchedulePreviewRow[];
  updatedLeads: ChannelLead[];
  matchedCount: number;
  unmatchedCount: number;
} {
  const byNormalizedId = new Map<string, ChannelLead>();
  const byNumericId = new Map<number, ChannelLead>();
  const byNormalizedName = new Map<string, ChannelLead>();

  for (const lead of leads) {
    byNormalizedId.set(String(lead.id || '').trim().toLowerCase(), lead);
    if (typeof lead.numericId === 'number' && Number.isFinite(lead.numericId)) {
      byNumericId.set(lead.numericId, lead);
    } else {
      const m = String(lead.id || '').match(/(\d+)$/);
      if (m) byNumericId.set(parseInt(m[1], 10), lead);
    }
    if (lead.name) {
      byNormalizedName.set(normalizeLookupText(lead.name), lead);
    }
  }

  const updatesByLeadId = new Map<string, ChannelLead>();
  const previewRows: BulkSchedulePreviewRow[] = [];
  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const parsed of parsedRows) {
    const { lead, method } = findMatchingLead(
      parsed,
      byNormalizedId,
      byNumericId,
      byNormalizedName
    );
    if (!lead) {
      unmatchedCount++;
      previewRows.push({
        parsed,
        matchedLead: null,
        matchMethod: 'unmatched',
        updatedPreview: null,
      });
      continue;
    }

    const baseLead = updatesByLeadId.get(lead.id) || lead;
    const nextLead = applyExactScheduleDatesToLead(baseLead, parsed, todayStr);
    updatesByLeadId.set(lead.id, nextLead);
    matchedCount++;

    previewRows.push({
      parsed,
      matchedLead: lead,
      matchMethod: method,
      updatedPreview: nextLead,
    });
  }

  const updatedLeads = leads.map((lead) => updatesByLeadId.get(lead.id) || lead);

  return {
    previewRows,
    updatedLeads,
    matchedCount,
    unmatchedCount,
  };
}
