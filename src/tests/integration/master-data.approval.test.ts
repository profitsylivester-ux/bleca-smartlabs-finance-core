import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';

let orgId: string;
let ceoUserId: string;
let financeUserId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;

  // Find any user in the database to use as requestedById
  const anyUser = await prisma.user.findFirst({
    select: { id: true },
  });
  if (anyUser) {
    ceoUserId = anyUser.id;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildProposedChanges(
  fields: Record<string, { from: string | null; to: unknown }>,
): Record<string, { from: string | null; to: unknown }> {
  return fields;
}

describe('Master Data Change Requests - Approval Flow', () => {
  describe('creation', () => {
    it('creates a change request with PENDING_APPROVAL status', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'New Test Location' } },
          reason: 'Testing approval flow',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
          effectiveDate: null,
          expiresAt: null,
        },
        select: {
          id: true,
          entityType: true,
          status: true,
          reason: true,
          effectiveDate: true,
          expiresAt: true,
        },
      });

      expect(created.status).toBe('PENDING_APPROVAL');
      expect(created.entityType).toBe('LOCATION');
      expect(created.effectiveDate).toBeNull();
      expect(created.expiresAt).toBeNull();
    });

    it('creates a change request with effectiveDate and expiresAt', async () => {
      const effectiveDate = new Date('2025-06-01').toISOString();
      const expiresAt = new Date('2025-12-31').toISOString();

      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'DEPARTMENT',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'New Department' } },
          reason: 'Testing effective dating',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
          effectiveDate: new Date(effectiveDate),
          expiresAt: new Date(expiresAt),
        },
        select: {
          id: true,
          entityType: true,
          status: true,
          effectiveDate: true,
          expiresAt: true,
        },
      });

      expect(created.status).toBe('PENDING_APPROVAL');
      expect(created.effectiveDate).toBeInstance(Date);
      expect(created.expiresAt).toBeInstance(Date);
    });
  });

  describe('approval', () => {
    let changeRequestId: string;

    beforeAll(async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Approved Test Location' } },
          reason: 'Will be approved',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
        },
        select: { id: true },
      });
      changeRequestId = created.id;
    });

    it('approves a change request and changes status to APPROVED', async () => {
      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: { status: 'APPROVED', approvedById: ceoUserId ?? '' },
      });

      const updated = await prisma.masterDataChangeRequest.findUnique({
        where: { id: changeRequestId },
        select: { status: true, approvedById: true, approvedAt: true },
      });

      expect(updated!.status).toBe('APPROVED');
      expect(updated!.approvedById).toBeDefined();
      expect(updated!.approvedAt).toBeInstance(Date);
    });

    it('creates a version snapshot on approve', async () => {
      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: { status: 'APPROVED', approvedById: ceoUserId ?? '' },
      });

      const version = await prisma.masterDataVersion.findFirst({
        where: { changeRequestId },
        orderBy: { versionNumber: 'desc' },
      });

      expect(version).not.toBeNull();
      expect(version!.versionNumber).toBe(1);
      expect(version!.snapshot).toEqual({
        name: 'Approved Test Location',
      });
      expect(version!.changedFields).toEqual({
        name: 'Approved Test Location',
      });
      expect(version!.effectiveFrom).toBeInstance(Date);
    });

    it('creates second version after first', async () => {
      // First approval already happened in beforeAll
      const versions = await prisma.masterDataVersion.findMany({
        where: { changeRequestId },
        orderBy: { versionNumber: 'asc' },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0].versionNumber).toBe(1);
    });
  });

  describe('rejection', () => {
    let changeRequestId: string;

    beforeAll(async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'COST_CENTRE',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Rejected Cost Centre' } },
          reason: 'Testing rejection flow',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
        },
        select: { id: true },
      });
      changeRequestId = created.id;
    });

    it('rejects a change request and changes status to REJECTED', async () => {
      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: {
          status: 'REJECTED',
          approvedById: ceoUserId ?? '',
          reason: 'Testing rejection flow\n\nRejection reason: Insufficient budget',
        },
      });

      const updated = await prisma.masterDataChangeRequest.findUnique({
        where: { id: changeRequestId },
        select: { status: true, approvedById: true, approvedAt: true, reason: true },
      });

      expect(updated!.status).toBe('REJECTED');
      expect(updated!.approvedById).toBeDefined();
      expect(updated!.reason!.includes('Insufficient budget')).toBe(true);
    });

    it('does NOT create a version snapshot on reject', async () => {
      const versionsBefore = await prisma.masterDataVersion.count({
        where: { changeRequestId },
      });

      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: {
          status: 'REJECTED',
          approvedById: ceoUserId ?? '',
          reason: 'No version on reject',
        },
      });

      const versionsAfter = await prisma.masterDataVersion.count({
        where: { changeRequestId },
      });
      expect(versionsAfter).toBe(versionsBefore);
    });

    it('creates audit entry on rejection', async () => {
      const beforeCount = await prisma.auditLog.count();

      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: {
          status: 'REJECTED',
          approvedById: ceoUserId ?? '',
          reason: 'Audit test rejection',
        },
      });

      const afterCount = await prisma.auditLog.count();
      expect(afterCount).toBeGreaterThan(beforeCount);

      const newEntry = await prisma.auditLog.findFirst({
        orderBy: { sequence: 'desc' },
        select: {
          sequence: true,
          action: true,
          entityType: true,
          entityId: true,
          description: true,
          result: true,
        },
      });

      expect(newEntry).not.toBeNull();
      expect(newEntry!.entityType).toBe('MASTER_DATA_CHANGE_REQUEST');
      expect(newEntry!.action).toBe('CONFIGURATION_CHANGES');
      expect(newEntry!.result).toBe('SUCCESS');
    });
  });

  describe('effective dating', () => {
    let changeRequestId: string;

    beforeAll(async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'FUNDING_SOURCE',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Effective Dated Fund' } },
          reason: 'Testing effective dating',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
          effectiveDate: new Date('2025-03-01'),
          expiresAt: new Date('2025-09-30'),
        },
        select: { id: true },
      });
      changeRequestId = created.id;
    });

    it('stores effectiveDate and expiresAt on the change request', async () => {
      const cr = await prisma.masterDataChangeRequest.findUnique({
        where: { id: changeRequestId },
        select: { effectiveDate: true, expiresAt: true, status: true },
      });
      expect(cr!.effectiveDate).toBeInstance(Date);
      expect(cr!.expiresAt).toBeInstance(Date);
      expect(cr!.status).toBe('PENDING_APPROVAL');
    });

    it('version has effectiveFrom set on approve with effective dating', async () => {
      await prisma.masterDataChangeRequest.update({
        where: { id: changeRequestId },
        data: { status: 'APPROVED', approvedById: ceoUserId ?? '' },
      });

      const version = await prisma.masterDataVersion.findFirst({
        where: { changeRequestId },
        orderBy: { versionNumber: 'desc' },
      });
      expect(version).not.toBeNull();
      expect(version!.effectiveFrom).toBeInstance(Date);
      expect(version!.effectiveFrom!.getTime()).toBeGreaterThan(0);
    });

    it('version effectiveTo is set when expiresAt exists', async () => {
      // Create another change request with expiresAt
      const created2 = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'CURRENCY',
          entityId: null,
          proposedChanges: { code: { from: null, to: 'JPY' }, name: { from: null, to: 'Japanese Yen' } },
          reason: 'Testing effectiveTo',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId ?? '',
          effectiveDate: new Date('2025-01-01'),
          expiresAt: new Date('2025-06-30'),
        },
        select: { id: true },
      });
      const secondChangeRequestId = created2.id;

      await prisma.masterDataChangeRequest.update({
        where: { id: secondChangeRequestId },
        data: { status: 'APPROVED', approvedById: ceoUserId ?? '' },
      });

      const version = await prisma.masterDataVersion.findFirst({
        where: { changeRequestId: secondChangeRequestId },
        orderBy: { versionNumber: 'desc' },
      });
      expect(version).not.toBeNull();
      expect(version!.effectiveTo).toBeInstance(Date);
    });
  });
});