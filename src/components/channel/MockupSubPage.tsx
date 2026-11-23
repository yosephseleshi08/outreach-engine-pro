import React, { useState, useRef, useMemo } from 'react';
import {
  Upload,
  Camera,
  Download,
  Trash2,
  ExternalLink,
  X,
  AlertCircle,
  RefreshCw,
  ZoomIn,
  Search,
  Image as ImageIcon,
} from 'lucide-react';
import { ChannelLead, EvidenceImage, MultiChannelType } from '../../types';
import { getChannelLabel, getPlatformLink } from '../../utils/channelStorage';
import {
  MAX_EVIDENCE_IMAGES,
  getLeadEvidenceImages,
  getEvidenceDownloadFilename,
  addEvidenceImagesToLead,
  replaceEvidenceImageOnLead,
  deleteEvidenceImageFromLead,
  downloadEvidenceImage,
} from '../../utils/evidenceStorage';
import { TestLinkButton } from '../TestLinkButton';

interface MockupSubPageProps {
  channel: MultiChannelType;
  leads: ChannelLead[];
  onUpdateLeads: (leads: ChannelLead[]) => void;
}

export function MockupSubPage({ channel, leads, onUpdateLeads }: MockupSubPageProps) {
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({});
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'with_evidence' | 'missing'>('all');
  const [zoomModal, setZoomModal] = useState<{
    leadName: string;
    image: EvidenceImage;
    index: number;
  } | null>(null);

  const uploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const replaceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const persistUpdatedLead = (updatedLead: ChannelLead) => {
    try {
      const updated = leads.map((l) => (l.id === updatedLead.id ? updatedLead : l));
      onUpdateLeads(updated);
    } catch (err) {
      console.error('Failed to persist evidence to LocalStorage:', err);
      setErrorBanner(
        'Browser LocalStorage quota exceeded. Delete unused screenshots from older leads to free up space.'
      );
    }
  };

  const handleUploadEvidence = async (lead: ChannelLead, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorBanner(null);
    setLoadingKeys((prev) => ({ ...prev, [lead.id]: true }));

    try {
      const { updatedLead, addedCount, errors } = await addEvidenceImagesToLead(
        lead,
        Array.from(fileList)
      );
      if (addedCount > 0) {
        persistUpdatedLead(updatedLead);
      }
      if (errors.length > 0) {
        setErrorBanner(errors.join(' '));
      }
    } finally {
      setLoadingKeys((prev) => ({ ...prev, [lead.id]: false }));
      const input = uploadInputRefs.current[lead.id];
      if (input) input.value = '';
    }
  };

  const handleReplaceEvidence = async (
    lead: ChannelLead,
    imageId: string,
    file: File | undefined
  ) => {
    if (!file) return;
    setErrorBanner(null);
    setLoadingKeys((prev) => ({ ...prev, [lead.id]: true }));

    try {
      const { updatedLead, error } = await replaceEvidenceImageOnLead(lead, imageId, file);
      if (error) {
        setErrorBanner(error);
      } else {
        persistUpdatedLead(updatedLead);
      }
    } finally {
      setLoadingKeys((prev) => ({ ...prev, [lead.id]: false }));
      const input = replaceInputRefs.current[`${lead.id}:${imageId}`];
      if (input) input.value = '';
    }
  };

  const handleDeleteEvidence = (lead: ChannelLead, imageId: string) => {
    setErrorBanner(null);
    const updatedLead = deleteEvidenceImageFromLead(lead, imageId);
    persistUpdatedLead(updatedLead);
    if (zoomModal?.image.id === imageId) {
      setZoomModal(null);
    }
  };

  const leadsWithEvidenceCount = leads.filter((l) => getLeadEvidenceImages(l).length > 0).length;
  const totalScreenshotsCount = leads.reduce(
    (sum, l) => sum + getLeadEvidenceImages(l).length,
    0
  );

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

  const filteredLeads = useMemo(() => {
    return sortedLeads.filter((lead) => {
      const count = getLeadEvidenceImages(lead).length;
      if (filterMode === 'with_evidence' && count === 0) return false;
      if (filterMode === 'missing' && count > 0) return false;

      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        lead.name.toLowerCase().includes(q) ||
        lead.id.toLowerCase().includes(q) ||
        (lead.link || '').toLowerCase().includes(q)
      );
    });
  }, [sortedLeads, filterMode, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white font-['Outfit'] flex items-center gap-2">
            <span>📸 {getChannelLabel(channel)} Evidence Locker</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Upload and store up to 3 mockup screenshots (PNG, JPG) per lead in LocalStorage for instant Day 8 &amp; Day 14 download.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono text-slate-400 bg-slate-950/60 px-3.5 py-2 rounded-xl border border-white/10 self-start sm:self-auto">
          <span>
            Leads ready:{' '}
            <strong className="text-indigo-400 tabular-nums">{leadsWithEvidenceCount}</strong> /{' '}
            <span className="tabular-nums">{leads.length}</span>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            Screenshots:{' '}
            <strong className="text-purple-300 tabular-nums">{totalScreenshotsCount}</strong>
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {errorBanner && (
        <div className="p-3.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="text-amber-300 hover:text-white cursor-pointer p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search & Filter Controls */}
      {leads.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search lead ID or business name..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-900/90 border border-white/10 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div className="flex items-center gap-1.5 bg-slate-900/80 p-1 rounded-xl border border-white/10 self-start sm:self-auto">
            {(
              [
                { id: 'all', label: `All (${leads.length})` },
                { id: 'with_evidence', label: `With Evidence (${leadsWithEvidenceCount})` },
                { id: 'missing', label: `Missing (${leads.length - leadsWithEvidenceCount})` },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFilterMode(opt.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  filterMode === opt.id
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {leads.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/50 p-12 text-center text-slate-400">
          <Camera className="w-8 h-8 text-slate-600 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-300">No leads available for evidence</p>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            Add prospect leads in the "Leads" sub-tab first to store mockup screenshots here.
          </p>
        </div>
      ) : filteredLeads.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/50 p-10 text-center text-slate-400">
          <ImageIcon className="w-7 h-7 text-slate-600 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-300">No matching leads</p>
          <p className="text-xs text-slate-500 mt-1">
            Adjust your search or filter to see other leads in this workspace.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredLeads.map((lead) => {
            const isLoading = Boolean(loadingKeys[lead.id]);
            const images = getLeadEvidenceImages(lead);
            const remainingSlots = MAX_EVIDENCE_IMAGES - images.length;

            return (
              <div
                key={lead.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files?.length && remainingSlots > 0) {
                    handleUploadEvidence(lead, e.dataTransfer.files);
                  }
                }}
                className="rounded-2xl border border-white/[0.08] bg-slate-900/60 backdrop-blur-sm p-4 sm:p-5 shadow-xl space-y-4 hover:border-indigo-500/30 transition"
              >
                {/* Hidden Multi-File Upload Input */}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,.png,.jpg,.jpeg"
                  multiple
                  ref={(el) => {
                    uploadInputRefs.current[lead.id] = el;
                  }}
                  className="hidden"
                  onChange={(e) => handleUploadEvidence(lead, e.target.files)}
                />

                {/* Lead Header Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.06] pb-3.5">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-mono text-xs font-semibold text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-md border border-indigo-500/20">
                        {lead.id}
                      </span>
                      <h3 className="font-bold text-sm sm:text-base text-slate-100 font-['Outfit'] truncate">
                        {lead.name}
                      </h3>
                      <span
                        className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                          images.length > 0
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-white/5 text-slate-400 border-white/10'
                        }`}
                      >
                        {images.length} / {MAX_EVIDENCE_IMAGES} Uploaded
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={getPlatformLink(lead.platformLink || lead.link, lead.channel || channel)}
                        target={
                          getPlatformLink(lead.platformLink || lead.link, lead.channel || channel).startsWith(
                            'mailto:'
                          )
                            ? '_self'
                            : '_blank'
                        }
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-indigo-400 transition-colors truncate max-w-xs"
                        title={`Open ${lead.platformLink || lead.link}`}
                      >
                        <span className="truncate">{lead.platformLink || lead.link}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                      <TestLinkButton lead={lead} platform={lead.channel || channel} />
                    </div>
                  </div>

                  {/* Upload Evidence CTA */}
                  <div className="flex items-center gap-2 shrink-0">
                    {isLoading ? (
                      <div className="px-3.5 py-2 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-semibold flex items-center gap-2">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Saving screenshot...</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={remainingSlots <= 0}
                        onClick={() => uploadInputRefs.current[lead.id]?.click()}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                          remainingSlots > 0
                            ? 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-md shadow-indigo-600/30 cursor-pointer active:scale-95'
                            : 'bg-slate-800 text-slate-500 border border-white/5 cursor-not-allowed'
                        }`}
                        title={
                          remainingSlots > 0
                            ? `Upload PNG or JPG screenshots (${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} remaining)`
                            : 'Maximum 3 screenshots stored. Delete or replace an image to change.'
                        }
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {remainingSlots > 0 ? 'Upload Evidence' : 'Locker Full (3/3)'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Thumbnails Grid (Up to 3) */}
                {images.length === 0 ? (
                  <div
                    onClick={() => uploadInputRefs.current[lead.id]?.click()}
                    className="rounded-xl border border-dashed border-white/10 hover:border-indigo-500/40 bg-slate-950/40 hover:bg-indigo-950/10 p-5 text-center cursor-pointer transition flex flex-col sm:flex-row items-center justify-center gap-2 text-xs text-slate-400"
                  >
                    <Camera className="w-4 h-4 text-slate-500" />
                    <span>
                      No mockup screenshots stored yet. Click <strong className="text-indigo-300">Upload Evidence</strong> or drop PNG/JPG files here (up to 3).
                    </span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                    {images.map((image, idx) => {
                      const downloadFilename = getEvidenceDownloadFilename(lead.name, idx);
                      const replaceKey = `${lead.id}:${image.id}`;

                      return (
                        <div
                          key={image.id}
                          className="rounded-xl border border-white/10 bg-slate-950/75 overflow-hidden flex flex-col justify-between shadow-md"
                        >
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/jpg,.png,.jpg,.jpeg"
                            ref={(el) => {
                              replaceInputRefs.current[replaceKey] = el;
                            }}
                            className="hidden"
                            onChange={(e) =>
                              handleReplaceEvidence(lead, image.id, e.target.files?.[0])
                            }
                          />

                          {/* Thumbnail Preview */}
                          <div
                            onClick={() => setZoomModal({ leadName: lead.name, image, index: idx })}
                            className="relative aspect-[16/10] bg-black/50 overflow-hidden group cursor-pointer border-b border-white/5"
                            title="Click to inspect full screenshot"
                          >
                            <img
                              src={image.dataUrl}
                              alt={`${lead.name} mockup ${idx + 1}`}
                              className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                            />
                            <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/75 border border-white/15 text-[10px] font-mono font-bold text-white">
                              #{idx + 1}
                            </span>
                            <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                              <span className="px-2.5 py-1 rounded-lg bg-slate-900/90 border border-white/20 text-xs font-bold text-white flex items-center gap-1">
                                <ZoomIn className="w-3.5 h-3.5" />
                                <span>Preview</span>
                              </span>
                            </div>
                          </div>

                          {/* Thumbnail Info + Download / Replace / Delete */}
                          <div className="p-2.5 space-y-2">
                            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                              <span className="truncate text-slate-300" title={downloadFilename}>
                                {downloadFilename}
                              </span>
                              <span className="text-[10px] text-slate-500 shrink-0">
                                {new Date(image.uploadedAt).toLocaleDateString()}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => downloadEvidenceImage(image, lead.name, idx)}
                                className="flex-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer shadow-sm"
                                title={`Download ${downloadFilename}`}
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Download</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => replaceInputRefs.current[replaceKey]?.click()}
                                className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 text-xs font-semibold transition cursor-pointer flex items-center gap-1"
                                title="Replace this image"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                <span className="hidden lg:inline">Replace</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeleteEvidence(lead, image.id)}
                                className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/15 text-slate-400 hover:text-rose-400 border border-white/10 hover:border-rose-500/30 transition cursor-pointer"
                                title="Delete screenshot"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Fullscreen Lightbox Preview Modal */}
      {zoomModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in"
          onClick={() => setZoomModal(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[90vh] rounded-3xl bg-slate-900 border border-white/15 shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 bg-slate-950/90">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="font-bold text-sm text-white font-['Outfit'] truncate">
                  📸 {zoomModal.leadName} — Mockup #{zoomModal.index + 1}
                </span>
                <span className="text-xs font-mono text-slate-400 hidden sm:inline">
                  ({getEvidenceDownloadFilename(zoomModal.leadName, zoomModal.index)})
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    downloadEvidenceImage(zoomModal.image, zoomModal.leadName, zoomModal.index)
                  }
                  className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </button>
                <button
                  type="button"
                  onClick={() => setZoomModal(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-4 bg-black/60 flex items-center justify-center overflow-auto max-h-[80vh]">
              <img
                src={zoomModal.image.dataUrl}
                alt={`${zoomModal.leadName} Mockup ${zoomModal.index + 1}`}
                className="max-w-full max-h-[75vh] object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
