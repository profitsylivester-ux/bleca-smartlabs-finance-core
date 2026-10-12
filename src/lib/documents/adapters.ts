import type { DocumentOcrStatus } from '@/generated/prisma/client';

export interface VirusScanInput {
  fileName: string;
  mimeType: string;
  byteLength: number;
}

export type VirusScanAdapter = (input: VirusScanInput) => Promise<{ clean: boolean }>;

/** M12 pass-through only; Phase 3 can replace this function with a scanner. */
export const scanDocumentUpload: VirusScanAdapter = async (input) => {
  console.info('[documents] virus scan adapter stub: upload passed through', {
    fileName: input.fileName,
    mimeType: input.mimeType,
    byteLength: input.byteLength,
  });
  return { clean: true };
};

export interface OcrInput {
  documentId: string;
  storageKey: string;
  mimeType: string;
}

export interface OcrResult {
  status: DocumentOcrStatus;
  text: string | null;
  confidence: number | null;
}

export interface OcrAdapter {
  process(input: OcrInput): Promise<OcrResult>;
}

/** M12 contract; Phase 3 can supply a real OCR adapter without schema changes. */
export const stubOcrAdapter: OcrAdapter = {
  async process() {
    return { status: 'NOT_RUN', text: null, confidence: null };
  },
};
