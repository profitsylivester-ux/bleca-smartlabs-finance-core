import { requireBudgetPageActor } from '@/lib/budgets/page-access';
import BudgetTransfersClient from './BudgetTransfersClient';

export const metadata = { title: 'Budget transfers' };

export default async function BudgetTransfersPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireBudgetPageActor();
  const { id } = await params;
  return <BudgetTransfersClient budgetId={id} actor={{ roleCodes: actor.roleCodes }} />;
}
