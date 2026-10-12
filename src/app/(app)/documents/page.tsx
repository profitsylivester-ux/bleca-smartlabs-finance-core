import { requireDocumentPageActor } from '@/lib/documents/page-access';
import DocumentsClient from './DocumentsClient';

export const metadata = { title: 'Documents' };

export default async function DocumentsPage() {
  const actor = await requireDocumentPageActor();
  return <DocumentsClient canConfigure={actor.roleCodes.includes('CEO')} />;
}
