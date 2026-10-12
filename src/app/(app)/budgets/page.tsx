import { requireBudgetPageActor } from '@/lib/budgets/page-access';
import BudgetsClient from './BudgetsClient';

export const metadata = { title: 'Budgets' };

export default async function BudgetsPage() {
  const actor = await requireBudgetPageActor();
  return <BudgetsClient actor={{ roleCodes: actor.roleCodes }} />;
}
