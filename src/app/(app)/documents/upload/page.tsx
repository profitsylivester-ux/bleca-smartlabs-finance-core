import { requireDocumentPageActor } from '@/lib/documents/page-access';
import DocumentUploadClient from './DocumentUploadClient';

export const metadata = { title: 'Upload document' };

export default async function DocumentUploadPage() {
  await requireDocumentPageActor();
  return <DocumentUploadClient />;
}
