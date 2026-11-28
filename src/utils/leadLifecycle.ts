import {
  ChannelLead,
  DispatchLogEntry,
  MultiChannelType,
} from '../types';
import {
  canonicalizeLeadName,
  getLocalTodayDateString,
  loadDispatchLog,
  toLocalDateString,
} from './dispatchLog';
import { appendDeletionLog } from './deletionLog';

export const PIPELINE_FREEZE_STORAGE_KEY = 'crm_pipeline_freeze_v1';
export const COMBINED_LEADS_KEY = 'outreach_channel_leads_combined';
export const INSTAGRAM_LEADS_KEY = 'outreach_channel_leads_instagram';
export const BACKSTAGE_LEADS_KEY = 'outreach_backstage_leads_v1';

export { canonicalizeLeadName as normalizeLeadName };

/**
 * Pure local calendar date addition (no circular imports).
 */
export function addLocalDays(dateStr: string, days: number): string {
  const norm = toLocalDateString(dateStr) || getLocalTodayDateString();
  const [y, m, d] = norm.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const ry = dt.getFullYear();
  const rm = String(dt.getMonth() + 1).padStart(2, '0');
  const rd = String(dt.getDate()).padStart(2, '0');
  return `${ry}-${rm}-${rd}`;
}

export function isLocalSunday(dateStr: string): boolean {
  const norm = toLocalDateString(dateStr);
  if (!norm) return false;
  const [y, m, d] = norm.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() === 0;
}

export function isDateFrozenDirect(dateStr: string): boolean {
  const norm = toLocalDateString(dateStr);
  if (!norm) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(PIPELINE_FREEZE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.frozenDates) && parsed.frozenDates.includes(norm)) {
      return true;
    }
    if (parsed?.isFrozen && parsed?.frozenStartDate) {
      const today = getLocalTodayDateString();
      if (norm >= parsed.frozenStartDate && norm <= today) {
        return true;
      }
    }
  } catch {
    // ignore storage errors
  }
  return false;
}

export function isCadenceRestDay(
  dateStr: string,
  customFrozenCheck?: (d: string) => boolean
): boolean {
  const norm = toLocalDateString(dateStr);
  if (!norm) return false;
  if (isLocalSunday(norm)) return true;
  return customFrozenCheck ? customFrozenCheck(norm) : isDateFrozenDirect(norm);
}

/**
 * Shifts any due date landing on a Sunday (Rest Day) or frozen date forward
 * to the next active working calendar day using local calendar math.
 */
export function shiftDueDateOffRestDay(
  dateStr: string,
  customFrozenCheck?: (d: string) => boolean
): string {
  let cursor = toLocalDateString(dateStr) || getLocalTodayDateString();
  let guard = 0;
  while (isCadenceRestDay(cursor, customFrozenCheck) && guard < 31) {
    cursor = addLocalDays(cursor, 1);
    guard++;
  }
  return cursor;
}

/**
 * Advances `cadenceDays` active working days from `startDateStr`,
 * completely skipping Sundays (Rest Days) and any recorded Freeze Days.
 * Example (Day 0 = Wed Nov 11):
 * - Day 4  -> Mon Nov 16 (skips Sun Nov 15)
 * - Day 8  -> Fri Nov 20 (4 active days from Nov 16)
 * - Day 14 -> Fri Nov 27 (skips Sun Nov 22)
 */
export function addCadenceDays(
  startDateStr: string,
  cadenceDays: number,
  customFrozenCheck?: (d: string) => boolean
): string {
  let cursor = toLocalDateString(startDateStr) || getLocalTodayDateString();
  if (cadenceDays <= 0) return cursor;

  let remaining = cadenceDays;
  let guard = 0;
  while (remaining > 0 && guard < 365) {
    cursor = addLocalDays(cursor, 1);
    guard++;
    if (isCadenceRestDay(cursor, customFrozenCheck)) {
      continue;
    }
    remaining--;
  }
  return cursor;
}

/**
 * Walks backwards `cadenceDays` active working days from `targetDateStr`,
 * skipping Sundays and Freeze Days (inverse of addCadenceDays).
 */
export function subtractCadenceDays(
  targetDateStr: string,
  cadenceDays: number,
  customFrozenCheck?: (d: string) => boolean
): string {
  let cursor = toLocalDateString(targetDateStr) || getLocalTodayDateString();
  if (cadenceDays <= 0) return cursor;

  let remaining = cadenceDays;
  let guard = 0;
  while (remaining > 0 && guard < 365) {
    cursor = addLocalDays(cursor, -1);
    guard++;
    if (isCadenceRestDay(cursor, customFrozenCheck)) {
      continue;
    }
    remaining--;
  }
  return cursor;
}

/**
 * Counts the number of active (non-Sunday, non-frozen) cadence days elapsed
 * strictly after `fromDateStr` up to and including `toDateStr`.
 */
export function getCadenceDaysElapsed(
  fromDateStr: string,
  toDateStr: string,
  customFrozenCheck?: (d: string) => boolean
): number {
  const normFrom = toLocalDateString(fromDateStr);
  const normTo = toLocalDateString(toDateStr);
  if (!normFrom || !normTo || normTo <= normFrom) return 0;

  let count = 0;
  let cursor = normFrom;
  let guard = 0;
  while (cursor < normTo && guard < 1000) {
    cursor = addLocalDays(cursor, 1);
    guard++;
    if (isCadenceRestDay(cursor, customFrozenCheck)) {
      continue;
    }
    count++;
  }
  return count;
}

export function hasLeadSentHistory(lead: Partial<ChannelLead>): boolean {
  const rawStatus = String(lead.status || '').trim().toLowerCase();
  const rawLeadStatus = String(lead.leadStatus || '').trim().toLowerCase();
  return Boolean(
    lead.initialSentDate ||
      lead.followup1SentDate ||
      lead.followup2SentDate ||
      lead.followup3SentDate ||
      lead.dispatchedAt ||
      lead.dispatchDate ||
      lead.dmSent ||
      lead.dmSentAt ||
      (lead.lastContactDate && String(lead.lastContactDate).trim()) ||
      rawStatus === 'dispatched' ||
      rawStatus === 'sent' ||
      rawStatus === 'mockup_sent' ||
      rawLeadStatus === 'waiting_reply' ||
      rawLeadStatus === 'seen' ||
      (typeof lead.followupCount === 'number' && lead.followupCount > 0)
  );
}

function readStoredLeadsArray(storageKey: string): ChannelLead[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const RESERVED_IG_SEGMENTS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'tv',
  'accounts',
  'direct',
  'about',
  'legal',
  'developer',
  'privacy',
]);

/**
 * Extracts the exact Instagram handle/username (lowercased) from an Instagram URL or @handle,
 * stripping out trailing URL parameters (e.g. ?fbclid=..., ?igsh=...) and path suffixes (e.g. /reels/).
 */
export function extractInstagramHandle(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const input = rawUrl.trim();
  if (!input) return '';

  if (/^mailto:/i.test(input)) return '';
  // Ignore email addresses (contain @ after local part, not an Instagram URL or leading @handle)
  if (
    /^[^/@\s]+@[^/@\s]+\.[^/@\s]+$/.test(input) ||
    (!/^@/.test(input) && !/(?:instagram\.com|instagr\.am)/i.test(input))
  ) {
    return '';
  }

  // Direct @username handle
  if (/^@/.test(input)) {
    const clean = input.slice(1).split(/[/?#]/)[0].trim().toLowerCase();
    return clean && !RESERVED_IG_SEGMENTS.has(clean) ? clean : '';
  }

  // Instagram URL (with or without protocol)
  if (!/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)(?:\/|$)/i.test(input)) {
    return '';
  }

  const withProto = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const parsed = new URL(withProto);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '';
    const username = segments[0].replace(/^@/, '').trim().toLowerCase();
    if (!username || RESERVED_IG_SEGMENTS.has(username)) return '';
    return username;
  } catch {
    const afterDomain = input
      .replace(/^https?:\/\//i, '')
      .replace(/^(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am)\/?/i, '')
      .split(/[?#]/)[0];
    const username =
      afterDomain.split('/').filter(Boolean)[0]?.replace(/^@/, '').trim().toLowerCase() || '';
    if (!username || RESERVED_IG_SEGMENTS.has(username)) return '';
    return username;
  }
}

export interface DuplicateGuardCandidate {
  name?: string;
  city?: string;
  location?: string;
  link?: string;
  platformLink?: string;
  profileLink?: string;
  email?: string;
  facebook?: string;
  instagram?: string;
  rawDetails?: Record<string, any>;
}

function getLeadInstagramHandle(lead: DuplicateGuardCandidate): string {
  const urlCandidates = [
    lead.instagram,
    lead.rawDetails?.instagram,
    lead.rawDetails?.Instagram,
    lead.rawDetails?.instagramUrl,
    lead.rawDetails?.instagram_url,
    lead.rawDetails?.instagramLink,
    lead.rawDetails?.instagram_link,
    lead.rawDetails?.instagramHandle,
    lead.rawDetails?.instagram_handle,
    lead.rawDetails?.ig,
    lead.rawDetails?.igHandle,
    lead.rawDetails?.ig_handle,
    lead.rawDetails?.socialLinks?.instagram,
    lead.platformLink,
    lead.link,
    lead.profileLink,
  ];

  for (const val of urlCandidates) {
    if (typeof val !== 'string' || !val.trim()) continue;
    const handle = extractInstagramHandle(val);
    if (handle) return handle;
  }

  // Support plain username in an explicit Instagram field (without URL or @)
  const explicitFields = [
    lead.instagram,
    lead.rawDetails?.instagram,
    lead.rawDetails?.instagramHandle,
    lead.rawDetails?.instagram_handle,
    lead.rawDetails?.igHandle,
    lead.rawDetails?.ig_handle,
  ];
  for (const rawField of explicitFields) {
    if (typeof rawField !== 'string') continue;
    const trimmed = rawField.trim().replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9._]{2,}$/.test(trimmed) && !RESERVED_IG_SEGMENTS.has(trimmed)) {
      return trimmed;
    }
  }

  return '';
}

function normalizeExactValue(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

function getLeadLocationCity(lead: DuplicateGuardCandidate): string {
  const candidates = [
    lead.city,
    lead.location,
    lead.rawDetails?.city,
    lead.rawDetails?.City,
    lead.rawDetails?.location,
    lead.rawDetails?.Location,
    lead.rawDetails?.market,
    lead.rawDetails?.Market,
  ];
  for (const val of candidates) {
    const norm = normalizeExactValue(val);
    if (norm) return norm;
  }
  return '';
}

/**
 * Strict Duplicate Guard matcher:
 * 1. If both leads have an extracted Instagram handle, match ONLY on exact Instagram handle (case-insensitive).
 * 2. If an Instagram URL/handle is missing, ONLY flag as duplicate if EXACT Business Name AND EXACT Location/City match.
 * 3. No .includes(), .startsWith(), or fuzzy regex matching on business names.
 */
function isDuplicateByStrictGuard(
  candidate: DuplicateGuardCandidate,
  existing: DuplicateGuardCandidate
): boolean {
  const candidateIg = getLeadInstagramHandle(candidate);
  const existingIg = getLeadInstagramHandle(existing);

  if (candidateIg && existingIg) {
    return candidateIg === existingIg;
  }

  const candidateName = normalizeExactValue(candidate.name);
  const existingName = normalizeExactValue(existing.name);
  const candidateCity = getLeadLocationCity(candidate);
  const existingCity = getLeadLocationCity(existing);

  return Boolean(
    candidateName &&
      existingName &&
      candidateName === existingName &&
      candidateCity &&
      existingCity &&
      candidateCity === existingCity
  );
}

export interface DuplicateMatchResult {
  hasMatch: boolean;
  activeMatches: ChannelLead[];
  backstageMatches: ChannelLead[];
  dispatchMatches: DispatchLogEntry[];
  bestMatch?: ChannelLead;
  summaryReason?: string;
}

/**
 * Checks Duplicate Guard across:
 * 1. Active Combined + Instagram leads
 * 2. Archived Backstage leads
 * 3. Immutable 'ridge_dispatch_log' history
 */
export function findNormalizedDuplicateMatches(
  candidate: DuplicateGuardCandidate,
  options?: {
    excludeLeadId?: string;
    activeCombined?: ChannelLead[];
    activeInstagram?: ChannelLead[];
    backstageLeads?: ChannelLead[];
  }
): DuplicateMatchResult {
  const combined =
    options?.activeCombined ??
    readStoredLeadsArray(COMBINED_LEADS_KEY).filter((l) => !l?.isArchived);
  const instagram =
    options?.activeInstagram ??
    readStoredLeadsArray(INSTAGRAM_LEADS_KEY).filter((l) => !l?.isArchived);
  const backstage =
    options?.backstageLeads ?? readStoredLeadsArray(BACKSTAGE_LEADS_KEY);

  const isMatch = (lead: ChannelLead): boolean => {
    if (options?.excludeLeadId && lead.id === options.excludeLeadId) return false;
    return isDuplicateByStrictGuard(candidate, lead);
  };

  const activeMatches = [...combined, ...instagram].filter(isMatch);
  const backstageMatches = backstage.filter(isMatch);

  // Build lookup of known lead metadata by leadId so older dispatch entries without city/ig can still resolve accurately
  const leadById = new Map<string, ChannelLead>();
  for (const l of [...combined, ...instagram, ...backstage]) {
    if (l?.id) leadById.set(l.id, l);
  }

  const dispatchMatches = loadDispatchLog().filter((entry) => {
    if (options?.excludeLeadId && entry.leadId === options.excludeLeadId) return false;
    const linkedLead = leadById.get(entry.leadId);
    return isDuplicateByStrictGuard(candidate, {
      name: entry.leadName,
      city: entry.city || linkedLead?.city || linkedLead?.rawDetails?.city || linkedLead?.rawDetails?.location,
      instagram: entry.instagram || linkedLead?.instagram || linkedLead?.rawDetails?.instagram,
      link: entry.link || linkedLead?.platformLink || linkedLead?.link,
      platformLink: entry.link || linkedLead?.platformLink || linkedLead?.link,
      rawDetails: linkedLead?.rawDetails,
    });
  });

  const hasMatch =
    activeMatches.length > 0 ||
    backstageMatches.length > 0 ||
    dispatchMatches.length > 0;

  let summaryReason: string | undefined;
  const candidateIg = getLeadInstagramHandle(candidate);
  if (activeMatches.length > 0) {
    const m = activeMatches[0];
    const reasonTag = candidateIg && getLeadInstagramHandle(m) === candidateIg ? `@${candidateIg}` : `${m.name}`;
    summaryReason = `Matches active lead ${m.id} (${reasonTag}) in ${m.channel === 'instagram' ? 'Instagram' : 'Combined'}`;
  } else if (backstageMatches.length > 0) {
    const m = backstageMatches[0];
    const reasonTag = candidateIg && getLeadInstagramHandle(m) === candidateIg ? `@${candidateIg}` : `${m.name}`;
    summaryReason = `Matches archived lead ${m.id} (${reasonTag}) in Backstage`;
  } else if (dispatchMatches.length > 0) {
    const latest = dispatchMatches[dispatchMatches.length - 1];
    summaryReason = `Previously dispatched as "${latest.leadName}" (${latest.step} on ${latest.localDate})`;
  }

  return {
    hasMatch,
    activeMatches,
    backstageMatches,
    dispatchMatches,
    bestMatch: activeMatches[0] || backstageMatches[0],
    summaryReason,
  };
}

/**
 * Safely merges incoming metadata into an existing lead WITHOUT resetting sent dates
 * or wiping sequence history.
 */
export function mergeLeadIntoExisting(
  existing: ChannelLead,
  incoming: Partial<ChannelLead>
): ChannelLead {
  return {
    ...existing,
    email: existing.email || incoming.email,
    facebook: existing.facebook || incoming.facebook,
    instagram: existing.instagram || incoming.instagram,
    city: existing.city || incoming.city,
    prompt: existing.prompt || incoming.prompt,
    leadAnalysis: existing.leadAnalysis || incoming.leadAnalysis,
    notes: existing.notes || incoming.notes,
    rawDetails: existing.rawDetails || incoming.rawDetails,
    // Explicitly preserve all historical outreach progress:
    initialSentDate: existing.initialSentDate,
    followup1Date: existing.followup1Date,
    followup2Date: existing.followup2Date,
    followup3Date: existing.followup3Date,
    followup1SentDate: existing.followup1SentDate,
    followup2SentDate: existing.followup2SentDate,
    followup3SentDate: existing.followup3SentDate,
    followupCount: existing.followupCount,
    dispatchedAt: existing.dispatchedAt,
    dispatchDate: existing.dispatchDate,
    dmSent: existing.dmSent,
    dmSentAt: existing.dmSentAt,
    isArchived: false,
    lifecycle: 'active',
    cadenceStatus:
      existing.cadenceStatus === 'cancelled'
        ? existing.cadenceStatus
        : existing.isCompleted || existing.leadStatus === 'replied'
        ? 'completed'
        : 'running',
    possibleDuplicateOf: undefined,
  };
}

export interface OrphanedCadenceItem {
  lead: ChannelLead;
  dueStep: 'D4' | 'D8' | 'D14';
  dueDate: string;
  daysUntilDue: number;
}

/**
 * Finds archived leads in Backstage whose cadence is still 'running' and whose next
 * follow-up (D4, D8, or D14) is due today, overdue, or within the next 7 days.
 */
export function getOrphanedCadences(
  referenceDateStr = getLocalTodayDateString(),
  providedBackstage?: ChannelLead[]
): OrphanedCadenceItem[] {
  const today = toLocalDateString(referenceDateStr) || getLocalTodayDateString();
  const horizon = addLocalDays(today, 7);
  const backstage = providedBackstage ?? readStoredLeadsArray(BACKSTAGE_LEADS_KEY);
  const items: OrphanedCadenceItem[] = [];

  const [ty, tm, td] = today.split('-').map(Number);
  const todayMs = new Date(ty, tm - 1, td).getTime();

  for (const lead of backstage) {
    if (!lead || lead.cadenceStatus === 'cancelled' || lead.cadenceStatus === 'completed') {
      continue;
    }
    if (lead.isCompleted || lead.leadStatus === 'replied' || lead.leadStatus === 'completed') {
      continue;
    }
    if (!hasLeadSentHistory(lead)) continue;

    // Effective cadenceStatus for archived sent leads is 'running' unless cancelled
    if (lead.cadenceStatus && lead.cadenceStatus !== 'running') continue;

    let fuCount =
      typeof lead.followupCount === 'number' && !Number.isNaN(lead.followupCount)
        ? lead.followupCount
        : 0;
    if (lead.followup3SentDate) fuCount = Math.max(fuCount, 3);
    else if (lead.followup2SentDate) fuCount = Math.max(fuCount, 2);
    else if (lead.followup1SentDate) fuCount = Math.max(fuCount, 1);
    if (fuCount >= 3) continue;

    const effectiveInitial =
      toLocalDateString(lead.initialSentDate) ||
      (fuCount > 0
        ? toLocalDateString(lead.dmSentAt) ||
          (lead.followup1SentDate ? subtractCadenceDays(lead.followup1SentDate, 4) : null) ||
          (lead.followup2SentDate ? subtractCadenceDays(lead.followup2SentDate, 8) : null) ||
          toLocalDateString(lead.dispatchDate) ||
          toLocalDateString(lead.dispatchedAt)
        : toLocalDateString(lead.dispatchDate) ||
          toLocalDateString(lead.dmSentAt) ||
          toLocalDateString(lead.dispatchedAt)) ||
      today;

    const daysElapsed = getCadenceDaysElapsed(effectiveInitial, today);

    let dueStep: 'D4' | 'D8' | 'D14' | null = null;
    let rawDue: string | undefined;

    if ((daysElapsed >= 14 && fuCount <= 2) || fuCount === 2) {
      dueStep = 'D14';
      rawDue = lead.followup3Date || addCadenceDays(effectiveInitial, 14);
    } else if ((daysElapsed >= 8 && fuCount <= 1) || fuCount === 1) {
      dueStep = 'D8';
      rawDue = lead.followup2Date || addCadenceDays(effectiveInitial, 8);
    } else {
      dueStep = 'D4';
      rawDue = lead.followup1Date || addCadenceDays(effectiveInitial, 4);
    }

    if (!dueStep || !rawDue) continue;
    const dueDate = toLocalDateString(rawDue);
    if (!dueDate || dueDate > horizon) continue;

    const [dy, dm, dd] = dueDate.split('-').map(Number);
    const dueMs = new Date(dy, dm - 1, dd).getTime();
    const daysUntilDue = Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));

    items.push({
      lead,
      dueStep,
      dueDate,
      daysUntilDue,
    });
  }

  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Prepares a lead for Archive-First removal with explicit cadence choice ('keep_running' vs 'cancel_cadence').
 */
export function buildArchivedLeadState(
  lead: ChannelLead,
  sourceChannel: MultiChannelType,
  choice: 'keep_running' | 'cancel_cadence',
  cancelReason?: string,
  indexOffset = 0
): ChannelLead {
  const nowIso = new Date().toISOString();
  const normalizedChannel: 'combined' | 'instagram' =
    sourceChannel === 'instagram' ? 'instagram' : 'combined';

  appendDeletionLog({
    leadId: lead.id,
    leadName: lead.name,
    channel: normalizedChannel,
    action: choice === 'cancel_cadence' ? 'cancel_cadence' : 'archive',
    reason: cancelReason,
    hadSentHistory: hasLeadSentHistory(lead),
  });

  const baseArchived: ChannelLead = {
    ...lead,
    isArchived: true,
    lifecycle: 'archived',
    archivedAt: nowIso,
    archivedFromChannel: normalizedChannel,
    archiveUid:
      lead.archiveUid ||
      `${normalizedChannel}_${lead.id}_${Date.now() + indexOffset}_${Math.random().toString(36).slice(2, 7)}`,
  };

  if (choice === 'cancel_cadence') {
    return {
      ...baseArchived,
      cadenceStatus: 'cancelled',
      cancelledReason: cancelReason || 'Cancelled by operator',
      cancelledAt: nowIso,
      scheduledDate: undefined,
    };
  }

  return {
    ...baseArchived,
    cadenceStatus:
      lead.isCompleted || lead.leadStatus === 'replied' || lead.leadStatus === 'completed'
        ? 'completed'
        : 'running',
  };
}

/**
 * Checks if any historical dispatch entries in ridge_dispatch_log already exist for a lead name
 * so re-imports never blindly reset previously sent leads.
 */
export function getHistoricalSentDateForName(name: string): string | null {
  const entries = loadDispatchLog();
  const norm = canonicalizeLeadName(name);
  if (!norm) return null;
  const d0s = entries
    .filter((e) => e.step === 'D0' && canonicalizeLeadName(e.leadName) === norm)
    .sort((a, b) => a.localDate.localeCompare(b.localDate));
  return d0s.length > 0 ? d0s[0].localDate : null;
}
