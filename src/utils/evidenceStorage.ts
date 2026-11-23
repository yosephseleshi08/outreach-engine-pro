import { ChannelLead, EvidenceImage } from '../types';
import { compressImageFile, base64ToPngBlob } from './imageCompressor';

export const MAX_EVIDENCE_IMAGES = 3;

const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g)$/i;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

export function isSupportedEvidenceFile(file: File): boolean {
  if (ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) return true;
  if (!file.type && ALLOWED_IMAGE_EXTENSIONS.test(file.name)) return true;
  return ALLOWED_IMAGE_EXTENSIONS.test(file.name);
}

export function getLeadEvidenceImages(lead: ChannelLead): EvidenceImage[] {
  if (!lead || !Array.isArray(lead.evidenceImages)) return [];
  return lead.evidenceImages.slice(0, MAX_EVIDENCE_IMAGES);
}

export function getLeadEvidenceCount(lead: ChannelLead): number {
  return getLeadEvidenceImages(lead).length;
}

export function getEvidenceSlug(leadName: string): string {
  const cleaned = (leadName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return cleaned || 'lead';
}

export function getEvidenceDownloadFilename(leadName: string, slotIndex: number): string {
  const slug = getEvidenceSlug(leadName);
  return `${slug}-mockup-${slotIndex + 1}.png`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = (e) => {
      const result = e.target?.result;
      if (typeof result === 'string' && result.startsWith('data:image/')) {
        resolve(result);
      } else {
        reject(new Error('Invalid image file content.'));
      }
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Converts an uploaded PNG/JPG file into a Base64 data URL suitable for LocalStorage persistence.
 * Keeps crisp small files intact (< 180KB) and compresses larger screenshots cleanly so LocalStorage quota stays healthy.
 */
export async function processEvidenceFileToBase64(file: File): Promise<string> {
  if (file.size <= 180 * 1024) {
    try {
      return await readFileAsDataUrl(file);
    } catch {
      // Fallback to canvas compression
    }
  }
  return compressImageFile(file, 1280, 0.85);
}

export async function addEvidenceImagesToLead(
  lead: ChannelLead,
  files: File[]
): Promise<{
  updatedLead: ChannelLead;
  addedCount: number;
  errors: string[];
}> {
  const existing = getLeadEvidenceImages(lead);
  const remainingSlots = MAX_EVIDENCE_IMAGES - existing.length;
  const errors: string[] = [];

  if (remainingSlots <= 0) {
    return {
      updatedLead: lead,
      addedCount: 0,
      errors: [`Evidence locker is full (maximum ${MAX_EVIDENCE_IMAGES} images per lead).`],
    };
  }

  const nextImages = [...existing];
  let addedCount = 0;

  for (const file of files) {
    if (nextImages.length >= MAX_EVIDENCE_IMAGES) {
      errors.push(`Skipped "${file.name}" — max ${MAX_EVIDENCE_IMAGES} screenshots allowed per lead.`);
      continue;
    }

    if (!isSupportedEvidenceFile(file)) {
      errors.push(`"${file.name}" is not a PNG or JPG image.`);
      continue;
    }

    try {
      const dataUrl = await processEvidenceFileToBase64(file);
      nextImages.push({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
      });
      addedCount++;
    } catch (err) {
      console.error('Failed to process evidence image:', err);
      errors.push(`Could not process "${file.name}".`);
    }
  }

  if (addedCount === 0) {
    return { updatedLead: lead, addedCount: 0, errors };
  }

  const updatedLead: ChannelLead = {
    ...lead,
    evidenceImages: nextImages,
    hasMockup: nextImages.length > 0,
    mockupUploadedAt: new Date().toISOString(),
  };

  return { updatedLead, addedCount, errors };
}

export async function replaceEvidenceImageOnLead(
  lead: ChannelLead,
  imageId: string,
  file: File
): Promise<{ updatedLead: ChannelLead; error?: string }> {
  if (!isSupportedEvidenceFile(file)) {
    return { updatedLead: lead, error: `"${file.name}" must be a PNG or JPG image.` };
  }

  try {
    const dataUrl = await processEvidenceFileToBase64(file);
    const existing = getLeadEvidenceImages(lead);
    const nextImages = existing.map((img) =>
      img.id === imageId
        ? {
            ...img,
            dataUrl,
            fileName: file.name,
            uploadedAt: new Date().toISOString(),
          }
        : img
    );

    return {
      updatedLead: {
        ...lead,
        evidenceImages: nextImages,
        hasMockup: nextImages.length > 0,
        mockupUploadedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error('Failed to replace evidence image:', err);
    return { updatedLead: lead, error: `Could not process "${file.name}".` };
  }
}

export function deleteEvidenceImageFromLead(
  lead: ChannelLead,
  imageId: string
): ChannelLead {
  const existing = getLeadEvidenceImages(lead);
  const nextImages = existing.filter((img) => img.id !== imageId);

  return {
    ...lead,
    evidenceImages: nextImages,
    hasMockup: nextImages.length > 0,
    mockupUploadedAt: nextImages.length > 0 ? lead.mockupUploadedAt : undefined,
  };
}

export async function downloadEvidenceImage(
  image: EvidenceImage,
  leadName: string,
  slotIndex: number
): Promise<void> {
  const filename = getEvidenceDownloadFilename(leadName, slotIndex);

  try {
    const pngBlob = await base64ToPngBlob(image.dataUrl);
    const url = URL.createObjectURL(pngBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    const a = document.createElement('a');
    a.href = image.dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}
