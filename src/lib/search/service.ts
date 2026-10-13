import { prisma } from '@/lib/db/prisma';
import type { RequestContext } from '@/lib/kernel/context';
import { authorize, loadAuthorization } from '@/lib/kernel/authorize';
import { checkPermission } from '@/lib/rbac/permissions';

/**
 * Global search (M16, PDF §53). Permission-aware: a target is queried only
 * when the actor holds VIEW on its module. Never leaks via counts either —
 * an unauthorised target returns zero rows, not an error naming it.
 */

export interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const KIND_MODULE = {
  transaction: 'TRANSACTIONS',
  invoice: 'INVOICES',
  customer: 'CUSTOMERS',
  supplier: 'SUPPLIERS',
  budget: 'BUDGETS',
  document: 'DOCUMENTS',
  project: 'MASTER_DATA',
  journal: 'JOURNAL_ENTRIES',
  account: 'CHART_OF_ACCOUNTS',
} as const;

type SearchKind = keyof typeof KIND_MODULE;

export async function globalSearch(ctx: RequestContext, query: string): Promise<SearchHit[]> {
  await authorize(ctx, { module: 'SEARCH', action: 'VIEW' });
  const q = query.trim();
  if (q.length < 2 || !ctx.actor.organizationId) return [];
  const orgId = ctx.actor.organizationId;
  const { permissions } = await loadAuthorization(ctx);
  const can = (kind: SearchKind): boolean =>
    checkPermission(permissions, KIND_MODULE[kind] as never, 'VIEW' as never).granted;

  const hits: SearchHit[] = [];
  if (can('transaction')) {
    const rows = await prisma.transaction.findMany({
      where: { organizationId: orgId, OR: [{ number: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }, { reference: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, number: true, description: true, amount: true, currencyCode: true },
    });
    for (const r of rows) {
      hits.push({ kind: 'transaction', id: r.id, title: r.number ?? r.id.slice(0, 8), subtitle: r.description ?? `${r.currencyCode} ${r.amount.toString()}`, href: `/transactions/${r.id}` });
    }
  }
  if (can('invoice')) {
    const rows = await prisma.invoice.findMany({
      where: { organizationId: orgId, OR: [{ number: { contains: q, mode: 'insensitive' } }, { reference: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, number: true, direction: true, totalAmount: true, currencyCode: true },
    });
    for (const r of rows) {
      hits.push({ kind: 'invoice', id: r.id, title: r.number, subtitle: `${r.direction} · ${r.currencyCode} ${r.totalAmount.toString()}`, href: `/sales/invoices/${r.id}` });
    }
  }
  if (can('customer')) {
    const rows = await prisma.customer.findMany({
      where: { organizationId: orgId, OR: [{ party: { displayName: { contains: q, mode: 'insensitive' } } }, { party: { code: { contains: q, mode: 'insensitive' } } }] },
      take: 5,
      select: { id: true, party: { select: { displayName: true, code: true } } },
    });
    for (const r of rows) hits.push({ kind: 'customer', id: r.id, title: r.party.displayName, subtitle: r.party.code, href: `/customers/${r.id}` });
  }
  if (can('supplier')) {
    const rows = await prisma.supplier.findMany({
      where: { organizationId: orgId, OR: [{ party: { displayName: { contains: q, mode: 'insensitive' } } }, { party: { code: { contains: q, mode: 'insensitive' } } }] },
      take: 5,
      select: { id: true, party: { select: { displayName: true, code: true } } },
    });
    for (const r of rows) hits.push({ kind: 'supplier', id: r.id, title: r.party.displayName, subtitle: r.party.code, href: `/suppliers/${r.id}` });
  }
  if (can('budget')) {
    const rows = await prisma.budget.findMany({
      where: { organizationId: orgId, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, name: true, code: true },
    });
    for (const r of rows) hits.push({ kind: 'budget', id: r.id, title: r.name, subtitle: r.code, href: `/budgets/${r.id}` });
  }
  if (can('document')) {
    const rows = await prisma.document.findMany({
      where: { organizationId: orgId, deletedAt: null, OR: [{ title: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, title: true, category: true },
    });
    for (const r of rows) hits.push({ kind: 'document', id: r.id, title: r.title, subtitle: r.category, href: `/documents/${r.id}` });
  }
  if (can('journal')) {
    const rows = await prisma.journalEntry.findMany({
      where: { organizationId: orgId, OR: [{ number: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, number: true, description: true },
    });
    for (const r of rows) hits.push({ kind: 'journal', id: r.id, title: r.number ?? r.id.slice(0, 8), subtitle: r.description ?? '', href: `/accounting/journal/${r.id}` });
  }
  if (can('account')) {
    const rows = await prisma.account.findMany({
      where: { organizationId: orgId, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, name: true, code: true },
    });
    for (const r of rows) hits.push({ kind: 'account', id: r.id, title: `${r.code} ${r.name}`, subtitle: r.code, href: `/accounting/chart/${r.id}` });
  }
  if (can('project')) {
    const rows = await prisma.project.findMany({
      where: { organizationId: orgId, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] },
      take: 5,
      select: { id: true, name: true, code: true },
    });
    for (const r of rows) hits.push({ kind: 'project', id: r.id, title: r.name, subtitle: r.code, href: `/master-data/projects/${r.id}` });
  }
  return hits.slice(0, 30);
}
