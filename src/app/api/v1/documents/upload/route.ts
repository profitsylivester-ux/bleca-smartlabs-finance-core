import { handleDocumentUpload } from '@/lib/documents/http';

export async function POST(request: Request) {
  return handleDocumentUpload(request);
}

