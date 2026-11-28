import { InboxLead, MultiChannelType, ChannelLead } from '../types';
import { getNextLeadId, saveChannelLeads, loadChannelLeads, hasSocialWarmupLink } from './channelStorage';
import { getNextAvailableScheduleDate } from './cadenceEngine';
import { getStrictVoiceTypeForId, recalculateAllVoiceTypes } from './voiceTypeEngine';
import { extractInstagramHandle, findNormalizedDuplicateMatches } from './leadLifecycle';
import { saveInboxLeadsToIdb, loadInboxLeadsFromIdb } from './indexedDbVault';

export const INBOX_STORAGE_KEY = 'outreach_engine_lead_inbox_v1';

/**
 * Keeps only lightweight routing/contact metadata from raw imported JSON objects
 * so megabyte-sized scraped payloads never exhaust browser localStorage quota.
 */
export function compactRawDetails(raw: any): Record<string, any> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const compact: Record<string, any> = {};
  const scalarKeys = [
    'instagram',
    'Instagram',
    'ig',
    'instagramUrl',
    'instagram_url',
    'instagramHandle',
    'instagram_handle',
    'ig_handle',
    'facebook',
    'Facebook',
    'facebookUrl',
    'facebook_url',
    'fb',
    'email',
    'Email',
    'emailAddress',
    'email_address',
    'contactEmail',
    'contact_email',
    'city',
    'City',
    'location',
    'Location',
    'market',
    'Market',
    'area',
    'Area',
    'fb_message_restricted',
    'restricted',
  ];

  for (const key of scalarKeys) {
    const val = raw[key];
    if (val !== undefined && val !== null && val !== '') {
      if (typeof val === 'string' && val.length > 500) continue;
      compact[key] = val;
    }
  }

  if (raw.socialLinks && typeof raw.socialLinks === 'object') {
    const sl: Record<string, string> = {};
    if (typeof raw.socialLinks.instagram === 'string' && raw.socialLinks.instagram.trim()) {
      sl.instagram = raw.socialLinks.instagram.trim();
    }
    if (typeof raw.socialLinks.facebook === 'string' && raw.socialLinks.facebook.trim()) {
      sl.facebook = raw.socialLinks.facebook.trim();
    }
    if (typeof raw.socialLinks.email === 'string' && raw.socialLinks.email.trim()) {
      sl.email = raw.socialLinks.email.trim();
    }
    if (Object.keys(sl).length > 0) {
      compact.socialLinks = sl;
    }
  }

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function isEmailAddressLink(val?: string | null): boolean {
  if (!val || typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower.startsWith('mailto:')) return true;
  if (
    lower.includes('instagram.com') ||
    lower.includes('instagr.am') ||
    lower.includes('facebook.com') ||
    lower.includes('fb.com') ||
    lower.includes('fb.me')
  ) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || (s.includes('@') && !s.startsWith('@'));
}

function isInstagramLink(val?: string | null): boolean {
  if (!val || typeof val !== 'string') return false;
  const lower = val.trim().toLowerCase();
  return lower.includes('instagram.com') || lower.includes('instagr.am');
}

function isFacebookLink(val?: string | null): boolean {
  if (!val || typeof val !== 'string') return false;
  const lower = val.trim().toLowerCase();
  return lower.includes('facebook.com') || lower.includes('fb.com') || lower.includes('fb.me');
}

function stripMailtoPrefix(val?: string | null): string {
  if (!val || typeof val !== 'string') return '';
  return val.trim().replace(/^mailto:/i, '').trim();
}

export interface ResolvedInboxRouting {
  platform: 'Instagram' | 'Facebook' | 'Email' | 'Other';
  targetChannel: MultiChannelType;
}

/**
 * Resolves the canonical InboxLead platform and target CRM channel (`combined` vs `instagram`).
 *
 * Priority Order:
 * 1. Explicit `platform` = "Email" or "Facebook" -> `combined` (unless primary link is instagram.com? No, explicit Email/FB routes combined).
 * 2. Primary link (`platformLink` / `profileLink` / `link`) with `mailto:` or an email `@` address -> `combined` (`Email`).
 * 3. Explicit `platform` = "Instagram" -> `instagram`.
 * 4. Missing/unspecified `platform`: check link -> `mailto:`/`@` -> `combined`, `instagram.com` -> `instagram`, `facebook.com` -> `combined`, then fallback contact fields.
 */
export function resolveInboxLeadRouting(input: {
  rawPlatform?: string;
  platform?: InboxLead['platform'] | string;
  platformLink?: string;
  profileLink?: string;
  link?: string;
  email?: string;
  facebook?: string;
  instagram?: string;
  rawDetails?: Record<string, any>;
}): ResolvedInboxRouting {
  const rawPlat = String(input.rawPlatform || '').trim().toLowerCase();
  const primaryLink = String(
    input.platformLink || input.profileLink || input.link || ''
  ).trim();
  const explicitLink = String(input.link || '').trim();

  const rawDetailsEmail = String(
    input.rawDetails?.email ||
      input.rawDetails?.Email ||
      input.rawDetails?.emailAddress ||
      input.rawDetails?.email_address ||
      input.rawDetails?.contactEmail ||
      input.rawDetails?.contact_email ||
      input.rawDetails?.socialLinks?.email ||
      ''
  ).trim();
  const emailCandidate = String(input.email || rawDetailsEmail || '').trim();

  const rawDetailsFb = String(
    input.rawDetails?.facebook ||
      input.rawDetails?.Facebook ||
      input.rawDetails?.facebookUrl ||
      input.rawDetails?.facebook_url ||
      input.rawDetails?.fb ||
      input.rawDetails?.socialLinks?.facebook ||
      ''
  ).trim();
  const fbCandidate = String(input.facebook || rawDetailsFb || '').trim();

  const rawDetailsIg = String(
    input.rawDetails?.instagram ||
      input.rawDetails?.Instagram ||
      input.rawDetails?.instagramUrl ||
      input.rawDetails?.instagram_url ||
      input.rawDetails?.instagramHandle ||
      input.rawDetails?.instagram_handle ||
      input.rawDetails?.ig ||
      input.rawDetails?.socialLinks?.instagram ||
      ''
  ).trim();
  const igCandidate = String(input.instagram || rawDetailsIg || '').trim();

  // 1. Explicit "Email" or "Facebook" platform always routes to combined
  if (rawPlat.includes('email') || rawPlat.includes('mail') || rawPlat === 'combined') {
    return { platform: 'Email', targetChannel: 'combined' };
  }
  if (rawPlat.includes('fb') || rawPlat.includes('face')) {
    return { platform: 'Facebook', targetChannel: 'combined' };
  }

  // 2. Primary link email detection (mailto: or email@domain) MUST route to combined (Email)
  if (isEmailAddressLink(primaryLink) || isEmailAddressLink(explicitLink)) {
    return { platform: 'Email', targetChannel: 'combined' };
  }

  // 3. Explicit "Instagram" platform
  if (rawPlat.includes('ig') || rawPlat.includes('insta')) {
    return { platform: 'Instagram', targetChannel: 'instagram' };
  }

  // 4. Missing/ambiguous platform: inspect link first
  if (isInstagramLink(primaryLink) || isInstagramLink(explicitLink)) {
    return { platform: 'Instagram', targetChannel: 'instagram' };
  }
  if (isFacebookLink(primaryLink) || isFacebookLink(explicitLink)) {
    return { platform: 'Facebook', targetChannel: 'combined' };
  }
  if (primaryLink.startsWith('@') || explicitLink.startsWith('@')) {
    return { platform: 'Instagram', targetChannel: 'instagram' };
  }

  // 5. Fallback to contact fields when link is missing or a generic website URL
  if (emailCandidate && isEmailAddressLink(emailCandidate)) {
    return { platform: 'Email', targetChannel: 'combined' };
  }
  if (fbCandidate) {
    return { platform: 'Facebook', targetChannel: 'combined' };
  }
  if (igCandidate) {
    return { platform: 'Instagram', targetChannel: 'instagram' };
  }

  // 6. Final fallback on stored InboxLead.platform if already classified
  if (input.platform === 'Email') {
    return { platform: 'Email', targetChannel: 'combined' };
  }
  if (input.platform === 'Facebook') {
    return { platform: 'Facebook', targetChannel: 'combined' };
  }
  return { platform: 'Instagram', targetChannel: 'instagram' };
}

function normalizeStoredInboxLead(lead: InboxLead): InboxLead {
  const routing = resolveInboxLeadRouting(lead);
  const link = (lead.platformLink || lead.profileLink || '').trim();
  const clearStaleIgRaw =
    routing.platform !== 'Instagram' &&
    lead.rawPlatform &&
    /ig|insta/i.test(lead.rawPlatform) &&
    isEmailAddressLink(link);
  const cleanEmail =
    lead.email ||
    (isEmailAddressLink(link) ? stripMailtoPrefix(link) : undefined);

  if (
    lead.platform !== routing.platform ||
    clearStaleIgRaw ||
    (cleanEmail && cleanEmail !== lead.email)
  ) {
    return {
      ...lead,
      platform: routing.platform,
      rawPlatform: clearStaleIgRaw ? routing.platform : lead.rawPlatform,
      email: cleanEmail || lead.email,
    };
  }
  return lead;
}

/**
 * Loads pending leads currently sitting in the Lead Inbox from localStorage.
 */
export function loadInboxLeads(): InboxLead[] {
  try {
    const raw = localStorage.getItem(INBOX_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeStoredInboxLead);
      }
    }
  } catch (err) {
    console.error('Failed to load lead inbox from localStorage:', err);
  }
  return [];
}

/**
 * Persists the Inbox leads list with IndexedDB mirroring and quota-safe localStorage compaction
 * so large qualified-leads.json batches never trigger QuotaExceededError.
 */
export function saveInboxLeads(leads: InboxLead[]): void {
  void saveInboxLeadsToIdb(leads);

  const dispatchChanged = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('inbox_leads_changed', { detail: leads }));
    }
  };

  try {
    localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify(leads));
    dispatchChanged();
    return;
  } catch {
    // Fallback 1: compact heavy rawDetails while IndexedDB holds the full payload
    try {
      const compactLeads = leads.map((l) => ({
        ...l,
        rawDetails: compactRawDetails(l.rawDetails),
      }));
      localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify(compactLeads));
      dispatchChanged();
      return;
    } catch {
      // Fallback 2: strip rawDetails & long prompts from localStorage copy (full leads live in IndexedDB)
      try {
        const minimalLeads = leads.map((l) => ({
          ...l,
          rawDetails: undefined,
          prompt: l.prompt && l.prompt.length > 400 ? l.prompt.slice(0, 400) : l.prompt,
        }));
        localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify(minimalLeads));
        dispatchChanged();
        return;
      } catch (finalErr) {
        // Fallback 3: remove stale localStorage key if even minimal copy doesn't fit; IndexedDB still has full inbox
        try {
          localStorage.removeItem(INBOX_STORAGE_KEY);
        } catch {
          // ignore
        }
        console.warn('localStorage full while saving lead inbox; stored safely in IndexedDB:', finalErr);
        dispatchChanged();
      }
    }
  }
}

export async function hydrateInboxLeadsFromIdb(): Promise<InboxLead[] | null> {
  try {
    const idbData = await loadInboxLeadsFromIdb<InboxLead>();
    if (!idbData || !Array.isArray(idbData.leads) || idbData.leads.length === 0) {
      return null;
    }
    const normalizedIdbLeads = idbData.leads.map(normalizeStoredInboxLead);
    const local = loadInboxLeads();
    if (local.length === 0) {
      return normalizedIdbLeads;
    }
    const idbMap = new Map(normalizedIdbLeads.map((l) => [l.id, l]));
    let restored = false;
    const merged = local.map((item) => {
      const full = idbMap.get(item.id);
      if (full && full.prompt && (!item.prompt || full.prompt.length > item.prompt.length)) {
        restored = true;
        return full;
      }
      return item;
    });
    return restored ? merged : null;
  } catch {
    return null;
  }
}

/**
 * Removes a lead from the inbox list by ID.
 */
export function removeInboxLead(id: string): InboxLead[] {
  const current = loadInboxLeads();
  const updated = current.filter((l) => l.id !== id);
  saveInboxLeads(updated);
  return updated;
}

/**
 * Clears all items in the inbox.
 */
export function clearAllInboxLeads(): void {
  saveInboxLeads([]);
}

/**
 * Safely extracts the raw platform link / handle / URL directly from a lead JSON object.
 * CRITICAL RULE:
 * 1. Never mutate, strip underscores, remove special characters, or append words.
 * 2. Return the exact raw value from the JSON.
 * 3. Supports all standard and alternative keys (platformLink, platform_link, Platform Link, handle, etc.).
 * 4. Never lets an empty string "" in one key block finding a valid value in another key.
 */
export function extractRawPlatformLink(it: any): string {
  if (!it || typeof it !== 'object') return '';

  const priorityKeys = [
    'platformLink',
    'platform_link',
    'Platform Link',
    'PlatformLink',
    'profileLink',
    'profile_link',
    'Profile Link',
    'ProfileLink',
    'handle',
    'Handle',
    'instagram_handle',
    'instagramHandle',
    'Instagram Handle',
    'ig_handle',
    'igHandle',
    'IG Handle',
    'url',
    'Url',
    'profileUrl',
    'profile_url',
    'Profile Url',
    'link',
    'Link',
    'instagram',
    'Instagram',
    'facebook',
    'Facebook',
    'email',
    'Email',
  ];

  // Pass 1: Check known keys with non-empty string values
  for (const key of priorityKeys) {
    if (it[key] !== undefined && it[key] !== null) {
      const val = String(it[key]).trim();
      if (val !== '') {
        return val;
      }
    }
  }

  // Pass 2: Case-insensitive and normalized key matching across all object properties
  const objKeys = Object.keys(it);
  for (const priority of priorityKeys) {
    const normPriority = priority.toLowerCase().replace(/[\s_-]+/g, '');
    const matchedKey = objKeys.find(
      (k) => k.toLowerCase().replace(/[\s_-]+/g, '') === normPriority
    );
    if (matchedKey && it[matchedKey] !== undefined && it[matchedKey] !== null) {
      const val = String(it[matchedKey]).trim();
      if (val !== '') {
        return val;
      }
    }
  }

  // Pass 3: Inspect nested objects if present (e.g. it.lead, it.details, it.prospect, it.info)
  const nestedKeys = ['lead', 'details', 'prospect', 'leadDetails', 'info', 'data'];
  for (const nestedKey of nestedKeys) {
    if (it[nestedKey] && typeof it[nestedKey] === 'object') {
      const nestedVal = extractRawPlatformLink(it[nestedKey]);
      if (nestedVal) {
        return nestedVal;
      }
    }
  }

  return '';
}

/**
 * Parses the raw text of qualified-leads.json file generated by Lead Engine.
 * Supports arrays or wrapped objects with flexible key naming.
 */
export function parseQualifiedLeadsJson(jsonText: string): InboxLead[] {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Invalid JSON format. Please ensure qualified-leads.json contains valid JSON syntax.');
  }

  let items: any[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.leads)) {
      items = parsed.leads;
    } else if (Array.isArray(parsed.qualifiedLeads)) {
      items = parsed.qualifiedLeads;
    } else if (Array.isArray(parsed.qualified_leads)) {
      items = parsed.qualified_leads;
    } else if (Array.isArray(parsed.data)) {
      items = parsed.data;
    } else {
      // Single lead object fallback
      items = [parsed];
    }
  }

  const result: InboxLead[] = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') continue;

    const name = String(
      it.name ||
      it.restaurantName ||
      it.businessName ||
      it.business_name ||
      it.leadName ||
      `Lead #${i + 1}`
    ).trim();

    const rawPlatform = String(
      it.platform ||
      it.channel ||
      it.source ||
      it.platformName ||
      ''
    ).trim();

    // Extract raw platformLink without mutation, stripping underscores, or regex replacements
    const rawPlatformLink = extractRawPlatformLink(it);

    // Explicit dual-channel link extraction
    const rawFb = String(
      it.facebook ||
      it.Facebook ||
      it.facebookUrl ||
      it.facebook_url ||
      it.facebookLink ||
      it.facebook_link ||
      it.fb ||
      it.socialLinks?.facebook ||
      (isFacebookLink(rawPlatformLink) ? rawPlatformLink : '')
    ).trim();

    const rawEmail = String(
      it.email ||
      it.Email ||
      it.emailAddress ||
      it.email_address ||
      it.contactEmail ||
      it.contact_email ||
      it.socialLinks?.email ||
      (isEmailAddressLink(rawPlatformLink) ? stripMailtoPrefix(rawPlatformLink) : '')
    ).trim();

    const rawIg = String(
      it.instagram ||
      it.Instagram ||
      it.instagramUrl ||
      it.instagram_url ||
      it.instagramLink ||
      it.instagram_link ||
      it.instagramHandle ||
      it.instagram_handle ||
      it.ig ||
      it.igHandle ||
      it.ig_handle ||
      it.socialLinks?.instagram ||
      (extractInstagramHandle(rawPlatformLink) ? rawPlatformLink : '')
    ).trim();

    const routing = resolveInboxLeadRouting({
      rawPlatform,
      platformLink: rawPlatformLink,
      link: typeof it.link === 'string' ? it.link.trim() : undefined,
      email: rawEmail,
      facebook: rawFb,
      instagram: rawIg,
      rawDetails: it,
    });
    const platform = routing.platform;

    const rawCity = String(
      it.city ||
      it.City ||
      it.location ||
      it.Location ||
      it.market ||
      it.Market ||
      it.area ||
      it.Area ||
      it.lead?.city ||
      it.lead?.location ||
      it.details?.city ||
      it.details?.location ||
      ''
    ).trim();

    const prompt = String(
      it.prompt ||
      it.customPitch ||
      it.pitch ||
      it.pitchHook ||
      it.leadAnalysis ||
      it.outreachPrompt ||
      it.notes ||
      ''
    ).trim();

    result.push({
      id: `inbox-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 8)}`,
      name: name || 'Qualified Prospect',
      platform,
      rawPlatform: rawPlatform || undefined,
      profileLink: rawPlatformLink,
      platformLink: rawPlatformLink,
      instagram: rawIg || undefined,
      facebook: rawFb || undefined,
      email: rawEmail || undefined,
      city: rawCity || undefined,
      location: rawCity || undefined,
      prompt,
      uploadedAt: nowIso,
      rawDetails: compactRawDetails(it),
    });
  }

  return result;
}

/**
 * Accepts an inbox lead:
 * 1. Resolves channel (Instagram or Facebook or Email)
 * 2. Generates ID (e.g. IG-X, FB-Y)
 * 3. Saves prompt into customPitch, prompt, and leadAnalysis
 * 4. Adds lead to CRM channel storage at index 0
 * 5. Removes the lead from inbox
 */
export function acceptInboxLeadIntoCrm(
  lead: InboxLead,
  existingChannelLeads?: {
    combined?: ChannelLead[];
    instagram?: ChannelLead[];
    facebook?: ChannelLead[];
    email?: ChannelLead[];
  }
): {
  targetChannel: MultiChannelType;
  newLead: ChannelLead;
  updatedLeads: ChannelLead[];
  isDuplicate?: boolean;
  duplicateReason?: string;
} {
  const targetChannel: MultiChannelType = resolveInboxLeadRouting(lead).targetChannel;

  // Load existing leads for this channel if not provided
  const currentLeads = existingChannelLeads?.[targetChannel] ?? loadChannelLeads(targetChannel);
  const combinedListForDup = existingChannelLeads?.combined ?? loadChannelLeads('combined');
  const igListForDup = existingChannelLeads?.instagram ?? loadChannelLeads('instagram');

  // CRITICAL RULE: Never modify the platformLink value on import.
  const rawPlatformLink =
    (typeof lead.platformLink === 'string' && lead.platformLink.trim()) ||
    (typeof lead.profileLink === 'string' && lead.profileLink.trim()) ||
    extractRawPlatformLink(lead.rawDetails) ||
    '';

  const storedLink = rawPlatformLink;

  const leadCity =
    (typeof lead.city === 'string' && lead.city.trim()) ||
    (typeof lead.location === 'string' && lead.location.trim()) ||
    (typeof lead.rawDetails?.city === 'string' && lead.rawDetails.city.trim()) ||
    (typeof lead.rawDetails?.location === 'string' && lead.rawDetails.location.trim()) ||
    (typeof lead.rawDetails?.City === 'string' && lead.rawDetails.City.trim()) ||
    (typeof lead.rawDetails?.Location === 'string' && lead.rawDetails.Location.trim()) ||
    '';

  const extractedIg =
    lead.instagram ||
    lead.rawDetails?.instagram ||
    lead.rawDetails?.Instagram ||
    lead.rawDetails?.instagramUrl ||
    lead.rawDetails?.instagram_url ||
    lead.rawDetails?.instagramHandle ||
    lead.rawDetails?.instagram_handle ||
    lead.rawDetails?.socialLinks?.instagram ||
    (extractInstagramHandle(rawPlatformLink) ? rawPlatformLink : undefined);

  // Strict Duplicate Guard across active CRM, Backstage archive, and immutable dispatchLog
  const normalizedMatch = findNormalizedDuplicateMatches(
    {
      name: lead.name,
      city: leadCity,
      link: storedLink,
      platformLink: storedLink,
      email: lead.email,
      facebook: lead.facebook,
      instagram: extractedIg,
      rawDetails: lead.rawDetails,
    },
    {
      activeCombined: combinedListForDup,
      activeInstagram: igListForDup,
    }
  );

  if (normalizedMatch.hasMatch) {
    return {
      targetChannel,
      newLead: normalizedMatch.bestMatch || currentLeads[0],
      updatedLeads: currentLeads,
      isDuplicate: true,
      duplicateReason:
        normalizedMatch.summaryReason ||
        `Matches existing or previously dispatched lead "${lead.name}"`,
    };
  }

  const { id, numericId } = getNextLeadId(targetChannel, currentLeads);
  const nowIso = new Date().toISOString();
  const isFbRestricted = Boolean(lead.rawDetails?.fb_message_restricted || lead.rawDetails?.restricted);

  // Strictly enforce daily quota (IG: 6, Combined: 4) & skip Sunday
  const assignedScheduleDate = getNextAvailableScheduleDate(currentLeads, targetChannel);

  // Dual-channel link extraction (Facebook & Email)
  const extractedFb =
    lead.facebook ||
    lead.rawDetails?.facebook ||
    lead.rawDetails?.Facebook ||
    lead.rawDetails?.facebookUrl ||
    lead.rawDetails?.facebook_url ||
    lead.rawDetails?.fb ||
    lead.rawDetails?.socialLinks?.facebook ||
    (rawPlatformLink.includes('facebook.com') || rawPlatformLink.includes('fb.com') ? rawPlatformLink : undefined);

  const extractedEmail =
    lead.email ||
    lead.rawDetails?.email ||
    lead.rawDetails?.Email ||
    lead.rawDetails?.emailAddress ||
    lead.rawDetails?.contactEmail ||
    lead.rawDetails?.socialLinks?.email ||
    (isEmailAddressLink(rawPlatformLink) ? stripMailtoPrefix(rawPlatformLink) : undefined);

  const emailOnly = !hasSocialWarmupLink({
    channel: targetChannel,
    link: storedLink,
    platformLink: storedLink,
    facebook: extractedFb || undefined,
    rawDetails: lead.rawDetails,
  });

  const newChannelLead: ChannelLead = {
    id,
    numericId,
    name: lead.name,
    link: storedLink,
    platformLink: storedLink,
    instagram: extractedIg || undefined,
    facebook: extractedFb || undefined,
    email: extractedEmail || undefined,
    city: leadCity || undefined,
    channel: targetChannel,
    voiceType: getStrictVoiceTypeForId(numericId, targetChannel),
    isVoiceTypeOverridden: false,
    sortOrder: 0,
    createdAt: nowIso,
    scheduledDate: assignedScheduleDate,
    warmupStatus: emailOnly ? 'warmed' : 'locked',
    isWarmedUp: emailOnly,
    // Save prompt & analysis to lead data as requested (prompts untouched)
    prompt: lead.prompt || undefined,
    leadAnalysis: lead.prompt || undefined,
    analysisSavedAt: lead.prompt ? nowIso : undefined,
    // 4-step sequence messages start empty until operator writes them:
    initialDM: '',
    customPitch: '',
    stagedDmMiniPitch: '',
    followupDM_Day4: '',
    followupDM_Day7: '',
    followup3DM: '',
    followupDM_Day8: '',
    followupDM_Day14: '',
    followup7DM: '',
    breakupDM_Day14: '',
    breakupDM_Day30: '',
    isSequenceConfigured: false,
    rawDetails: compactRawDetails(lead.rawDetails),
  };

  // Prepend new lead at index 0, resequence sort order, and recalculate ALL voice types strictly by ID
  const updatedLeads = recalculateAllVoiceTypes(
    [newChannelLead, ...currentLeads].map((l, index) => ({
      ...l,
      sortOrder: index,
    })),
    targetChannel
  );

  // Save to persistent channel storage
  saveChannelLeads(targetChannel, updatedLeads);

  // Remove from Inbox
  removeInboxLead(lead.id);

  return {
    targetChannel,
    newLead: updatedLeads[0],
    updatedLeads,
    isDuplicate: false,
  };
}

/**
 * Batch Accepts All Pending Leads from Inbox into CRM:
 * 1. Iterates through all inbox leads.
 * 2. Determines target channel ('instagram' or 'combined' for FB/Email).
 * 3. Assigns IDs and auto-scheduled dates based on quotas (IG: 6, Combined: 4) skipping Sundays.
 * 4. Checks duplicates to avoid duplicating any lead already in pipeline or already added in batch.
 * 5. Saves to persistent storage for both channels.
 * 6. Clears the inbox completely.
 * 7. Returns updated leads for combined and instagram channels, along with acceptedCount and duplicateCount.
 */
export function acceptAllInboxLeadsIntoCrm(
  leadsToAccept: InboxLead[],
  existingChannelLeads?: {
    combined?: ChannelLead[];
    instagram?: ChannelLead[];
  }
): {
  updatedCombined: ChannelLead[];
  updatedInstagram: ChannelLead[];
  acceptedCount: number;
  duplicateCount: number;
} {
  let combinedList = [...(existingChannelLeads?.combined ?? loadChannelLeads('combined'))];
  let instagramList = [...(existingChannelLeads?.instagram ?? loadChannelLeads('instagram'))];

  let acceptedCount = 0;
  let duplicateCount = 0;
  const nowIso = new Date().toISOString();

  for (const lead of leadsToAccept) {
    const targetChannel: MultiChannelType = resolveInboxLeadRouting(lead).targetChannel;

    const currentTargetList = targetChannel === 'combined' ? combinedList : instagramList;

    const rawPlatformLink =
      (typeof lead.platformLink === 'string' && lead.platformLink.trim()) ||
      (typeof lead.profileLink === 'string' && lead.profileLink.trim()) ||
      extractRawPlatformLink(lead.rawDetails) ||
      '';

    const storedLink = rawPlatformLink;

    const leadCity =
      (typeof lead.city === 'string' && lead.city.trim()) ||
      (typeof lead.location === 'string' && lead.location.trim()) ||
      (typeof lead.rawDetails?.city === 'string' && lead.rawDetails.city.trim()) ||
      (typeof lead.rawDetails?.location === 'string' && lead.rawDetails.location.trim()) ||
      (typeof lead.rawDetails?.City === 'string' && lead.rawDetails.City.trim()) ||
      (typeof lead.rawDetails?.Location === 'string' && lead.rawDetails.Location.trim()) ||
      '';

    const extractedIg =
      lead.instagram ||
      lead.rawDetails?.instagram ||
      lead.rawDetails?.Instagram ||
      lead.rawDetails?.instagramUrl ||
      lead.rawDetails?.instagram_url ||
      lead.rawDetails?.instagramHandle ||
      lead.rawDetails?.instagram_handle ||
      lead.rawDetails?.socialLinks?.instagram ||
      (extractInstagramHandle(rawPlatformLink) ? rawPlatformLink : undefined);

    const normMatch = findNormalizedDuplicateMatches(
      {
        name: lead.name,
        city: leadCity,
        link: storedLink,
        platformLink: storedLink,
        email: lead.email,
        facebook: lead.facebook,
        instagram: extractedIg,
        rawDetails: lead.rawDetails,
      },
      {
        activeCombined: combinedList,
        activeInstagram: instagramList,
      }
    );
    if (normMatch.hasMatch) {
      duplicateCount++;
      continue;
    }

    const { id, numericId } = getNextLeadId(targetChannel, currentTargetList);
    const assignedScheduleDate = getNextAvailableScheduleDate(currentTargetList, targetChannel);
    const isFbRestricted = Boolean(lead.rawDetails?.fb_message_restricted || lead.rawDetails?.restricted);

    const extractedFb =
      lead.facebook ||
      lead.rawDetails?.facebook ||
      lead.rawDetails?.Facebook ||
      lead.rawDetails?.facebookUrl ||
      lead.rawDetails?.facebook_url ||
      lead.rawDetails?.fb ||
      lead.rawDetails?.socialLinks?.facebook ||
      (rawPlatformLink.includes('facebook.com') || rawPlatformLink.includes('fb.com') ? rawPlatformLink : undefined);

    const extractedEmail =
      lead.email ||
      lead.rawDetails?.email ||
      lead.rawDetails?.Email ||
      lead.rawDetails?.emailAddress ||
      lead.rawDetails?.contactEmail ||
      lead.rawDetails?.socialLinks?.email ||
      (isEmailAddressLink(rawPlatformLink) ? stripMailtoPrefix(rawPlatformLink) : undefined);

    const emailOnly = !hasSocialWarmupLink({
      channel: targetChannel,
      link: storedLink,
      platformLink: storedLink,
      facebook: extractedFb || undefined,
      rawDetails: lead.rawDetails,
    });

    const newChannelLead: ChannelLead = {
      id,
      numericId,
      name: lead.name,
      link: storedLink,
      platformLink: storedLink,
      instagram: extractedIg || undefined,
      facebook: extractedFb || undefined,
      email: extractedEmail || undefined,
      city: leadCity || undefined,
      channel: targetChannel,
      voiceType: getStrictVoiceTypeForId(numericId, targetChannel),
      isVoiceTypeOverridden: false,
      sortOrder: currentTargetList.length,
      createdAt: nowIso,
      scheduledDate: assignedScheduleDate,
      warmupStatus: emailOnly ? 'warmed' : 'locked',
      isWarmedUp: emailOnly,
      prompt: lead.prompt || undefined,
      leadAnalysis: lead.prompt || undefined,
      analysisSavedAt: lead.prompt ? nowIso : undefined,
      initialDM: '',
      customPitch: '',
      stagedDmMiniPitch: '',
      followupDM_Day4: '',
      followupDM_Day7: '',
      followup3DM: '',
      followupDM_Day8: '',
      followupDM_Day14: '',
      followup7DM: '',
      breakupDM_Day14: '',
      breakupDM_Day30: '',
      isSequenceConfigured: false,
      rawDetails: compactRawDetails(lead.rawDetails),
    };

    if (targetChannel === 'combined') {
      combinedList.push(newChannelLead);
    } else {
      instagramList.push(newChannelLead);
    }
    acceptedCount++;
  }

  // Resequence sort orders and recalculate ALL voice types strictly by ID on import
  combinedList = recalculateAllVoiceTypes(
    combinedList.map((l, idx) => ({ ...l, sortOrder: idx })),
    'combined'
  );
  instagramList = recalculateAllVoiceTypes(
    instagramList.map((l, idx) => ({ ...l, sortOrder: idx })),
    'instagram'
  );

  // Save both channels
  saveChannelLeads('combined', combinedList);
  saveChannelLeads('instagram', instagramList);

  // Clear all accepted from Inbox
  clearAllInboxLeads();

  return {
    updatedCombined: combinedList,
    updatedInstagram: instagramList,
    acceptedCount,
    duplicateCount,
  };
}
