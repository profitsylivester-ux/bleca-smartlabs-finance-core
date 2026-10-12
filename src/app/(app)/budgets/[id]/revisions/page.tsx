import { requireBudgetPageActor } from '@/lib/budgets/page-access';
import BudgetRevisionsClient from './BudgetRevisionsClient';

export const metadata = { title: 'Budget revisions' };

export default async function BudgetRevisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireBudgetPageActor();
  const { id } = await params;
  return <BudgetRevisionsClient budgetId={id} actor={{ roleCodes: actor.roleCodes }} />;
}
