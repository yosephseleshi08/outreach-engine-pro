import React, { useRef, useState } from 'react';
import {
  X,
  Download,
  Upload,
  Trash2,
  Camera,
  ZoomIn,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { ChannelLead, EvidenceImage } from '../types';
import {
  MAX_EVIDENCE_IMAGES,
  getLeadEvidenceImages,
  getEvidenceDownloadFilename,
  addEvidenceImagesToLead,
  replaceEvidenceImageOnLead,
  deleteEvidenceImageFromLead,
  downloadEvidenceImage,
} from '../utils/evidenceStorage';

interface EvidenceViewerModalProps {
  lead: ChannelLead | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdateLead: (updatedLead: ChannelLead) => void;
}

export const EvidenceViewerModal: React.FC<EvidenceViewerModalProps> = ({
  lead,
  isOpen,
  onClose,
  onUpdateLead,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ image: EvidenceImage; index: number } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  if (!isOpen || !lead) return null;

  const images = getLeadEvidenceImages(lead);

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    setIsProcessing(true);
    try {
      const { updatedLead, addedCount, errors } = await addEvidenceImagesToLead(
        lead,
        Array.from(fileList)
      );
      if (addedCount > 0) {
        onUpdateLead(updatedLead);
      }
      if (errors.length > 0) {
        setErrorMsg(errors.join(' '));
      }
    } finally {
      setIsProcessing(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  const handleReplaceFile = async (imageId: string, file: File | undefined) => {
    if (!file) return;
    setErrorMsg(null);
    setIsProcessing(true);
    try {
      const { updatedLead, error } = await replaceEvidenceImageOnLead(lead, imageId, file);
      if (error) {
        setErrorMsg(error);
      } else {
        onUpdateLead(updatedLead);
      }
    } finally {
      setIsProcessing(false);
      const input = replaceInputRefs.current[imageId];
      if (input) input.value = '';
    }
  };

  const handleDelete = (imageId: string) => {
    setErrorMsg(null);
    const updatedLead = deleteEvidenceImageFromLead(lead, imageId);
    onUpdateLead(updatedLead);
    if (zoomedImage?.image.id === imageId) {
      setZoomedImage(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-3xl bg-slate-900 border border-purple-500/40 p-5 sm:p-6 shadow-2xl space-y-4 text-slate-100 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3.5">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs font-bold text-purple-300 bg-purple-500/15 px-2.5 py-0.5 rounded border border-purple-500/30">
                {lead.id}
              </span>
              <span className="text-xs font-mono text-slate-400">
                {images.length} / {MAX_EVIDENCE_IMAGES} Screenshots
              </span>
            </div>
            <h3 className="text-lg font-black text-white font-['Outfit'] mt-1 flex items-center gap-2">
              <span>📸 Evidence Locker: {lead.name}</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Verify your mockup screenshots before sending, or click Download to attach directly to your DM / Email.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer shrink-0"
            aria-label="Close evidence viewer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error Notice */}
        {errorMsg && (
          <div className="p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-amber-300 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Hidden multi-file upload input */}
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,.png,.jpg,.jpeg"
          multiple
          className="hidden"
          onChange={(e) => handleUploadFiles(e.target.files)}
        />

        {/* Evidence Content */}
        {images.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/15 bg-slate-950/60 p-10 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/15 border border-purple-500/30 text-purple-300 flex items-center justify-center mx-auto">
              <Camera className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-200 font-['Outfit']">
                No mockup screenshots stored for {lead.name}
              </p>
              <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
                Upload up to {MAX_EVIDENCE_IMAGES} PNG or JPG screenshots here or in the 📸 Evidence tab so they are ready for Day 8 &amp; Day 14 dispatch.
              </p>
            </div>
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => uploadInputRef.current?.click()}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-lg shadow-indigo-600/25 transition cursor-pointer disabled:opacity-60"
            >
              {isProcessing ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              <span>Upload Evidence</span>
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              {images.map((image, idx) => {
                const downloadName = getEvidenceDownloadFilename(lead.name, idx);
                return (
                  <div
                    key={image.id}
                    className="rounded-2xl border border-white/10 bg-slate-950/80 overflow-hidden flex flex-col justify-between shadow-lg"
                  >
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,.png,.jpg,.jpeg"
                      ref={(el) => {
                        replaceInputRefs.current[image.id] = el;
                      }}
                      className="hidden"
                      onChange={(e) => handleReplaceFile(image.id, e.target.files?.[0])}
                    />

                    {/* Thumbnail */}
                    <div
                      onClick={() => setZoomedImage({ image, index: idx })}
                      className="relative aspect-[16/10] bg-black/50 overflow-hidden group cursor-pointer border-b border-white/5"
                      title="Click to inspect full screenshot"
                    >
                      <img
                        src={image.dataUrl}
                        alt={`${lead.name} Mockup ${idx + 1}`}
                        className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                      />
                      <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/75 border border-white/15 text-[10px] font-mono font-bold text-white">
                        #{idx + 1}
                      </span>
                      <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
                        <span className="px-2.5 py-1 rounded-lg bg-slate-900/90 border border-white/20 text-xs font-bold text-white flex items-center gap-1">
                          <ZoomIn className="w-3.5 h-3.5" />
                          <span>Zoom</span>
                        </span>
                      </div>
                    </div>

                    {/* Footer Controls */}
                    <div className="p-2.5 space-y-2">
                      <div className="text-[11px] font-mono text-slate-400 truncate" title={downloadName}>
                        {downloadName}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => downloadEvidenceImage(image, lead.name, idx)}
                          className="flex-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer shadow-sm"
                          title={`Download ${downloadName}`}
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download</span>
                        </button>
                        <button
                          type="button"
                          disabled={isProcessing}
                          onClick={() => replaceInputRefs.current[image.id]?.click()}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/10 transition cursor-pointer"
                          title="Replace screenshot"
                        >
                          <Upload className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(image.id)}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/15 text-slate-400 hover:text-rose-300 border border-white/10 hover:border-rose-500/30 transition cursor-pointer"
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

            {/* Footer Upload / Close */}
            <div className="flex items-center justify-between pt-2 border-t border-white/10 gap-3 flex-wrap">
              {images.length < MAX_EVIDENCE_IMAGES ? (
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => uploadInputRef.current?.click()}
                  className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-indigo-300 hover:text-white border border-indigo-500/30 text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                >
                  {isProcessing ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5" />
                  )}
                  <span>Upload Evidence ({images.length}/{MAX_EVIDENCE_IMAGES})</span>
                </button>
              ) : (
                <span className="text-xs font-mono text-emerald-400 font-semibold">
                  ✅ 3 / 3 Evidence Slots Filled
                </span>
              )}

              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition cursor-pointer ml-auto"
              >
                Done Verifying
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Full-Size Zoom Overlay */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-[80] bg-black/95 flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            setZoomedImage(null);
          }}
        >
          <div
            className="max-w-5xl max-h-[92vh] w-full rounded-2xl border border-white/15 bg-slate-900 overflow-hidden flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-slate-950">
              <span className="text-xs font-mono font-bold text-slate-200 truncate">
                {getEvidenceDownloadFilename(lead.name, zoomedImage.index)}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadEvidenceImage(zoomedImage.image, lead.name, zoomedImage.index)}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </button>
                <button
                  type="button"
                  onClick={() => setZoomedImage(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-4 bg-black/60 flex items-center justify-center overflow-auto max-h-[82vh]">
              <img
                src={zoomedImage.image.dataUrl}
                alt={`${lead.name} Mockup ${zoomedImage.index + 1}`}
                className="max-w-full max-h-[78vh] object-contain rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
