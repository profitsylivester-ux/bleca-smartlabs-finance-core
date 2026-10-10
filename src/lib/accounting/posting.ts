import { Prisma } from '@/generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { NotFoundError, ValidationError } from '@/lib/kernel/errors';

interface PostJournalEntryInput {
  entryId: string;
  actorId: string;
  actorName: string;
  actorRoleCodes: string[];
  organizationId: string;
  idempotencyKey: string;
}

interface PostResult {
  entry: {
    id: string;
    number: string;
    status: string;
    postedAt: Date;
    postedById: string;
    lines: Array<{
      id: string;
      accountId: string;
      lineNumber: number;
      debit: Decimal;
      credit: Decimal;
      baseAmount: Decimal;
      currencyCode: string;
      fxRate: Decimal | null;
      projectId: string | null;
      departmentId: string | null;
      costCentreId: string | null;
      locationId: string | null;
      fundingSourceId: string | null;
    }>;
  };
}

export async function postJournalEntry(
  tx: Prisma.TransactionClient,
  input: PostJournalEntryInput,
): Promise<PostResult> {
  const { entryId, actorId, organizationId } = input;

  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId, organizationId },
    include: {
      period: { select: { id: true, status: true, code: true, startDate: true, endDate: true } },
      lines: {
        include: {
          account: { select: { id: true, code: true, name: true, type: true, normalBalance: true, isPostable: true, status: true } },
          project: { select: { id: true } },
          department: { select: { id: true } },
          costCentre: { select: { id: true } },
          location: { select: { id: true } },
          fundingSource: { select: { id: true } },
        },
        orderBy: { lineNumber: 'asc' },
      },
    },
  });

  if (!entry) {
    throw new NotFoundError('Journal entry', entryId);
  }

  if (entry.status !== 'APPROVED') {
    throw new ValidationError(`Cannot post journal entry with status ${entry.status}. Must be APPROVED.`);
  }

  if (entry.period.status !== 'OPEN' && entry.period.status !== 'REOPENED') {
    throw new ValidationError(`Cannot post to period with status ${entry.period.status}. Must be OPEN or REOPENED.`);
  }

  if (entry.lines.length < 2) {
    throw new ValidationError('Journal entry must have at least 2 lines.');
  }

  const firstLine = entry.lines[0];
  if (!firstLine) {
    throw new ValidationError('Journal entry has no lines.');
  }
  const firstCurrency = firstLine.currencyCode;
  for (const line of entry.lines) {
    if (line.currencyCode !== firstCurrency) {
      throw new ValidationError('All lines in a journal entry must share the same currency. Use separate entries per currency.');
    }
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const line of entry.lines) {
    totalDebit = totalDebit.plus(line.debit);
    totalCredit = totalCredit.plus(line.credit);
    if (!line.account.isPostable || line.account.status !== 'ACTIVE') {
      throw new ValidationError(`Account ${line.account.code} (${line.account.name}) is not postable.`);
    }
  }

  if (!totalDebit.equals(totalCredit)) {
    throw new ValidationError(`Journal entry is unbalanced: debits=${totalDebit} credits=${totalCredit}`);
  }

  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { baseCurrency: true },
  });

  if (!org) {
    throw new NotFoundError('Organization', organizationId);
  }

  const fxRateRecord = await tx.exchangeRate.findFirst({
    where: {
      baseCurrency: { code: firstCurrency },
      quoteCurrency: { code: org?.baseCurrency ?? 'TZS' },
      rateDate: { lte: new Date() },
    },
    orderBy: { rateDate: 'desc' },
  });

  const fxRate = fxRateRecord?.rate ?? new Decimal(1);

  for (const line of entry.lines) {
    if (!line.account.isPostable) {
      throw new ValidationError(`Account ${line.account.code} is not postable.`);
    }
  }

  const nextNumber = await getNextJournalNumber(tx, organizationId, entry.periodId ?? '');

  const postedAt = new Date();
  const updatedEntry = await tx.journalEntry.update({
    where: { id: entryId },
    data: {
      status: 'POSTED',
      number: nextNumber,
      postedAt,
      postedById: actorId,
    },
    select: { id: true, number: true, status: true, postedAt: true, postedById: true },
  });

  for (const line of entry.lines) {
    const baseAmount = line.debit.plus(line.credit).times(fxRate);
    await tx.journalLine.update({
      where: { id: line.id },
      data: {
        baseAmount,
        fxRate,
      },
    });
  }

  return {
    entry: {
      id: updatedEntry.id,
      number: updatedEntry.number ?? '',
      status: updatedEntry.status,
      postedAt: updatedEntry.postedAt ?? postedAt,
      postedById: updatedEntry.postedById ?? actorId,
      lines: entry.lines.map((l) => ({
        id: l.id,
        accountId: l.accountId,
        lineNumber: l.lineNumber,
        debit: l.debit,
        credit: l.credit,
        baseAmount: l.debit.plus(l.credit).times(fxRate),
        currencyCode: l.currencyCode,
        fxRate,
        projectId: l.projectId,
        departmentId: l.departmentId,
        costCentreId: l.costCentreId,
        locationId: l.locationId,
        fundingSourceId: l.fundingSourceId,
      })),
    },
  };
}

async function getNextJournalNumber(tx: Prisma.TransactionClient, organizationId: string, periodId: string): Promise<string> {
  const lastEntry = await tx.journalEntry.findFirst({
    where: { organizationId, periodId, number: { not: null } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  let nextNum = 1;
  if (lastEntry?.number) {
    const match = lastEntry.number.match(/^JE-(\d+)$/);
    if (match && match[1]) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  return `JE-${String(nextNum).padStart(6, '0')}`;
}

export async function validateEntryForPosting(
  tx: Prisma.TransactionClient,
  entryId: string,
  organizationId: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId, organizationId },
    include: {
      period: { select: { status: true } },
      lines: {
        include: {
          account: { select: { id: true, code: true, name: true, isPostable: true, status: true } },
        },
      },
    },
  });

  if (!entry) {
    return { valid: false, errors: ['Journal entry not found'] };
  }

  if (entry.status !== 'APPROVED') {
    errors.push(`Entry status is ${entry.status}, must be APPROVED`);
  }

  if (entry.period.status !== 'OPEN' && entry.period.status !== 'REOPENED') {
    errors.push(`Period status is ${entry.period.status}, must be OPEN or REOPENED`);
  }

  if (entry.lines.length < 2) {
    errors.push('Entry must have at least 2 lines');
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const line of entry.lines) {
    totalDebit = totalDebit.plus(line.debit);
    totalCredit = totalCredit.plus(line.credit);
    if (!line.account.isPostable || line.account.status !== 'ACTIVE') {
      errors.push(`Account ${line.account.code} (${line.account.name}) is not postable`);
    }
  }

  if (!totalDebit.equals(totalCredit)) {
    errors.push(`Unbalanced: debits=${totalDebit} credits=${totalCredit}`);
  }

  const currencies = new Set(entry.lines.map((l) => l.currencyCode));
  if (currencies.size > 1) {
    errors.push('All lines must share the same currency');
  }

  return { valid: errors.length === 0, errors };
}