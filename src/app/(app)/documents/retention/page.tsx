import { requireDocumentPageActor } from '@/lib/documents/page-access';
import RetentionPoliciesClient from './RetentionPoliciesClient';

export const metadata = { title: 'Document retention policies' };

export default async function RetentionPoliciesPage() {
  const actor = await requireDocumentPageActor();
  return <RetentionPoliciesClient canConfigure={actor.roleCodes.includes('CEO')} />;
}
