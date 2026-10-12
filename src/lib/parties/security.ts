import { createCipheriv, randomBytes } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { InputJsonValue } from '@/generated/prisma/runtime/library';
import { env } from '@/lib/env';
import { prisma, type Tx } from '@/lib/db/prisma';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';
import { writeAuditEntry } from '@/lib/audit/writer';

const PAYMENT_BLOCKING_CHANGE_STATUSES = [
  'PENDING',
  'VERIFICATION_PENDING',
  'APPROVAL_PENDING',
] as const;

/**
 * Encrypt supplier account numbers before they are written to either the active
 * bank-detail row or a change request. ENCRYPTION_KEY is the existing 32-byte
 * application data key; ciphertext includes a random nonce and GCM tag.
 */
export function encryptBankAccountNumber(accountNumber: string): string {
  const key = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(accountNumber, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${nonce.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function bankAccountLast4(accountNumber: string): string {
  const normalized = accountNumber.replace(/\s+/g, '');
  return normalized.slice(-4).padStart(4, '•');
}

/** Serialize payment checks and bank-detail state transitions on the supplier row. */
export async function lockSupplierBankDetailState(tx: Tx, organizationId: string, supplierId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM suppliers
    WHERE id = ${supplierId} AND organization_id = ${organizationId}
    FOR UPDATE
  `);
  if (rows.length === 0) throw new NotFoundError('Supplier', supplierId);
}

/**
 * M11 payment creation must call this in its transaction before creating or
 * submitting a supplier payment. The database query checks every in-flight
 * state so no route can pay the requested destination early.
 */
export async function assertSupplierPaymentAllowed(
  tx: Tx,
  organizationId: string,
  supplierId: string,
): Promise<void> {
  // M11 must call this inside its payment transaction. Matching the lock in the
  // bank-change routes closes the race where a payment starts as a request opens.
  await lockSupplierBankDetailState(tx, organizationId, supplierId);
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, organizationId, deletedAt: null },
    select: { id: true, status: true, masterDataStatus: true },
  });
  if (!supplier) throw new NotFoundError('Supplier', supplierId);
  if (supplier.status !== 'ACTIVE' || supplier.masterDataStatus !== 'ACTIVE') {
    throw new ConflictError('Payments require an active, approved supplier.', { supplierId });
  }

  const pendingChanges = await tx.supplierBankDetailChangeRequest.count({
    where: {
      organizationId,
      supplierId,
      status: { in: [...PAYMENT_BLOCKING_CHANGE_STATUSES] },
    },
  });
  if (pendingChanges > 0) {
    throw new ConflictError(
      'Supplier payments are blocked while bank details are being verified or approved.',
      { supplierId, pendingBankDetailChanges: pendingChanges },
    );
  }
}

export interface CustomerInvoiceCreditResult {
  allowed: boolean;
  reason: string | null;
  currentExposure: string;
  projectedExposure: string;
  creditLimit: string;
  creditHoldCreated: boolean;
}

/**
 * M11 invoice creation must call this inside the invoice transaction. A credit
 * breach is persisted as a hold, then returned as a denial so the caller can
 * commit the hold while omitting the invoice write.
 */
export async function evaluateCustomerInvoiceCredit(
  tx: Tx,
  input: {
    organizationId: string;
    customerId: string;
    invoiceAmount: Prisma.Decimal | string | number;
    actor: { id: string; name: string; roleCodes: string[] };
  },
): Promise<CustomerInvoiceCreditResult> {
  const customer = await tx.customer.findFirst({
    where: { id: input.customerId, organizationId: input.organizationId, deletedAt: null },
    select: {
      id: true,
      status: true,
      masterDataStatus: true,
      creditLimit: true,
      currencyCode: true,
    },
  });
  if (!customer) throw new NotFoundError('Customer', input.customerId);

  const exposure = await tx.customerReceivable.aggregate({
    where: {
      organizationId: input.organizationId,
      customerId: customer.id,
      currencyCode: customer.currencyCode,
      status: { in: ['OPEN', 'PARTIALLY_PAID'] },
    },
    _sum: { outstandingAmount: true },
  });
  const currentExposure = exposure._sum.outstandingAmount ?? new Prisma.Decimal(0);
  const projectedExposure = currentExposure.plus(input.invoiceAmount);
  const creditLimit = customer.creditLimit;

  if (customer.status === 'CREDIT_HOLD' || customer.status === 'BLOCKED') {
    return {
      allowed: false,
      reason: customer.status === 'BLOCKED' ? 'Customer is blocked.' : 'Customer is on credit hold.',
      currentExposure: currentExposure.toString(),
      projectedExposure: projectedExposure.toString(),
      creditLimit: creditLimit.toString(),
      creditHoldCreated: false,
    };
  }
  if (customer.masterDataStatus !== 'ACTIVE') {
    return {
      allowed: false,
      reason: 'Customer master data is awaiting approval.',
      currentExposure: currentExposure.toString(),
      projectedExposure: projectedExposure.toString(),
      creditLimit: creditLimit.toString(),
      creditHoldCreated: false,
    };
  }

  if (projectedExposure.greaterThan(creditLimit)) {
    const reason = `Projected credit exposure ${projectedExposure.toString()} exceeds the limit ${creditLimit.toString()} ${customer.currencyCode}.`;
    const existingHold = await tx.customerCreditHold.findFirst({
      where: { customerId: customer.id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!existingHold) {
      await tx.customerCreditHold.create({
        data: {
          customerId: customer.id,
          previousCustomerStatus: customer.status,
          reason,
          requestedById: input.actor.id,
        },
      });
    }
    await tx.customer.update({
      where: { id: customer.id },
      data: {
        status: 'CREDIT_HOLD',
        creditHoldReason: reason,
        creditHeldAt: new Date(),
      },
    });
    await writeAuditEntry(
      tx,
      { id: input.actor.id, name: input.actor.name, roleCodes: input.actor.roleCodes },
      {
        action: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
        entityType: 'CUSTOMER',
        entityId: customer.id,
        description: `Customer credit limit exceeded for ${customer.id}`,
        changes: { status: { from: customer.status, to: 'CREDIT_HOLD' } },
        metadata: {
          currentExposure: currentExposure.toString(),
          invoiceAmount: new Prisma.Decimal(input.invoiceAmount).toString(),
          projectedExposure: projectedExposure.toString(),
          creditLimit: creditLimit.toString(),
        },
      },
      { organizationId: input.organizationId },
    );
    return {
      allowed: false,
      reason,
      currentExposure: currentExposure.toString(),
      projectedExposure: projectedExposure.toString(),
      creditLimit: creditLimit.toString(),
      creditHoldCreated: !existingHold,
    };
  }

  return {
    allowed: true,
    reason: null,
    currentExposure: currentExposure.toString(),
    projectedExposure: projectedExposure.toString(),
    creditLimit: creditLimit.toString(),
    creditHoldCreated: false,
  };
}

export async function createPartyMasterDataRequest(
  tx: Tx,
  input: {
    organizationId: string;
    entityType: 'CUSTOMER' | 'SUPPLIER';
    entityId: string;
    proposedChanges: InputJsonValue;
    reason: string;
    requestedById: string;
  },
) {
  return tx.masterDataChangeRequest.create({
    data: {
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      proposedChanges: input.proposedChanges,
      reason: input.reason,
      status: 'PENDING_APPROVAL',
      requestedById: input.requestedById,
    },
    select: { id: true, entityType: true, entityId: true, status: true, createdAt: true },
  });
}

export async function notifyFinanceAndCeoOfBankChange(
  tx: Tx,
  organizationId: string,
  supplierId: string,
  changeRequestId: string,
): Promise<void> {
  const now = new Date();
  const recipients = await tx.user.findMany({
    where: {
      isActive: true,
      status: 'ACTIVE',
      deletedAt: null,
      organizationMemberships: { some: { organizationId } },
      userRoles: {
        some: {
          revokedAt: null,
          startsAt: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          role: { isActive: true, code: { in: ['FINANCE_OFFICER', 'CEO'] } },
        },
      },
    },
    select: { id: true, userRoles: { where: { revokedAt: null, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], role: { isActive: true } }, select: { role: { select: { code: true } } } } },
  });
  const deliveredRoles = new Set(recipients.flatMap((recipient) => recipient.userRoles.map((userRole) => userRole.role.code)));
  const missingRoles = ['FINANCE_OFFICER', 'CEO'].filter((code) => !deliveredRoles.has(code));
  if (missingRoles.length > 0) {
    throw new ValidationError(`Cannot create a bank detail request until active notification recipients exist for: ${missingRoles.join(', ')}.`);
  }
  const uniqueRecipients = [...new Set(recipients.map((recipient) => recipient.id))];
  for (const userId of uniqueRecipients) {
    for (const channel of ['IN_APP', 'EMAIL'] as const) {
      await tx.notification.createMany({
        data: {
          organizationId,
          userId,
          category: 'SECURITY_ALERT',
          severity: 'CRITICAL',
          channel,
          status: 'PENDING',
          title: 'Supplier bank details changed',
          body: `A bank detail change request for supplier ${supplierId} requires controlled verification and approval.`,
          actionUrl: `/suppliers/${supplierId}/bank-details`,
          dedupeKey: `supplier-bank-change:${changeRequestId}`,
        },
        skipDuplicates: true,
      });
    }
  }
}
