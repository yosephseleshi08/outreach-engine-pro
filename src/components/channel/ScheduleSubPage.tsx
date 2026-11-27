import React, { useState, useMemo, useRef, useEffect } from 'react';
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
  AlertTriangle,
  Download,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { ChannelLead, MultiChannelType } from '../../types';
import { getChannelLabel } from '../../utils/channelStorage';
import {
  getLocalTodayStr,
  normalizeToLocalDateStr,
  isDateToday,
  autoScheduleLeads,
  getScheduleDayStyle,
  addDays,
  addCadenceDays,
  resolveLeadCadenceStep,
  toCleanDateStr,
} from '../../utils/cadenceEngine';
import { normalizeExistingLeadCadence } from '../../utils/dataRepair';
import {
  applyBulkScheduleWithValidation,
  applyScheduledDateToLead,
  BulkScheduleMismatchError,
  parseScheduleFile,
  parseScheduleText,
} from '../../utils/bulkScheduleParser';

interface ScheduleSubPageProps {
  channel: MultiChannelType;
  leads: ChannelLead[];
  onUpdateLeads: (leads: ChannelLead[]) => void;
}

interface ScheduleToastState {
  id: number;
  message: string;
  hasErrors: boolean;
}

export function ScheduleSubPage({ channel, leads, onUpdateLeads }: ScheduleSubPageProps) {
  const [scheduledBannerMsg, setScheduledBannerMsg] = useState<string | null>(null);
  const [showAutoScheduleModal, setShowAutoScheduleModal] = useState(false);

  // Bulk Schedule Upload State
  const [showBulkUploadModal, setShowBulkUploadModal] = useState(false);
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [bulkUploadError, setBulkUploadError] = useState<string | null>(null);
  const [isParsingUpload, setIsParsingUpload] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [mismatchErrors, setMismatchErrors] = useState<BulkScheduleMismatchError[]>([]);
  const [uploadSummaryToast, setUploadSummaryToast] = useState<ScheduleToastState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const todayStr = getLocalTodayStr();

  useEffect(() => {
    if (!uploadSummaryToast) return;
    const timer = setTimeout(() => {
      setUploadSummaryToast(null);
    }, 8000);
    return () => clearTimeout(timer);
  }, [uploadSummaryToast]);

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
      return applyScheduledDateToLead(l, normalized, todayStr);
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

  const handleRecalculateExistingSchedules = () => {
    if (leads.length === 0) return;
    let updatedCount = 0;
    const recalculated = leads.map((lead) => {
      const { normalizedLead, wasChanged } = normalizeExistingLeadCadence(lead);
      if (wasChanged) updatedCount++;
      return normalizedLead;
    });
    if (updatedCount > 0) {
      onUpdateLeads(recalculated);
    }
    const msg =
      updatedCount > 0
        ? `Recalculated Day 4 / 8 / 14 follow-up dates (Sundays & freeze days skipped) for ${updatedCount} ${updatedCount === 1 ? 'lead' : 'leads'}.`
        : `All ${leads.length} leads already match the skip-Sunday Day 4 / 8 / 14 cadence schedule.`;
    setScheduledBannerMsg(msg);
    setUploadSummaryToast({
      id: Date.now(),
      message: msg,
      hasErrors: false,
    });
    setTimeout(() => setScheduledBannerMsg(null), 5000);
  };

  const applyParsedBulkRows = (rows: ReturnType<typeof parseScheduleText>) => {
    const result = applyBulkScheduleWithValidation(leads, rows, todayStr);

    if (result.scheduledCount > 0) {
      onUpdateLeads(result.updatedLeads);
    }

    setMismatchErrors(result.mismatchErrors);
    setScheduledBannerMsg(result.summaryToast);
    setUploadSummaryToast({
      id: Date.now(),
      message: result.summaryToast,
      hasErrors: result.hasMismatches,
    });
    setShowBulkUploadModal(false);
    setBulkPasteText('');
    setBulkUploadError(null);
  };

  const handleBulkFileUpload = async (file: File) => {
    setIsParsingUpload(true);
    setBulkUploadError(null);
    try {
      const rows = await parseScheduleFile(file);
      if (rows.length === 0) {
        setBulkUploadError('No valid schedule rows found in the uploaded file.');
        return;
      }
      applyParsedBulkRows(rows);
    } catch (err: any) {
      console.error('Bulk schedule file parse error:', err);
      setBulkUploadError(err?.message || 'Could not parse file. Ensure it has Lead ID, Lead Name (or PROSPECT NAME), and Day 0 columns.');
    } finally {
      setIsParsingUpload(false);
    }
  };

  const handleBulkPasteSubmit = () => {
    setBulkUploadError(null);
    try {
      const rows = parseScheduleText(bulkPasteText);
      if (rows.length === 0) {
        setBulkUploadError('No valid schedule rows found in pasted text.');
        return;
      }
      applyParsedBulkRows(rows);
    } catch (err: any) {
      console.error('Bulk schedule text parse error:', err);
      setBulkUploadError(err?.message || 'Could not parse pasted text. Ensure headers include Lead ID, Lead Name (or PROSPECT NAME), and Day 0.');
    }
  };

  const handleDownloadScheduleTemplate = () => {
    const headers = ['Lead ID', 'Prospect Name', 'Day 0'];
    const rows = sortedLeads.map((l) => [
      `"${l.id}"`,
      `"${(l.name || '').replace(/"/g, '""')}"`,
      `"${toCleanDateStr(l.scheduledDate) || toCleanDateStr(l.initialSentDate) || ''}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${channel}_schedule_template_${todayStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      {/* Floating Summary Toast Alert */}
      {uploadSummaryToast && (
        <div
          role="alert"
          aria-live="assertive"
          className={`fixed top-6 right-6 z-50 max-w-md w-[calc(100vw-3rem)] rounded-2xl border px-4 py-3.5 text-xs sm:text-sm font-bold shadow-2xl backdrop-blur-xl animate-in slide-in-from-top-4 flex items-center justify-between gap-3 ${
            uploadSummaryToast.hasErrors
              ? 'border-amber-500/50 bg-amber-950/95 text-amber-100 shadow-amber-950/60'
              : 'border-emerald-500/50 bg-emerald-950/95 text-emerald-100 shadow-emerald-950/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {uploadSummaryToast.hasErrors ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span>{uploadSummaryToast.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setUploadSummaryToast(null)}
            className="text-white/60 hover:text-white p-1 rounded-lg transition cursor-pointer"
            aria-label="Dismiss toast"
          >
            ✕
          </button>
        </div>
      )}

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
            onClick={handleRecalculateExistingSchedules}
            disabled={leads.length === 0}
            className="px-3.5 py-2 rounded-xl border border-indigo-500/35 bg-indigo-500/15 hover:bg-indigo-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-indigo-200 hover:text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer active:scale-95"
            title="Re-run Day 4 / 8 / 14 cadence dates for existing leads (skips Sundays & freeze days)"
          >
            <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
            <span>Recalculate Cadence</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setBulkUploadError(null);
              setShowBulkUploadModal(true);
            }}
            disabled={leads.length === 0}
            className="px-3.5 py-2 rounded-xl border border-emerald-500/35 bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-emerald-200 hover:text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer active:scale-95"
            title="Upload Excel (.xlsx/.xls) or CSV schedule with ID + Name verification"
          >
            <Upload className="w-3.5 h-3.5 text-emerald-400" />
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
        <div className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center justify-between gap-2 shadow-lg animate-in fade-in ${
          mismatchErrors.length > 0
            ? 'border-amber-500/40 bg-amber-950/40 text-amber-200'
            : 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
        }`}>
          <div className="flex items-center gap-2">
            {mismatchErrors.length > 0 ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span>{scheduledBannerMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setScheduledBannerMsg(null)}
            className="p-1 text-white/60 hover:text-white rounded cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Safety Mismatch Error Log */}
      {mismatchErrors.length > 0 && (
        <div className="rounded-2xl border border-rose-500/35 bg-rose-950/25 p-4 space-y-2.5 shadow-lg">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-rose-200">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>
                Skipped {mismatchErrors.length} {mismatchErrors.length === 1 ? 'row' : 'rows'} — Name did not match Lead ID (existing schedules protected)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMismatchErrors([])}
              className="text-[11px] text-rose-300/80 hover:text-white px-2 py-0.5 rounded bg-rose-500/15 cursor-pointer"
            >
              Clear Log
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto space-y-1.5 text-xs font-mono">
            {mismatchErrors.map((err, idx) => (
              <div
                key={`${err.leadId}-${err.rowNumber}-${idx}`}
                className="px-3 py-2 rounded-lg bg-slate-950/60 border border-rose-500/20 text-rose-100 flex flex-wrap items-center justify-between gap-2"
              >
                <span>
                  <strong className="text-rose-300">Row {err.rowNumber}</strong> ·{' '}
                  <span className="text-indigo-300">{err.leadId}</span>: CRM has{' '}
                  <strong className="text-emerald-300">"{err.expectedName}"</strong>, file had{' '}
                  <strong className="text-rose-300">"{err.uploadedName}"</strong>
                </span>
                <span className="text-[11px] text-slate-400">Date {err.attemptedDate} skipped</span>
              </div>
            ))}
          </div>
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
                  {/* Requirement 4: Replaced Profile Link with Date column */}
                  <th className="py-3 px-4 text-left w-72">Scheduled Date (Day 0)</th>
                  <th className="py-3 px-4 text-right w-64">Edit Date</th>
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
                  const daysSinceSent = resolved.daysSinceInitial;
                  const fu1Display = normInitial ? (lead.followup1Date || addCadenceDays(normInitial, 4)) : null;
                  const fu2Display = normInitial ? (lead.followup2Date || addCadenceDays(normInitial, 8)) : null;
                  const fu3Display = normInitial ? (lead.followup3Date || addCadenceDays(normInitial, 14)) : null;

                  const nextTargetStage =
                    daysSinceSent < 4 ? 4 : daysSinceSent < 8 ? 8 : daysSinceSent < 14 ? 14 : null;

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
                          <div className="space-y-1">
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
                                    : nextTargetStage
                                    ? `Day ${daysSinceSent} · Next: Day ${nextTargetStage} (${nextTargetStage - daysSinceSent}d)`
                                    : `Initial Sent: Day ${daysSinceSent}`}
                                </span>
                              )}
                            </div>
                            {normInitial && fu1Display && fu2Display && fu3Display && (
                              <div className="text-[10px] font-mono text-slate-400">
                                D4: {fu1Display.slice(5)} · D8: {fu2Display.slice(5)} · D14: {fu3Display.slice(5)}
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

      {/* Bulk Schedule Upload Modal (Excel / CSV with Lead ID + Lead Name Safety Check) */}
      {showBulkUploadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
          onClick={() => setShowBulkUploadModal(false)}
        >
          <div
            className="w-full max-w-xl rounded-3xl bg-slate-900 border border-white/10 p-6 shadow-2xl space-y-5 text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-mono flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>ID + Name Verified Schedule Importer</span>
                </span>
                <h3 className="text-xl font-black text-white font-['Outfit'] mt-0.5">
                  Bulk Schedule Upload ({getChannelLabel(channel)})
                </h3>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  Upload an Excel (<code className="text-emerald-300">.xlsx</code> / <code className="text-emerald-300">.xls</code>) or CSV file with{' '}
                  <strong className="text-slate-200">Lead ID</strong>, <strong className="text-slate-200">Lead Name / PROSPECT NAME</strong>, and{' '}
                  <strong className="text-slate-200">Day 0</strong>. Only <strong className="text-emerald-300">Day 0</strong> is read (Day 4, 8, and 14 are calculated automatically). Rows where the name does not match the CRM lead ID are automatically blocked.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBulkUploadModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {bulkUploadError && (
              <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{bulkUploadError}</span>
              </div>
            )}

            {/* Hidden File Input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleBulkFileUpload(file);
                e.target.value = '';
              }}
              className="hidden"
            />

            {/* Dropzone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingFile(true);
              }}
              onDragLeave={() => setIsDraggingFile(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDraggingFile(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleBulkFileUpload(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-2xl border-2 border-dashed p-6 text-center transition cursor-pointer ${
                isDraggingFile
                  ? 'border-emerald-400 bg-emerald-500/15'
                  : 'border-white/15 bg-slate-950/60 hover:border-emerald-500/45 hover:bg-slate-950'
              }`}
            >
              <FileSpreadsheet className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <div className="text-sm font-bold text-white">
                {isParsingUpload ? 'Validating spreadsheet...' : 'Click or drop Excel / CSV file here'}
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Supports .xlsx, .xls, .csv, .tsv · Reads Day 0 only &amp; validates Lead ID + Lead Name
              </p>
            </div>

            {/* Or paste rows directly */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-semibold">Or paste spreadsheet rows (with headers):</span>
                <button
                  type="button"
                  onClick={handleDownloadScheduleTemplate}
                  className="text-indigo-300 hover:text-indigo-200 font-semibold flex items-center gap-1 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Current CSV Template</span>
                </button>
              </div>
              <textarea
                rows={4}
                value={bulkPasteText}
                onChange={(e) => {
                  setBulkPasteText(e.target.value);
                  if (bulkUploadError) setBulkUploadError(null);
                }}
                placeholder={`Lead ID\tPROSPECT NAME\tDay 0\n${channel === 'instagram' ? 'IG-1' : 'CM-1'}\tRED the Steakhouse\t2026-11-11`}
                className="w-full p-3 rounded-xl bg-slate-950 border border-white/10 text-xs font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-white/10">
              <button
                type="button"
                onClick={() => setShowBulkUploadModal(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleBulkPasteSubmit}
                disabled={!bulkPasteText.trim() || isParsingUpload}
                className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition shadow-lg shadow-emerald-600/25 cursor-pointer"
              >
                Validate &amp; Apply Pasted Schedule
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
