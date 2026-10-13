import { prisma } from '@/lib/db/prisma';
import { dec, type Scope } from './internal';
import type { ReportFilters, ReportResult, ReportRow } from './types';

/** COMPLIANCE report builders (PDF §47) — delegate to M12/M13 data. */

export async function buildTaxReport(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const obligations = await prisma.taxObligation.findMany({
    where: { organizationId: scope.organizationId },
    include: { taxRule: { select: { code: true, name: true } }, payments: { select: { amount: true } } },
    orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
  });

  const rows: ReportRow[] = obligations.map((o) => {
    const paid = o.payments.reduce((s, p) => s.plus(dec(p.amount)), dec(0));
    const outstanding = dec(o.taxAmount).minus(paid);
    return {
      id: o.id,
      cells: {
        period: o.period,
        rule: o.taxRule ? `${o.taxRule.code} ${o.taxRule.name}` : 'Unassigned',
        direction: o.direction,
        status: o.status,
        taxable: { amount: o.taxableAmount.toString(), currency: o.currencyCode, unverified: [] },
        tax: { amount: o.taxAmount.toString(), currency: o.currencyCode, unverified: [] },
        outstanding: { amount: outstanding.toString(), currency: o.currencyCode, unverified: [] },
      },
    };
  });

  return {
    reportKey: 'tax-report', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'tax', label: 'Tax obligations', columns: [
      { key: 'period', label: 'Period', type: 'text' },
      { key: 'rule', label: 'Rule', type: 'text' },
      { key: 'direction', label: 'Direction', type: 'badge' },
      { key: 'status', label: 'Status', type: 'badge' },
      { key: 'taxable', label: 'Taxable', type: 'amount', currency },
      { key: 'tax', label: 'Tax', type: 'amount', currency },
      { key: 'outstanding', label: 'Outstanding', type: 'amount', currency },
    ], rows }],
    checks: [], hasUnverified: false,
  };
}

export async function buildComplianceStatus(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const { getComplianceStatus } = await import('@/lib/tax-compliance/service');
  const status = await getComplianceStatus(ctx as Parameters<typeof getComplianceStatus>[0]);

  const alertRows: ReportRow[] = [];
  for (const warning of status.warnings) {
    alertRows.push({ id: warning.code, cells: { item: warning.message, status: 'WARNING', detail: warning.code } });
  }
  for (const obligation of status.obligations) {
    alertRows.push({
      id: obligation.id,
      cells: {
        item: `${obligation.taxRule?.code ?? '—'} ${obligation.period}`,
        status: obligation.status,
        detail: obligation.filingDueDate ? obligation.filingDueDate.toISOString().slice(0, 10) : '',
      },
    });
  }

  return {
    reportKey: 'compliance-status', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [
      { key: 'registration', label: `Registration: ${status.registrationStatus}`, columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'count', label: 'Count', type: 'text' }], rows: [
        { id: 'unverified-rules', cells: { metric: 'Unverified tax rules', count: status.counts.unverifiedRules } },
        { id: 'overdue', cells: { metric: 'Overdue obligations', count: status.counts.overdueObligations } },
        { id: 'expiring-credentials', cells: { metric: 'Expiring credentials', count: status.counts.expiringCredentials } },
        { id: 'expiring-documents', cells: { metric: 'Expiring documents', count: status.counts.expiringDocuments } },
      ] },
      { key: 'alerts', label: 'Compliance alerts', columns: [{ key: 'item', label: 'Item', type: 'text' }, { key: 'status', label: 'Status', type: 'badge' }, { key: 'detail', label: 'Detail', type: 'text' }], rows: alertRows },
    ],
    checks: [], hasUnverified: false,
  };
}

export async function buildExpiringDocuments(
  ctx: unknown,
  scope: Scope,
  filters: ReportFilters,
  title: string,
  category: ReportResult['category'],
): Promise<ReportResult> {
  const currency = filters.currency ?? scope.baseCurrency;
  const now = new Date();
  const horizon = new Date(now.getTime() + 90 * 86_400_000);

  const [documents, credentials] = await Promise.all([
    prisma.document.findMany({
      where: { organizationId: scope.organizationId, deletedAt: null, expiryDate: { lte: horizon } },
      select: { id: true, title: true, category: true, expiryDate: true },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.credential.findMany({
      where: { organizationId: scope.organizationId, status: { notIn: ['REVOKED', 'NOT_APPLICABLE'] }, expiryDate: { lte: horizon } },
      select: { id: true, title: true, type: true, expiryDate: true },
      orderBy: { expiryDate: 'asc' },
    }),
  ]);

  const rows: ReportRow[] = [
    ...documents.map((d) => ({ id: d.id, cells: { item: d.title, kind: `Document · ${d.category}`, expiry: d.expiryDate ? d.expiryDate.toISOString().slice(0, 10) : '' } })),
    ...credentials.map((c) => ({ id: c.id, cells: { item: c.title, kind: `Credential · ${c.type}`, expiry: c.expiryDate ? c.expiryDate.toISOString().slice(0, 10) : '' } })),
  ];

  return {
    reportKey: 'expiring-documents', title, category,
    generatedAt: new Date().toISOString(), currency, filters,
    sections: [{ key: 'expiring', label: 'Expiring within 90 days', columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'kind', label: 'Kind', type: 'text' },
      { key: 'expiry', label: 'Expires', type: 'date' },
    ], rows }],
    checks: [], hasUnverified: false,
  };
}
