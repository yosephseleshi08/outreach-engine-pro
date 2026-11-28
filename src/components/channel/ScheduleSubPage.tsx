import React, { useState, useMemo, useRef } from 'react';
import {
  Calendar,
  RotateCcw,
  Rocket,
  CheckCircle2,
  X,
  Flame,
  Lock,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  ClipboardPaste,
} from 'lucide-react';
import { ChannelLead, MultiChannelType } from '../../types';
import { getChannelLabel } from '../../utils/channelStorage';
import {
  getLocalTodayStr,
  normalizeToLocalDateStr,
  isDateToday,
  isDateOverdue,
  autoScheduleLeads,
  getScheduleDayStyle,
  addDays,
  isEmailOnlyLead,
  resolveLeadCadenceStep,
  getDayDifference,
  toCleanDateStr,
  isLeadWarmedBeforeToday,
  calculateCadenceFollowupDates,
} from '../../utils/cadenceEngine';
import { formatDisplayDate } from '../../utils/historyStorage';
import {
  buildBulkSchedulePreview,
  DetectedColumnMap,
  detectScheduleColumns,
  extractScheduleRows,
  parseDelimitedScheduleText,
  parseWorkbookBuffer,
  ParsedWorkbookData,
} from '../../utils/bulkScheduleParser';

interface ScheduleSubPageProps {
  channel: MultiChannelType;
  leads: ChannelLead[];
  onUpdateLeads: (leads: ChannelLead[]) => void;
}

export function ScheduleSubPage({ channel, leads, onUpdateLeads }: ScheduleSubPageProps) {
  const [scheduledBannerMsg, setScheduledBannerMsg] = useState<string | null>(null);
  const [showAutoScheduleModal, setShowAutoScheduleModal] = useState(false);

  // Bulk Schedule Uploader Modal state
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'paste'>('file');
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [workbookData, setWorkbookData] = useState<ParsedWorkbookData | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [rawGrid, setRawGrid] = useState<unknown[][]>([]);
  const [pasteText, setPasteText] = useState('');
  const [colMap, setColMap] = useState<DetectedColumnMap>({
    headerRowIndex: -1,
    idCol: -1,
    nameCol: -1,
    day0Col: -1,
    day4Col: -1,
    day8Col: -1,
    day14Col: -1,
  });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const todayStr = getLocalTodayStr();

  const sortedLeads = useMemo(() => {
    const getNumericId = (lead: ChannelLead) => {
      if (typeof lead.numericId === 'number' && Number.isFinite(lead.numericId) && lead.numericId > 0) {
        return lead.numericId;
      }
      const match = String(lead.id || '').match(/(\d+)$/);
      return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    return [...leads].sort((a, b) => getNumericId(a) - getNumericId(b));
  }, [leads]);

  const handleDateChange = (leadId: string, newDate: string) => {
    const cleanInput = toCleanDateStr(newDate);
    const normalized = cleanInput && /^\d{4}-\d{2}-\d{2}$/.test(cleanInput) ? cleanInput : null;
    const updated = leads.map((l) => {
      if (l.id !== leadId) return l;

      const emailOnly = isEmailOnlyLead(l);

      // 1. Cleared date
      if (!normalized) {
        const hasRecordedFollowups = Boolean(
          l.followup1SentDate || l.followup2SentDate || l.followup3SentDate || l.repliedAt
        );
        if (hasRecordedFollowups) {
          return {
            ...l,
            scheduledDate: undefined,
            dismissedDate: undefined,
          };
        }
        return {
          ...l,
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

      // 2. Recalculate Day 4, Day 8, and Day 14 working-day dates from the new Day 0 start date
      const recalculated = calculateCadenceFollowupDates(normalized);

      // Past Day 0 -> Save as initialSentDate with recalculated D4 / D8 / D14 dates
      if (normalized < todayStr) {
        return {
          ...l,
          initialSentDate: normalized,
          dispatchDate: normalized,
          dmSent: true,
          status: 'dispatched' as const,
          leadStatus: l.isSeen ? ('seen' as const) : ('waiting_reply' as const),
          cadenceStatus: 'running' as const,
          isCompleted: false,
          followupCount:
            typeof l.followupCount === 'number' && !Number.isNaN(l.followupCount)
              ? l.followupCount
              : 0,
          followup1Date: recalculated.followup1Date,
          followup2Date: recalculated.followup2Date,
          followup3Date: recalculated.followup3Date,
          warmupStatus: 'warmed' as const,
          isWarmedUp: true,
          warmedUpAt: l.warmedUpAt || normalized,
          scheduledDate: undefined,
          dismissedDate: undefined,
        };
      }

      // 3. Today or future Day 0 -> Update scheduledDate and recalculate D4 / D8 / D14 working-day dates
      const existingInitial = normalizeToLocalDateStr(l.initialSentDate);
      const hasRecordedFollowups = Boolean(
        l.followup1SentDate || l.followup2SentDate || l.followup3SentDate || l.repliedAt
      );
      const isAlreadySentToday = Boolean(
        normalized === todayStr && l.dmSent && existingInitial === todayStr
      );

      if (hasRecordedFollowups || isAlreadySentToday) {
        return {
          ...l,
          scheduledDate: isAlreadySentToday ? undefined : normalized,
          followup1Date: recalculated.followup1Date,
          followup2Date: recalculated.followup2Date,
          followup3Date: recalculated.followup3Date,
          warmupStatus: 'warmed' as const,
          isWarmedUp: true,
          dismissedDate: undefined,
        };
      }

      return {
        ...l,
        scheduledDate: normalized,
        initialSentDate: undefined,
        dispatchDate: undefined,
        dmSent: false,
        status: undefined,
        followupCount: 0,
        followup1Date: recalculated.followup1Date,
        followup2Date: recalculated.followup2Date,
        followup3Date: recalculated.followup3Date,
        leadStatus: 'not_sent' as const,
        cadenceStatus: l.cadenceStatus === 'cancelled' ? ('cancelled' as const) : undefined,
        isCompleted: false,
        warmupStatus: emailOnly
          ? ('warmed' as const)
          : (l.warmupStatus || (l.isWarmedUp ? 'warmed' : 'locked')),
        isWarmedUp: emailOnly ? true : l.isWarmedUp,
        dismissedDate: undefined,
      };
    });
    onUpdateLeads(updated);
  };

  /**
   * Auto-Schedule Execution
   * Starts from Today or Tomorrow as selected by the user.
   */
  const handleExecuteAutoSchedule = (startMode: 'today' | 'tomorrow') => {
    setShowAutoScheduleModal(false);
    if (leads.length === 0) return;

    const currentToday = getLocalTodayStr();
    const startDate = startMode === 'today' ? currentToday : addDays(currentToday, 1);
    const dailyQuota = channel === 'instagram' ? 6 : 4;

    const updated = autoScheduleLeads(leads, channel, startDate);
    onUpdateLeads(updated);

    const unsentCount = updated.filter((l) => !l.initialSentDate && l.scheduledDate && l.cadenceStatus !== 'cancelled').length;
    setScheduledBannerMsg(
      `🚀 Auto-scheduled ${unsentCount} leads starting ${startMode === 'today' ? 'Today' : 'Tomorrow'} (${dailyQuota}/day, Sundays & frozen days skipped)!`
    );
    setTimeout(() => setScheduledBannerMsg(null), 4500);
  };

  // --- Bulk Schedule Uploader Handlers ---
  const resetBulkUploader = () => {
    setUploadedFileName(null);
    setWorkbookData(null);
    setSelectedSheet('');
    setRawGrid([]);
    setPasteText('');
    setUploadError(null);
    setColMap({
      headerRowIndex: -1,
      idCol: -1,
      nameCol: -1,
      day0Col: -1,
      day4Col: -1,
      day8Col: -1,
      day14Col: -1,
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleOpenBulkModal = () => {
    resetBulkUploader();
    setUploadMode('file');
    setShowBulkModal(true);
  };

  const applyGridRows = (grid: unknown[][]) => {
    setRawGrid(grid);
    if (grid.length === 0) {
      setUploadError('No rows detected in this spreadsheet.');
      return;
    }
    const detected = detectScheduleColumns(grid);
    setColMap(detected);
    if (
      detected.day0Col === -1 &&
      detected.day4Col === -1 &&
      detected.day8Col === -1 &&
      detected.day14Col === -1
    ) {
      setUploadError('Could not automatically find Day 0 / Day 4 / Day 8 / Day 14 date columns. Select them manually below.');
    } else {
      setUploadError(null);
    }
  };

  const handleProcessFile = async (file: File) => {
    setUploadError(null);
    const lowerName = file.name.toLowerCase();
    setUploadedFileName(file.name);

    try {
      if (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv') || lowerName.endsWith('.txt')) {
        const text = await file.text();
        const grid = parseDelimitedScheduleText(text);
        setWorkbookData(null);
        setSelectedSheet('');
        applyGridRows(grid);
        return;
      }

      const buffer = await file.arrayBuffer();
      const parsedWb = parseWorkbookBuffer(buffer);
      if (parsedWb.sheetNames.length === 0) {
        setUploadError('No worksheets found inside this Excel file.');
        return;
      }
      setWorkbookData(parsedWb);
      setSelectedSheet(parsedWb.defaultSheet);
      applyGridRows(parsedWb.sheets[parsedWb.defaultSheet] || []);
    } catch (err) {
      console.error('Bulk schedule file parse error:', err);
      setUploadError('Failed to read file. Make sure it is a valid .xlsx, .xls, or .csv spreadsheet.');
    }
  };

  const handleSelectSheet = (sheetName: string) => {
    setSelectedSheet(sheetName);
    if (workbookData?.sheets[sheetName]) {
      applyGridRows(workbookData.sheets[sheetName]);
    }
  };

  const handlePasteTextChange = (text: string) => {
    setPasteText(text);
    setUploadedFileName(null);
    setWorkbookData(null);
    setSelectedSheet('');
    if (!text.trim()) {
      setRawGrid([]);
      setUploadError(null);
      return;
    }
    const grid = parseDelimitedScheduleText(text);
    applyGridRows(grid);
  };

  const headerChoices = useMemo(() => {
    const headerRow =
      colMap.headerRowIndex >= 0 && rawGrid[colMap.headerRowIndex]
        ? rawGrid[colMap.headerRowIndex]
        : rawGrid[0] || [];
    const maxCols = rawGrid.reduce((acc, r) => Math.max(acc, Array.isArray(r) ? r.length : 0), 0);
    const cols: { index: number; label: string }[] = [];
    for (let i = 0; i < maxCols; i++) {
      const cellLabel = String(headerRow[i] ?? '').trim();
      cols.push({
        index: i,
        label: cellLabel ? `Col ${i + 1}: ${cellLabel}` : `Column ${i + 1}`,
      });
    }
    return cols;
  }, [rawGrid, colMap.headerRowIndex]);

  const bulkPreview = useMemo(() => {
    if (rawGrid.length === 0) {
      return {
        parsedRows: [],
        previewRows: [],
        updatedLeads: leads,
        matchedCount: 0,
        unmatchedCount: 0,
        dueTodayAfterApply: 0,
      };
    }

    const parsedRows = extractScheduleRows(rawGrid, colMap);
    const built = buildBulkSchedulePreview(leads, parsedRows, todayStr);

    // Count exact leads due today after applying this Excel schedule
    const dueTodayAfterApply = built.updatedLeads.filter((lead) => {
      if (
        lead.isCompleted ||
        lead.isArchived ||
        lead.cadenceStatus === 'cancelled' ||
        lead.leadStatus === 'replied' ||
        lead.leadStatus === 'completed'
      ) {
        return false;
      }
      const resolved = resolveLeadCadenceStep(lead, todayStr);
      if (resolved.stageNumber === 0) {
        if (!lead.scheduledDate) return false;
        const scheduledToday = isDateToday(lead.scheduledDate);
        if (channel !== 'instagram' && isEmailOnlyLead(lead)) {
          return scheduledToday || isDateOverdue(lead.scheduledDate);
        }
        return scheduledToday && (isEmailOnlyLead(lead) || isLeadWarmedBeforeToday(lead, todayStr));
      }
      return resolved.isFollowupDue;
    }).length;

    return {
      parsedRows,
      ...built,
      dueTodayAfterApply,
    };
  }, [rawGrid, colMap, leads, todayStr, channel]);

  const handleApplyBulkSchedule = () => {
    if (bulkPreview.matchedCount === 0) return;
    onUpdateLeads(bulkPreview.updatedLeads);
    setShowBulkModal(false);
    setScheduledBannerMsg(
      `📅 Imported exact Day 0, Day 4, Day 8, and Day 14 dates for ${bulkPreview.matchedCount} lead${
        bulkPreview.matchedCount === 1 ? '' : 's'
      } directly from spreadsheet (no recalculation).`
    );
    setTimeout(() => setScheduledBannerMsg(null), 5000);
  };

  const activeSchedulableLeads = leads.filter((l) => l.cadenceStatus !== 'cancelled');
  const scheduledCount = activeSchedulableLeads.filter((l) => Boolean(l.scheduledDate || l.initialSentDate)).length;
  const unscheduledCount = activeSchedulableLeads.length - scheduledCount;

  // Format date helper: e.g. "Wed, Nov 11, 2026"
  const formatDateDisplay = (dateStr?: string) => {
    if (!dateStr) return 'Unscheduled';
    const normalized = normalizeToLocalDateStr(dateStr);
    if (!normalized) return 'Unscheduled';
    const [y, m, d] = normalized.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    if (isNaN(dateObj.getTime())) return dateStr;
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-white font-['Outfit'] flex items-center gap-2">
            <span>{getChannelLabel(channel)} Dispatch Planner</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Flat Capacity Model: {channel === 'instagram' ? 'Target 6 leads/day' : 'Target 4 leads/day'} · Global Quota: 10 Combined Touchpoints/Day (Sundays rest).
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto flex-wrap">
          <div className="text-xs font-mono text-slate-400 bg-slate-900/80 px-3 py-1.5 rounded-xl border border-white/10">
            Scheduled: <span className="text-indigo-400 font-bold">{scheduledCount}</span> / {activeSchedulableLeads.length}
            {unscheduledCount > 0 && (
              <span className="text-amber-400 ml-1.5">({unscheduledCount} unscheduled)</span>
            )}
          </div>

          <button
            type="button"
            onClick={handleOpenBulkModal}
            disabled={leads.length === 0}
            className="px-4 py-2 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-emerald-600/25 border border-emerald-400/30 cursor-pointer active:scale-95"
            title="Upload exact Day 0, Day 4, Day 8, Day 14 dates from Excel or CSV"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-100" />
            <span>Bulk Schedule Upload</span>
          </button>

          <button
            type="button"
            onClick={() => setShowAutoScheduleModal(true)}
            disabled={leads.length === 0}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-indigo-600/30 cursor-pointer active:scale-95"
            title="Auto-schedule all unscheduled leads"
          >
            <Rocket className="w-4 h-4 text-amber-300" />
            <span>🚀 Auto-Schedule</span>
          </button>
        </div>
      </div>

      {/* Confirmation Notification Banner */}
      {scheduledBannerMsg && (
        <div className="p-3.5 rounded-xl border border-emerald-500/40 bg-emerald-950/40 text-emerald-200 text-xs font-semibold flex items-center gap-2 shadow-lg animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{scheduledBannerMsg}</span>
        </div>
      )}

      {leads.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/50 p-12 text-center text-slate-400">
          <Calendar className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-300">No leads to schedule</p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            Add leads in the "Leads" sub-tab first to assign their outreach dates.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/50 backdrop-blur-sm overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08] bg-slate-950/60 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  <th className="py-3 px-4 text-left w-32">Lead ID</th>
                  <th className="py-3 px-4 text-left">Prospect Name</th>
                  <th className="py-3 px-4 text-left min-w-[320px]">Scheduled / Sent &amp; Cadence Dates</th>
                  <th className="py-3 px-4 text-right w-56">Edit Day 0 Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {sortedLeads.map((lead) => {
                  const normInitial = normalizeToLocalDateStr(lead.initialSentDate);
                  const isPastInitial = Boolean(normInitial && normInitial < todayStr);
                  const effectiveDate = lead.scheduledDate || lead.initialSentDate;
                  const hasDate = Boolean(effectiveDate);
                  const isToday = isDateToday(effectiveDate);
                  const dayStyle = getScheduleDayStyle(effectiveDate);
                  const resolved = resolveLeadCadenceStep(lead, todayStr);
                  const daysSinceSent = normInitial ? Math.max(0, getDayDifference(todayStr, normInitial)) : 0;

                  const fuCount = lead.followupCount ?? 0;
                  const f1 = normalizeToLocalDateStr(lead.followup1Date);
                  const f2 = normalizeToLocalDateStr(lead.followup2Date);
                  const f3 = normalizeToLocalDateStr(lead.followup3Date);

                  let nextTargetStage: 4 | 8 | 14 | null = null;
                  let daysUntilNext: number | null = null;

                  if (isPastInitial && !resolved.isFollowupDue && fuCount < 3) {
                    if (fuCount === 0 && (f1 ? f1 > todayStr : daysSinceSent < 4)) {
                      nextTargetStage = 4;
                      daysUntilNext = f1 ? getDayDifference(f1, todayStr) : 4 - daysSinceSent;
                    } else if (fuCount <= 1 && (f2 ? f2 > todayStr : daysSinceSent < 8)) {
                      nextTargetStage = 8;
                      daysUntilNext = f2 ? getDayDifference(f2, todayStr) : 8 - daysSinceSent;
                    } else if (fuCount <= 2 && (f3 ? f3 > todayStr : daysSinceSent < 14)) {
                      nextTargetStage = 14;
                      daysUntilNext = f3 ? getDayDifference(f3, todayStr) : 14 - daysSinceSent;
                    }
                  }

                  return (
                    <tr
                      key={lead.id}
                      className={`hover:bg-white/[0.02] transition-colors ${dayStyle.tintClass} ${
                        isToday ? 'ring-1 ring-emerald-500/40 bg-emerald-950/20' : ''
                      }`}
                    >
                      {/* ID + Lock Indicator when initialSentDate is in the past */}
                      <td className="py-3.5 px-4 text-left font-mono text-xs tabular-nums">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-md border border-indigo-500/20">
                            {lead.id}
                          </span>
                          {isPastInitial && (
                            <span
                              className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400"
                              title="Locked in sequence: initialSentDate is in the past"
                              aria-label="Locked in sequence"
                            >
                              <Lock className="w-3 h-3" />
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Name */}
                      <td className="py-3.5 px-4 text-left">
                        <div className="font-medium text-sm text-slate-100 font-['Outfit'] truncate max-w-xs">
                          {lead.name}
                        </div>
                      </td>

                      {/* Date / Cadence Status Column */}
                      <td className="py-3.5 px-4 text-left">
                        {lead.cadenceStatus === 'cancelled' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                            Cancelled{lead.cancelledReason ? ` · ${lead.cancelledReason}` : ''}
                          </span>
                        ) : hasDate ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold font-mono border ${dayStyle.badgeClass}`}
                              >
                                <span>{formatDateDisplay(effectiveDate)}</span>
                              </span>
                              {isToday && (
                                <span className="text-[10px] font-black uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse">
                                  TODAY
                                </span>
                              )}
                              {isPastInitial && normInitial && (
                                <span
                                  className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded border ${
                                    resolved.isFollowupDue
                                      ? resolved.stageNumber === 4
                                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                        : resolved.stageNumber === 8
                                        ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                                        : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                                      : 'bg-slate-800/80 text-slate-300 border-white/10'
                                  }`}
                                >
                                  {resolved.isFollowupDue
                                    ? `Day ${resolved.stageNumber} Due Today`
                                    : nextTargetStage && daysUntilNext !== null
                                    ? `Day ${daysSinceSent} · Next: Day ${nextTargetStage} (${daysUntilNext}d)`
                                    : `Initial Sent: Day ${daysSinceSent}`}
                                </span>
                              )}
                            </div>

                            {(f1 || f2 || f3) && (
                              <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
                                {f1 && (
                                  <span
                                    className={`px-1.5 py-0.5 rounded border ${
                                      f1 === todayStr && resolved.stageNumber === 4
                                        ? 'bg-amber-500/20 text-amber-200 border-amber-500/40 font-bold'
                                        : 'bg-slate-950/80 text-slate-400 border-white/10'
                                    }`}
                                  >
                                    D4: {f1}
                                  </span>
                                )}
                                {f2 && (
                                  <span
                                    className={`px-1.5 py-0.5 rounded border ${
                                      f2 === todayStr && resolved.stageNumber === 8
                                        ? 'bg-purple-500/20 text-purple-200 border-purple-500/40 font-bold'
                                        : 'bg-slate-950/80 text-slate-400 border-white/10'
                                    }`}
                                  >
                                    D8: {f2}
                                  </span>
                                )}
                                {f3 && (
                                  <span
                                    className={`px-1.5 py-0.5 rounded border ${
                                      f3 === todayStr && resolved.stageNumber === 14
                                        ? 'bg-rose-500/20 text-rose-200 border-rose-500/40 font-bold'
                                        : 'bg-slate-950/80 text-slate-400 border-white/10'
                                    }`}
                                  >
                                    D14: {f3}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs font-mono text-slate-500 italic">
                            Unscheduled
                          </span>
                        )}
                      </td>

                      {/* Date Picker Input & Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2.5">
                          <input
                            type="date"
                            value={toCleanDateStr(lead.scheduledDate) || toCleanDateStr(lead.initialSentDate) || ''}
                            onChange={(e) => handleDateChange(lead.id, e.target.value)}
                            className={`px-3 py-1.5 bg-slate-950 border rounded-lg text-xs font-mono tabular-nums text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all ${
                              hasDate
                                ? isToday
                                  ? 'border-amber-500/50 bg-amber-500/5 text-amber-200'
                                  : isPastInitial
                                  ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
                                  : 'border-indigo-500/40 bg-indigo-500/5 text-indigo-200'
                                : 'border-white/10'
                            }`}
                          />
                          {hasDate && (
                            <button
                              type="button"
                              onClick={() => handleDateChange(lead.id, '')}
                              className="p-1.5 text-slate-500 hover:text-rose-400 rounded hover:bg-white/5 transition-colors cursor-pointer"
                              title="Clear date"
                              aria-label={`Clear date for ${lead.id}`}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk Schedule Uploader Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-4xl rounded-3xl bg-slate-900 border border-white/10 p-6 shadow-2xl space-y-5 text-slate-100 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-mono">
                  {getChannelLabel(channel)} · Direct Date Mapping
                </span>
                <h3 className="text-xl font-black text-white font-['Outfit'] mt-0.5">
                  Bulk Schedule Uploader (Excel / CSV)
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Reads all four date columns (<strong className="text-slate-200">Day 0</strong>,{' '}
                  <strong className="text-amber-300">Day 4</strong>,{' '}
                  <strong className="text-purple-300">Day 8</strong>,{' '}
                  <strong className="text-rose-300">Day 14</strong>) directly from your spreadsheet and saves them verbatim without Cadence Engine recalculation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                aria-label="Close bulk schedule uploader"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Mode Switcher */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setUploadMode('file')}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer border ${
                  uploadMode === 'file'
                    ? 'bg-emerald-600/20 text-emerald-200 border-emerald-500/40'
                    : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Upload Excel / CSV File</span>
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('paste')}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition cursor-pointer border ${
                  uploadMode === 'paste'
                    ? 'bg-emerald-600/20 text-emerald-200 border-emerald-500/40'
                    : 'bg-white/5 text-slate-400 border-white/10 hover:text-white'
                }`}
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                <span>Paste from Excel / Sheets</span>
              </button>
            </div>

            {uploadMode === 'file' ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) handleProcessFile(dropped);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`rounded-2xl border-2 border-dashed p-6 text-center transition cursor-pointer ${
                  isDragOver
                    ? 'border-emerald-400 bg-emerald-500/10'
                    : 'border-white/15 bg-slate-950/60 hover:border-emerald-500/40 hover:bg-slate-950'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv,.tsv,.txt"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleProcessFile(file);
                  }}
                  className="hidden"
                />
                <FileSpreadsheet className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                {uploadedFileName ? (
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-emerald-300 font-mono">{uploadedFileName}</p>
                    <p className="text-xs text-slate-400">Click or drop another spreadsheet to replace</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-200">
                      Drop your Excel (.xlsx / .xls) or CSV file here, or click to browse
                    </p>
                    <p className="text-xs text-slate-500">
                      Expected columns: Lead ID (or Name), Day 0, Day 4, Day 8, Day 14
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  rows={6}
                  value={pasteText}
                  onChange={(e) => handlePasteTextChange(e.target.value)}
                  placeholder={`ID\tName\tDay 0\tDay 4\tDay 8\tDay 14\nIG-36\tSample Bistro\t2026-11-27\t2026-12-02\t2026-12-07\t2026-12-14`}
                  className="w-full p-3.5 bg-slate-950 border border-white/10 rounded-xl text-xs font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
                <p className="text-[11px] text-slate-400">
                  Copy cells directly from Excel or Google Sheets (with or without headers) and paste above.
                </p>
              </div>
            )}

            {/* Workbook Sheet Selector */}
            {workbookData && workbookData.sheetNames.length > 1 && (
              <div className="flex items-center gap-3 bg-slate-950/70 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs">
                <span className="font-semibold text-slate-300">Worksheet:</span>
                <select
                  value={selectedSheet}
                  onChange={(e) => handleSelectSheet(e.target.value)}
                  className="bg-slate-900 border border-white/15 rounded-lg px-2.5 py-1 text-slate-100 font-mono text-xs focus:outline-none focus:border-emerald-500"
                >
                  {workbookData.sheetNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Column Mapping Controls */}
            {rawGrid.length > 0 && (
              <div className="p-3.5 rounded-2xl bg-slate-950/70 border border-white/10 space-y-2.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                  Mapped Columns (Exact Date Import)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
                  {(
                    [
                      { key: 'idCol', label: 'Lead ID' },
                      { key: 'nameCol', label: 'Lead Name' },
                      { key: 'day0Col', label: 'Day 0' },
                      { key: 'day4Col', label: 'Day 4' },
                      { key: 'day8Col', label: 'Day 8' },
                      { key: 'day14Col', label: 'Day 14' },
                    ] as const
                  ).map((field) => (
                    <label key={field.key} className="space-y-1">
                      <span className="block text-[10px] font-mono text-slate-400">{field.label}</span>
                      <select
                        value={colMap[field.key]}
                        onChange={(e) =>
                          setColMap((prev) => ({
                            ...prev,
                            [field.key]: parseInt(e.target.value, 10),
                          }))
                        }
                        className="w-full bg-slate-900 border border-white/15 rounded-lg px-2 py-1.5 text-[11px] text-slate-100 font-mono focus:outline-none focus:border-emerald-500"
                      >
                        <option value={-1}>-- None --</option>
                        {headerChoices.map((col) => (
                          <option key={col.index} value={col.index}>
                            {col.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {uploadError && (
              <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}

            {/* Preview Summary & Table */}
            {bulkPreview.previewRows.length > 0 && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold">
                      {bulkPreview.matchedCount} Matched
                    </span>
                    {bulkPreview.unmatchedCount > 0 && (
                      <span className="px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold">
                        {bulkPreview.unmatchedCount} Unmatched
                      </span>
                    )}
                    <span className="px-2.5 py-1 rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-bold">
                      Due Today After Import: {bulkPreview.dueTodayAfterApply}
                    </span>
                  </div>
                  <span className="text-slate-400">
                    Showing {Math.min(bulkPreview.previewRows.length, 50)} of {bulkPreview.previewRows.length} rows
                  </span>
                </div>

                <div className="rounded-xl border border-white/10 bg-slate-950/80 overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full border-collapse text-xs font-mono">
                    <thead className="sticky top-0 bg-slate-950 border-b border-white/10 text-[10px] uppercase text-slate-400">
                      <tr>
                        <th className="py-2 px-3 text-left">Lead</th>
                        <th className="py-2 px-3 text-left">Day 0</th>
                        <th className="py-2 px-3 text-left text-amber-300">Day 4</th>
                        <th className="py-2 px-3 text-left text-purple-300">Day 8</th>
                        <th className="py-2 px-3 text-left text-rose-300">Day 14</th>
                        <th className="py-2 px-3 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {bulkPreview.previewRows.slice(0, 50).map((item, idx) => (
                        <tr key={`${item.parsed.rowIndex}-${idx}`} className="hover:bg-white/[0.03]">
                          <td className="py-2 px-3 text-slate-200">
                            {item.matchedLead ? (
                              <div className="flex items-center gap-1.5">
                                <span className="text-indigo-300 font-bold">{item.matchedLead.id}</span>
                                <span className="text-slate-400 font-sans truncate max-w-[160px]">
                                  {item.matchedLead.name}
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400">
                                {item.parsed.rawId || item.parsed.rawName || `Row ${item.parsed.rowIndex}`}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-slate-200">{item.parsed.day0 || '—'}</td>
                          <td className="py-2 px-3 text-amber-200">{item.parsed.day4 || item.updatedPreview?.followup1Date || '—'}</td>
                          <td className="py-2 px-3 text-purple-200">{item.parsed.day8 || item.updatedPreview?.followup2Date || '—'}</td>
                          <td className="py-2 px-3 text-rose-200">{item.parsed.day14 || item.updatedPreview?.followup3Date || '—'}</td>
                          <td className="py-2 px-3 text-right">
                            {item.matchMethod === 'unmatched' ? (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                No Match
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                Matched ({item.matchMethod})
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowBulkModal(false)}
                className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-300 hover:text-white transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApplyBulkSchedule}
                disabled={bulkPreview.matchedCount === 0}
                className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition cursor-pointer flex items-center gap-2 shadow-lg shadow-emerald-600/30"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Apply Exact Dates ({bulkPreview.matchedCount} Leads)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Requirement 4: Auto-Schedule Modal: Today vs Tomorrow */}
      {showAutoScheduleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-md rounded-3xl bg-slate-900 border border-white/10 p-6 shadow-2xl space-y-5 text-slate-100">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-400 font-mono">
                  Auto-Schedule Pacer
                </span>
                <h3 className="text-xl font-black text-white font-['Outfit'] mt-0.5">
                  Start Scheduling Date
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAutoScheduleModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Start scheduling from <strong>Today</strong> or <strong>Tomorrow</strong>?
            </p>

            <div className="space-y-3">
              {/* Option 1: Tomorrow (Recommended) */}
              <button
                type="button"
                onClick={() => handleExecuteAutoSchedule('tomorrow')}
                className="w-full p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-left transition flex items-start gap-3 cursor-pointer group active:scale-98"
              >
                <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0 mt-0.5">
                  <Flame className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white group-hover:text-amber-200">
                    🌅 Start Tomorrow (Recommended)
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Warms them up today so prospects recognize your account before you dispatch outreach tomorrow. Sundays are automatically skipped.
                  </p>
                </div>
              </button>

              {/* Option 2: Today */}
              <button
                type="button"
                onClick={() => handleExecuteAutoSchedule('today')}
                className="w-full p-4 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-left transition flex items-start gap-3 cursor-pointer group active:scale-98"
              >
                <div className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shrink-0 mt-0.5">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white group-hover:text-indigo-200">
                    📅 Start Today
                  </div>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Immediately fills today's open quota slots ({channel === 'instagram' ? '6' : '4'} leads) and staggers remaining leads across upcoming weekdays.
                  </p>
                </div>
              </button>
            </div>

            <div className="flex justify-end pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowAutoScheduleModal(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-lg transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
