import React, { useState } from 'react';
import {
  Calendar,
  RotateCcw,
  Rocket,
  CheckCircle2,
  X,
  Flame,
  Lock,
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
  isEmailOnlyLead,
  getDayDifference,
  resolveLeadCadenceStep,
  revertInitialSent,
} from '../../utils/cadenceEngine';
import { formatDisplayDate } from '../../utils/historyStorage';

interface ScheduleSubPageProps {
  channel: MultiChannelType;
  leads: ChannelLead[];
  onUpdateLeads: (leads: ChannelLead[]) => void;
}

export function ScheduleSubPage({ channel, leads, onUpdateLeads }: ScheduleSubPageProps) {
  const [scheduledBannerMsg, setScheduledBannerMsg] = useState<string | null>(null);
  const [showAutoScheduleModal, setShowAutoScheduleModal] = useState(false);

  const todayStr = getLocalTodayStr();

  const handleDateChange = (leadId: string, newDate: string) => {
    const normalized = normalizeToLocalDateStr(newDate);
    let feedbackMsg: string | null = null;

    const updated = leads.map((l) => {
      if (l.id !== leadId) return l;
      const emailOnly = isEmailOnlyLead(l);

      if (!normalized) {
        const hasFollowupSent = Boolean(
          l.followup1SentDate || l.followup2SentDate || l.followup3SentDate || l.isCompleted
        );
        if (!hasFollowupSent) {
          feedbackMsg = `Cleared date for ${l.name} (${l.id}) and restored to unscheduled.`;
          return {
            ...revertInitialSent(l),
            scheduledDate: undefined,
            warmupStatus: emailOnly ? ('warmed' as const) : undefined,
            isWarmedUp: emailOnly ? true : false,
            dismissedDate: undefined,
          };
        }
        feedbackMsg = `Cleared scheduled follow-up date for ${l.name} (${l.id}).`;
        return {
          ...l,
          scheduledDate: undefined,
          dismissedDate: undefined,
        };
      }

      // Past date -> save as initialSentDate, initialize 4/8/14 sequence, clear scheduledDate
      if (normalized < todayStr) {
        const diff = getDayDifference(todayStr, normalized);
        const fuCount = l.followupCount ?? 0;

        let cadenceHint: string;
        if (diff === 14 && fuCount <= 2) {
          cadenceHint = "Queued in Today's Schedule as Day 14 Breakup.";
        } else if (diff === 8 && fuCount <= 1) {
          cadenceHint = "Queued in Today's Schedule as Day 8 Follow-Up.";
        } else if (diff === 4 && fuCount === 0) {
          cadenceHint = "Queued in Today's Schedule as Day 4 Follow-Up.";
        } else if (diff < 4) {
          cadenceHint = `Hidden until Day 4 (${addDays(normalized, 4)}).`;
        } else if (diff < 8) {
          cadenceHint = `Hidden until Day 8 (${addDays(normalized, 8)}).`;
        } else if (diff < 14) {
          cadenceHint = `Hidden until Day 14 (${addDays(normalized, 14)}).`;
        } else {
          cadenceHint = "Beyond Day 14; hidden from Today's Schedule.";
        }

        feedbackMsg = `Saved ${normalized} (${diff} ${diff === 1 ? 'day' : 'days'} ago) as Initial Sent Date for ${l.name} (${l.id}). ID locked · ${cadenceHint}`;

        return {
          ...l,
          initialSentDate: normalized,
          scheduledDate: undefined,
          dispatchDate: normalized,
          dispatchedAt: l.dispatchedAt || `${normalized}T12:00:00`,
          status: 'dispatched' as const,
          dmSent: true,
          dmSentAt: l.dmSentAt || `${normalized}T12:00:00`,
          followup1Date: addDays(normalized, 4),
          followup2Date: addDays(normalized, 8),
          followup3Date: addDays(normalized, 14),
          followupCount: fuCount,
          leadStatus: l.isSeen ? ('seen' as const) : ('waiting_reply' as const),
          cadenceStatus: 'running' as const,
          cancelledReason: undefined,
          cancelledAt: undefined,
          isCompleted: false,
          dismissedDate: undefined,
        };
      }

      // Today or future -> save as scheduledDate (initial outreach or next follow-up)
      feedbackMsg = l.initialSentDate
        ? `Saved ${normalized} as scheduled follow-up date for ${l.name} (${l.id}).`
        : `Scheduled ${l.name} (${l.id}) for ${normalized}.`;

      return {
        ...l,
        scheduledDate: normalized,
        warmupStatus: l.initialSentDate
          ? l.warmupStatus
          : emailOnly
          ? ('warmed' as const)
          : (l.warmupStatus || (l.isWarmedUp ? 'warmed' : 'locked')),
        isWarmedUp: l.initialSentDate ? l.isWarmedUp : emailOnly ? true : l.isWarmedUp,
        dismissedDate: undefined,
      };
    });

    onUpdateLeads(updated);
    if (feedbackMsg) {
      setScheduledBannerMsg(feedbackMsg);
      setTimeout(() => setScheduledBannerMsg(null), 5000);
    }
  };

  /**
   * Auto-Schedule Execution
   * Starts from Today or Tomorrow as selected by the user.
   */
  const handleExecuteAutoSchedule = (startMode: 'today' | 'tomorrow') => {
    setShowAutoScheduleModal(false);
    if (leads.length === 0) return;

    const startDate = startMode === 'today' ? todayStr : addDays(todayStr, 1);
    const dailyQuota = channel === 'instagram' ? 6 : 4;

    const updated = autoScheduleLeads(leads, channel, startDate);
    onUpdateLeads(updated);

    const unsentCount = updated.filter((l) => !l.initialSentDate && l.scheduledDate && l.cadenceStatus !== 'cancelled').length;
    setScheduledBannerMsg(
      `🚀 Auto-scheduled ${unsentCount} leads starting ${startMode === 'today' ? 'Today' : 'Tomorrow'} (${dailyQuota}/day, Sundays & frozen days skipped)!`
    );
    setTimeout(() => setScheduledBannerMsg(null), 4500);
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
            Flat Capacity Model: {channel === 'instagram' ? 'Target 6 leads/day' : 'Target 4 leads/day'} · Global Quota: 10 Combined Touchpoints/Day (Sundays rest). Assign a past date to track leads messaged outside the CRM on the 4/8/14 cadence.
          </p>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto flex-wrap">
          <div className="text-xs font-mono text-slate-400 bg-slate-900/80 px-3 py-1.5 rounded-xl border border-white/10">
            Scheduled: <span className="text-indigo-400 font-bold">{scheduledCount}</span> / {activeSchedulableLeads.length}
            {unscheduledCount > 0 && (
              <span className="text-amber-400 ml-1.5">({unscheduledCount} unscheduled)</span>
            )}
          </div>

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
                  <th className="py-3 px-4 text-left w-72">Scheduled / Cadence Date</th>
                  <th className="py-3 px-4 text-right w-64">Edit Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {leads.map((lead) => {
                  const hasInitialSent = Boolean(lead.initialSentDate);
                  const isPastInitialSent = Boolean(lead.initialSentDate && lead.initialSentDate < todayStr);
                  const hasScheduledDate = Boolean(lead.scheduledDate);
                  const hasAnyDate = hasScheduledDate || hasInitialSent;
                  const resolved = resolveLeadCadenceStep(lead, todayStr);
                  const isDueToday = isDateToday(lead.scheduledDate) || resolved.isFollowupDue;
                  const dayStyle = getScheduleDayStyle(lead.scheduledDate || lead.initialSentDate);
                  const pickerValue = lead.scheduledDate || lead.initialSentDate || '';

                  let nextCadenceLabel: string | null = null;
                  if (hasInitialSent && lead.initialSentDate && !resolved.isFollowupDue) {
                    const days = resolved.daysSinceInitial;
                    if (days < 4) {
                      nextCadenceLabel = `Day ${days} · Next: Day 4 (${addDays(lead.initialSentDate, 4)})`;
                    } else if (days < 8) {
                      nextCadenceLabel = `Day ${days} · Next: Day 8 (${addDays(lead.initialSentDate, 8)})`;
                    } else if (days < 14) {
                      nextCadenceLabel = `Day ${days} · Next: Day 14 (${addDays(lead.initialSentDate, 14)})`;
                    } else {
                      nextCadenceLabel = `Day ${days} · Hidden`;
                    }
                  }

                  return (
                    <tr
                      key={lead.id}
                      className={`hover:bg-white/[0.02] transition-colors ${dayStyle.tintClass} ${
                        isDueToday ? 'ring-1 ring-emerald-500/40 bg-emerald-950/20' : ''
                      }`}
                    >
                      {/* ID */}
                      <td className="py-3.5 px-4 text-left font-mono text-xs tabular-nums">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-md border border-indigo-500/20">
                            {lead.id}
                          </span>
                          {hasInitialSent && (
                            <span
                              className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400"
                              title={
                                isPastInitialSent
                                  ? 'ID Locked: Initial sent date is in the past (already in sequence)'
                                  : 'ID Locked: Already in sequence'
                              }
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

                      {/* Date & Cadence Stage Column */}
                      <td className="py-3.5 px-4 text-left">
                        {lead.cadenceStatus === 'cancelled' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                            Cancelled{lead.cancelledReason ? ` · ${lead.cancelledReason}` : ''}
                          </span>
                        ) : hasInitialSent ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold font-mono border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                                Initial Sent: {formatDateDisplay(lead.initialSentDate)}
                              </span>
                              {resolved.isFollowupDue && resolved.stageNumber && (
                                <span
                                  className={`text-[10px] font-black uppercase font-mono px-1.5 py-0.5 rounded border ${
                                    resolved.stageNumber === 4
                                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                      : resolved.stageNumber === 8
                                      ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                                      : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                                  }`}
                                >
                                  Day {resolved.stageNumber} Due Today
                                </span>
                              )}
                            </div>
                            {nextCadenceLabel && (
                              <span className="text-[11px] font-mono text-slate-400">
                                {nextCadenceLabel}
                              </span>
                            )}
                            {hasScheduledDate && (
                              <span className="text-[11px] font-mono text-indigo-300">
                                Next Follow-Up: {formatDateDisplay(lead.scheduledDate)}
                              </span>
                            )}
                          </div>
                        ) : hasScheduledDate ? (
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold font-mono border ${dayStyle.badgeClass}`}
                            >
                              <span>{formatDateDisplay(lead.scheduledDate)}</span>
                            </span>
                            {isDateToday(lead.scheduledDate) && (
                              <span className="text-[10px] font-black uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse">
                                TODAY
                              </span>
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
                            value={pickerValue}
                            onChange={(e) => handleDateChange(lead.id, e.target.value)}
                            className={`px-3 py-1.5 bg-slate-950 border rounded-lg text-xs font-mono tabular-nums text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all ${
                              hasInitialSent
                                ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
                                : hasScheduledDate
                                ? isDateToday(lead.scheduledDate)
                                  ? 'border-amber-500/50 bg-amber-500/5 text-amber-200'
                                  : 'border-indigo-500/40 bg-indigo-500/5 text-indigo-200'
                                : 'border-white/10'
                            }`}
                          />
                          {hasAnyDate && (
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
    </div>
  );
}
