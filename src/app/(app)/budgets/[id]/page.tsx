import { requireBudgetPageActor } from '@/lib/budgets/page-access';
import BudgetDetailClient from './BudgetDetailClient';

export const metadata = { title: 'Budget details' };

export default async function BudgetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireBudgetPageActor();
  const { id } = await params;
  return <BudgetDetailClient budgetId={id} actor={{ roleCodes: actor.roleCodes }} />;
}
