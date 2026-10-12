import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { RequestContext } from '@/lib/kernel/context';
import { prisma as appPrisma } from '@/lib/db/prisma';
import { ConflictError } from '@/lib/kernel/errors';
import { assertSupplierPaymentAllowed, bankAccountLast4, encryptBankAccountNumber, evaluateCustomerInvoiceCredit } from '@/lib/parties/security';
import { requireContext } from '@/lib/auth/guard';
import { seedTestFixtures } from '../setup/fixtures';
import { POST as releaseCustomer } from '@/app/api/v1/customers/[id]/release/route';
import { GET as getCustomerAging } from '@/app/api/v1/customers/[id]/aging/route';
import { POST as requestBankChange } from '@/app/api/v1/suppliers/[id]/bank-details/route';
import { POST as verifyBankChange } from '@/app/api/v1/suppliers/[id]/bank-detail-changes/[changeId]/verify/route';
import { POST as approveBankChange } from '@/app/api/v1/suppliers/[id]/bank-detail-changes/[changeId]/approve/route';
import { POST as rejectBankChange } from '@/app/api/v1/suppliers/[id]/bank-detail-changes/[changeId]/reject/route';

vi.mock('@/lib/auth/guard', () => ({ requireContext: vi.fn() }));
vi.mock('@/lib/kernel/authorize', () => ({ authorize: vi.fn(async () => undefined) }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const prisma = new PrismaClient();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const evidenceDocumentId = `c${'a'.repeat(24)}`;
let organizationId: string;
let requester: TestUser;
let verifier: TestUser;
let approver: TestUser;

type TestUser = { id: string; email: string; fullName: string; roleCodes: string[] };

beforeAll(async () => {
  await seedTestFixtures(prisma);
  organizationId = (await prisma.organization.findUniqueOrThrow({ where: { code: 'BLECA' }, select: { id: true } })).id;
  const [financeRole, ceoRole] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { code: 'FINANCE_OFFICER' }, select: { id: true } }),
    prisma.role.findUniqueOrThrow({ where: { code: 'CEO' }, select: { id: true } }),
  ]);
  requester = await createTestUser('requester', financeRole.id, 'FINANCE_OFFICER');
  verifier = await createTestUser('verifier', financeRole.id, 'FINANCE_OFFICER');
  approver = await createTestUser('approver', ceoRole.id, 'CEO');
});

afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('M10 customer credit and supplier payment security', () => {
  it('creates a credit hold and blocks an invoice that exceeds the customer limit', async () => {
    const customer = await createCustomer({ creditLimit: '100' });
    await prisma.customerReceivable.create({
      data: {
        organizationId, customerId: customer.id, invoiceReference: `M10-EXIST-${suffix}`,
        currencyCode: 'TZS', originalAmount: '80', outstandingAmount: '80',
        issuedAt: new Date(), dueAt: new Date(Date.now() + 86_400_000),
      },
    });

    const result = await prisma.$transaction((tx) => evaluateCustomerInvoiceCredit(tx, {
      organizationId, customerId: customer.id, invoiceAmount: '30',
      actor: { id: requester.id, name: requester.fullName, roleCodes: requester.roleCodes },
    }));

    expect(result.allowed).toBe(false);
    expect(result.creditHoldCreated).toBe(true);
    expect(result.currentExposure).toBe('80');
    expect(result.projectedExposure).toBe('110');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).status).toBe('CREDIT_HOLD');
    expect(await prisma.customerCreditHold.count({ where: { customerId: customer.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('blocks invoicing during a credit hold and allows it again after approved release', async () => {
    const customer = await createCustomer({ creditLimit: '100', status: 'CREDIT_HOLD' });
    await prisma.customerCreditHold.create({
      data: { customerId: customer.id, previousCustomerStatus: 'ACTIVE', reason: 'Temporary risk review hold', requestedById: requester.id },
    });
    const held = await prisma.$transaction((tx) => evaluateCustomerInvoiceCredit(tx, {
      organizationId, customerId: customer.id, invoiceAmount: '25', actor: { id: requester.id, name: requester.fullName, roleCodes: requester.roleCodes },
    }));
    expect(held.allowed).toBe(false);
    expect(held.reason).toContain('credit hold');

    setActor(approver);
    const released = await releaseCustomer(postRequest({ reason: 'Risk review completed with supporting evidence' }, `release-${suffix}`), { params: Promise.resolve({ id: customer.id }) });
    expect(released.status).toBe(200);
    const allowed = await prisma.$transaction((tx) => evaluateCustomerInvoiceCredit(tx, {
      organizationId, customerId: customer.id, invoiceAmount: '25', actor: { id: requester.id, name: requester.fullName, roleCodes: requester.roleCodes },
    }));
    expect(allowed.allowed).toBe(true);
  });

  it('requires a reason for credit hold release and records the release audit', async () => {
    const customer = await createCustomer({ creditLimit: '100', status: 'CREDIT_HOLD' });
    const hold = await prisma.customerCreditHold.create({
      data: { customerId: customer.id, previousCustomerStatus: 'ACTIVE', reason: 'Manual review requested', requestedById: requester.id },
      select: { id: true },
    });
    setActor(approver);
    const missingReason = await releaseCustomer(postRequest({}, `release-missing-${suffix}`), { params: Promise.resolve({ id: customer.id }) });
    expect(missingReason.status).toBe(422);

    const response = await releaseCustomer(postRequest({ reason: 'Independent approval after collection review' }, `release-audit-${suffix}`), { params: Promise.resolve({ id: customer.id }) });
    expect(response.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'CUSTOMER_CREDIT_HOLD', entityId: hold.id, action: 'CUSTOMER_CREDIT_HOLD_RELEASED' }, select: { id: true, description: true } });
    expect(audit?.description).toContain('Released customer');
  });

  it('preserves the previous supplier account values before a change is applied', async () => {
    const supplier = await createSupplier();
    const oldAccountNumber = '1029384756';
    const oldDetail = await prisma.supplierBankDetail.create({
      data: {
        supplierId: supplier.id, bankName: 'Original Bank', accountHolderName: 'BLECA',
        accountNumberEncrypted: encryptBankAccountNumber(oldAccountNumber), accountNumberLast4: bankAccountLast4(oldAccountNumber),
        currencyCode: 'TZS', isPrimary: true, isActive: true,
      }, select: { id: true, accountNumberEncrypted: true },
    });
    const response = await createBankChange(supplier.id, requester, `preserve-${suffix}`);
    expect(response.status).toBe(201);
    const payload = await response.json() as { data: { id: string } };
    const change = await prisma.supplierBankDetailChangeRequest.findUniqueOrThrow({ where: { id: payload.data.id } });
    expect(change.previousValues).toMatchObject({ bankName: 'Original Bank', accountNumberLast4: '4756', bankDetailId: oldDetail.id });
    expect((await prisma.supplierBankDetail.findUniqueOrThrow({ where: { id: oldDetail.id } })).accountNumberEncrypted).toBe(oldDetail.accountNumberEncrypted);
    expect((await prisma.supplierBankDetail.findUniqueOrThrow({ where: { id: oldDetail.id } })).isActive).toBe(true);
  });

  it('prevents the requester from approving their own bank detail change', async () => {
    const supplier = await createSupplier();
    const requestResponse = await createBankChange(supplier.id, requester, `self-request-${suffix}`);
    const requestBody = await requestResponse.json() as { data: { id: string } };
    const changeId = requestBody.data.id;
    setActor(verifier);
    const verifyResponse = await verifyBankChange(postRequest({ verificationNotes: 'Independent callback verified against supplier records' }, `self-verify-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    expect(verifyResponse.status).toBe(200);

    setActor(requester);
    const approval = await approveBankChange(postRequest({ reason: 'Requester must not approve this change' }, `self-approve-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    expect(approval.status).toBe(409);
    expect((await prisma.supplierBankDetailChangeRequest.findUniqueOrThrow({ where: { id: changeId } })).status).toBe('APPROVAL_PENDING');
  });

  it('blocks supplier payments while bank details are pending and unblocks after rejection', async () => {
    const supplier = await createSupplier();
    await createBankChange(supplier.id, requester, `payment-block-${suffix}`);
    await expect(prisma.$transaction((tx) => assertSupplierPaymentAllowed(tx, organizationId, supplier.id))).rejects.toBeInstanceOf(ConflictError);

    const change = await prisma.supplierBankDetailChangeRequest.findFirstOrThrow({ where: { supplierId: supplier.id }, select: { id: true } });
    setActor(verifier);
    const rejection = await rejectBankChange(postRequest({ reason: 'Supplier failed independent account verification' }, `payment-reject-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId: change.id }) });
    expect(rejection.status).toBe(200);
    await expect(prisma.$transaction((tx) => assertSupplierPaymentAllowed(tx, organizationId, supplier.id))).resolves.toBeUndefined();
  });

  it('requires an evidence document identifier on every bank detail request', async () => {
    const supplier = await createSupplier();
    setActor(requester);
    const response = await requestBankChange(postRequest({
      bankName: 'New Bank', accountHolderName: 'BLECA', accountNumber: '56789012',
    }, `evidence-${suffix}`), { params: Promise.resolve({ id: supplier.id }) });
    expect(response.status).toBe(422);
    expect(await prisma.supplierBankDetailChangeRequest.count({ where: { supplierId: supplier.id } })).toBe(0);
  });

  it('notifies active finance and CEO users when the request is created', async () => {
    const supplier = await createSupplier();
    const response = await createBankChange(supplier.id, requester, `notify-${suffix}`);
    const payload = await response.json() as { data: { id: string } };
    const rows = await prisma.notification.findMany({ where: { dedupeKey: `supplier-bank-change:${payload.data.id}` }, select: { userId: true, channel: true } });
    const notifiedUsers = await prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
      select: {
        userRoles: {
          where: { revokedAt: null, role: { isActive: true } },
          select: { role: { select: { code: true } } },
        },
      },
    });
    const notifiedRoles = new Set(notifiedUsers.flatMap((user) => user.userRoles.map((userRole) => userRole.role.code)));
    expect(notifiedRoles).toContain('FINANCE_OFFICER');
    expect(notifiedRoles).toContain('CEO');
    expect(new Set(rows.map((row) => row.channel))).toEqual(new Set(['IN_APP', 'EMAIL']));
  });

  it('audits request, verification, and approval as separate stages', async () => {
    const supplier = await createSupplier();
    const requested = await createBankChange(supplier.id, requester, `audit-${suffix}`);
    const requestBody = await requested.json() as { data: { id: string } };
    const changeId = requestBody.data.id;
    setActor(verifier);
    const verified = await verifyBankChange(postRequest({ verificationNotes: 'Independent callback verified against supplier records' }, `audit-verify-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    expect(verified.status).toBe(200);
    setActor(approver);
    const approved = await approveBankChange(postRequest({ reason: 'Verified documents match the supplier master record' }, `audit-approve-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    expect(approved.status).toBe(200);

    const actions = await prisma.auditLog.findMany({ where: { entityId: changeId }, select: { action: true } });
    expect(new Set(actions.map((entry) => entry.action))).toEqual(new Set([
      'SUPPLIER_BANK_DETAIL_CHANGE_REQUESTED', 'SUPPLIER_BANK_DETAIL_CHANGE_VERIFIED', 'SUPPLIER_BANK_DETAIL_CHANGE_APPROVED',
    ]));
  });

  it('keeps the superseded bank detail row and rejects every hard delete', async () => {
    const supplier = await createSupplier();
    const oldAccountNumber = '8877665544';
    const oldDetail = await prisma.supplierBankDetail.create({
      data: { supplierId: supplier.id, bankName: 'Old Bank', accountHolderName: 'BLECA', accountNumberEncrypted: encryptBankAccountNumber(oldAccountNumber), accountNumberLast4: bankAccountLast4(oldAccountNumber), isPrimary: true, isActive: true },
      select: { id: true },
    });
    const requested = await createBankChange(supplier.id, requester, `history-${suffix}`);
    const requestBody = await requested.json() as { data: { id: string } };
    const changeId = requestBody.data.id;
    setActor(verifier);
    await verifyBankChange(postRequest({ verificationNotes: 'Confirmed with an independently sourced callback number' }, `history-verify-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    setActor(approver);
    const response = await approveBankChange(postRequest({ reason: 'Approved after three-person review' }, `history-approve-${suffix}`), { params: Promise.resolve({ id: supplier.id, changeId }) });
    expect(response.status).toBe(200);
    const historical = await prisma.supplierBankDetail.findUniqueOrThrow({ where: { id: oldDetail.id } });
    expect(historical.isActive).toBe(false);
    expect(historical.isPrimary).toBe(false);
    await expect(prisma.$transaction((tx) => tx.supplierBankDetail.delete({ where: { id: oldDetail.id } }))).rejects.toThrow();
    expect(await prisma.supplierBankDetail.findUnique({ where: { id: oldDetail.id }, select: { id: true } })).not.toBeNull();
  });

  it('reconciles aging totals to posted receivable ledger lines', async () => {
    const customer = await createCustomer({ creditLimit: '1000' });
    const [period, receivableAccount, revenueAccount] = await Promise.all([
      prisma.financialPeriod.findFirstOrThrow({ where: { organizationId, status: 'OPEN' }, orderBy: { startDate: 'desc' }, select: { id: true } }),
      prisma.account.findFirstOrThrow({ where: { organizationId, subCategory: 'RECEIVABLE', status: 'ACTIVE', isPostable: true }, select: { id: true } }),
      prisma.account.findFirstOrThrow({ where: { organizationId, type: 'REVENUE', status: 'ACTIVE', isPostable: true }, select: { id: true } }),
    ]);
    const entry = await prisma.journalEntry.create({
      data: { organizationId, periodId: period.id, type: 'STANDARD', status: 'APPROVED', source: 'INVOICE', description: `M10 aging ${suffix}` },
      select: { id: true },
    });
    await prisma.journalLine.createMany({ data: [
      { organizationId, entryId: entry.id, accountId: receivableAccount.id, lineNumber: 1, debit: '125', credit: '0', currencyCode: 'TZS', baseAmount: '125' },
      { organizationId, entryId: entry.id, accountId: revenueAccount.id, lineNumber: 2, debit: '0', credit: '125', currencyCode: 'TZS', baseAmount: '125' },
    ] });
    await prisma.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', number: `M10-${suffix}`, postedAt: new Date(), postedById: requester.id } });
    await prisma.customerReceivable.create({
      data: {
        organizationId, customerId: customer.id, invoiceReference: `M10-INV-${suffix}`, sourceJournalEntryId: entry.id,
        currencyCode: 'TZS', originalAmount: '125', outstandingAmount: '125', issuedAt: new Date(Date.now() - 40 * 86_400_000),
        dueAt: new Date(Date.now() - 20 * 86_400_000),
      },
    });
    setActor(requester);
    const response = await getCustomerAging(new Request(`http://localhost/api/v1/customers/${customer.id}/aging`), { params: Promise.resolve({ id: customer.id }) });
    const result = await response.json() as { data: { totalOutstanding: string; buckets: Record<string, string>; ledgerReconciliation: { ledgerBalance: string | null; difference: string | null; matches: boolean | null } } };
    expect(response.status).toBe(200);
    expect(result.data.totalOutstanding).toBe('125');
    expect(result.data.buckets.days0To30).toBe('125');
    expect(result.data.ledgerReconciliation).toEqual({ status: 'LINKED', ledgerBalance: '125', difference: '0', matches: true });
  });
});

async function createCustomer(input: { creditLimit: string; status?: 'ACTIVE' | 'CREDIT_HOLD' }) {
  const party = await prisma.party.create({
    data: { organizationId, code: `M10-C-${suffix}-${Math.random().toString(36).slice(2, 7)}`, kind: 'COMPANY', displayName: 'M10 Test Customer' },
    select: { id: true },
  });
  return prisma.customer.create({
    data: { organizationId, partyId: party.id, status: input.status ?? 'ACTIVE', masterDataStatus: 'ACTIVE', creditLimit: input.creditLimit, currencyCode: 'TZS', createdById: requester.id },
  });
}

async function createSupplier() {
  const code = `M10-S-${suffix}-${Math.random().toString(36).slice(2, 7)}`;
  const party = await prisma.party.create({ data: { organizationId, code, kind: 'COMPANY', displayName: 'M10 Test Supplier' }, select: { id: true } });
  return prisma.supplier.create({ data: { organizationId, partyId: party.id, status: 'ACTIVE', masterDataStatus: 'ACTIVE', createdById: requester.id } });
}

async function createTestUser(label: string, roleId: string, roleCode: string): Promise<TestUser> {
  const email = `m10-${label}-${suffix}@bleca.test`;
  const user = await prisma.user.create({
    data: {
      id: `m10-${label}-${suffix}`,
      email, emailNormalized: email, fullName: `M10 ${label}`, status: 'ACTIVE', isActive: true,
      organizationMemberships: { create: { organizationId, isDefault: true } },
      userRoles: { create: { roleId, reason: `M10 integration ${roleCode}` } },
    },
    select: { id: true, email: true, fullName: true },
  });
  return { ...user, roleCodes: [roleCode] };
}

function setActor(user: TestUser): void {
  const ctx: RequestContext = {
    actor: {
      userId: user.id, email: user.email, fullName: user.fullName, roleCodes: user.roleCodes,
      isFinalApprover: user.roleCodes.includes('CEO'), organizationId, sessionId: null,
      mfaSatisfiedAt: null, stepUpSatisfiedAt: null, stepUpExpiresAt: null,
    },
    requestId: `m10-${suffix}`, channel: 'API', idempotencyKey: null, ipAddress: null, userAgent: 'm10-integration', syncBatchId: null,
  };
  vi.mocked(requireContext).mockResolvedValue(ctx);
}

async function createBankChange(supplierId: string, actor: TestUser, key: string): Promise<Response> {
  setActor(actor);
  return requestBankChange(postRequest({
    bankName: 'Replacement Bank', accountHolderName: 'BLECA SmartLabs', accountNumber: '5678123490',
    branchName: 'Central', currencyCode: 'TZS', evidenceDocumentId,
  }, key), { params: Promise.resolve({ id: supplierId }) });
}

function postRequest(body: unknown, key: string): Request {
  return new Request('http://localhost/api/v1/m10-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}
