import { requireBudgetPageActor } from '@/lib/budgets/page-access';
import BudgetScenariosClient from './BudgetScenariosClient';

export const metadata = { title: 'Budget scenarios' };

export default async function BudgetScenariosPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireBudgetPageActor();
  const { id } = await params;
  return <BudgetScenariosClient budgetId={id} actor={{ roleCodes: actor.roleCodes }} />;
}
