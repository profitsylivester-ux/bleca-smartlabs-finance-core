import { requireDocumentPageActor } from '@/lib/documents/page-access';
import DocumentDetailClient from './DocumentDetailClient';

export const metadata = { title: 'Document details' };

export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireDocumentPageActor();
  const { id } = await params;
  return <DocumentDetailClient documentId={id} roleCodes={actor.roleCodes} />;
}
