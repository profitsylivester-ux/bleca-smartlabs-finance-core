import { requireDocumentPageActor } from '@/lib/documents/page-access';
import ExpiringDocumentsClient from './ExpiringDocumentsClient';

export const metadata = { title: 'Expiring documents' };

export default async function ExpiringDocumentsPage() {
  await requireDocumentPageActor();
  return <ExpiringDocumentsClient />;
}
