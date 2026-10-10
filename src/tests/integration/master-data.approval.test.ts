import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';
import { hashPassword } from '@/lib/auth/password';

let orgId: string;
let ceoUserId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;

  const ceoRole = await prisma.role.findUniqueOrThrow({
    where: { code: 'CEO' },
    select: { id: true },
  });

  const password = await hashPassword('IntegrationTest#2026');
  const id = `test-ceo-${Date.now()}`;

  const user = await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      emailNormalized: `${id}@test.local`,
      fullName: 'Test CEO',
      status: 'ACTIVE',
      isActive: true,
      passwordHash: password,
      passwordAlgorithm: 'ARGON2ID',
      userRoles: { create: { roleId: ceoRole.id, reason: 'integration fixture' } },
      organizationMemberships: { create: { organizationId: orgId, isDefault: true } },
    },
    select: { id: true },
  });
  ceoUserId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildProposedChanges(
  fields: Record<string, { from: string | null; to: unknown }>,
): Record<string, { from: string | null; to: unknown }> {
  return fields;
}

describe('Master Data Change Requests - Database Constraints', () => {
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
          requestedById: ceoUserId,
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
      const effectiveDate = new Date('2025-06-01');
      const expiresAt = new Date('2025-12-31');

      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'DEPARTMENT',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'New Department' } },
          reason: 'Testing effective dating',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId,
          effectiveDate,
          expiresAt,
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
      expect(created.effectiveDate).toBeInstanceOf(Date);
      expect(created.expiresAt).toBeInstanceOf(Date);
      expect(created.effectiveDate!.getTime()).toBe(effectiveDate.getTime());
      expect(created.expiresAt!.getTime()).toBe(expiresAt.getTime());
    });

    it('creates a change request with entityId for existing entity', async () => {
      const location = await prisma.location.create({
        data: {
          organizationId: orgId,
          code: 'LOC-TEST',
          name: 'Test Location',
          isActive: true,
          type: 'OFFICE',
        },
        select: { id: true },
      });

      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: location.id,
          proposedChanges: { name: { from: 'Test Location', to: 'Updated Location' } },
          reason: 'Updating existing location',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId,
        },
        select: {
          id: true,
          entityType: true,
          entityId: true,
          proposedChanges: true,
        },
      });

      expect(created.entityId).toBe(location.id);
      expect(created.proposedChanges).toEqual({ name: { from: 'Test Location', to: 'Updated Location' } });
    });
  });

  describe('status transitions', () => {
    it('updates status to APPROVED with approvedAt and approvedById', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Approved Location' } },
          reason: 'Will be approved',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId,
        },
        select: { id: true },
      });

      const approvedAt = new Date();
      await prisma.masterDataChangeRequest.update({
        where: { id: created.id },
        data: { status: 'APPROVED', approvedById: ceoUserId, approvedAt },
      });

      const updated = await prisma.masterDataChangeRequest.findUnique({
        where: { id: created.id },
        select: { status: true, approvedById: true, approvedAt: true },
      });

      expect(updated!.status).toBe('APPROVED');
      expect(updated!.approvedById).toBe(ceoUserId);
      expect(updated!.approvedAt).toBeInstanceOf(Date);
      expect(updated!.approvedAt!.getTime()).toBe(approvedAt.getTime());
    });

    it('updates status to REJECTED with approvedAt and approvedById', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'COST_CENTRE',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Rejected Cost Centre' } },
          reason: 'Testing rejection flow',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId,
        },
        select: { id: true },
      });

      const approvedAt = new Date();
      await prisma.masterDataChangeRequest.update({
        where: { id: created.id },
        data: {
          status: 'REJECTED',
          approvedById: ceoUserId,
          approvedAt,
          reason: 'Testing rejection flow\n\nRejection reason: Insufficient budget',
        },
      });

      const updated = await prisma.masterDataChangeRequest.findUnique({
        where: { id: created.id },
        select: { status: true, approvedById: true, approvedAt: true, reason: true },
      });

      expect(updated!.status).toBe('REJECTED');
      expect(updated!.approvedById).toBe(ceoUserId);
      expect(updated!.approvedAt).toBeInstanceOf(Date);
      expect(updated!.reason!.includes('Insufficient budget')).toBe(true);
    });

    it('updates status to CANCELLED', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'DEPARTMENT',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Cancelled Department' } },
          reason: 'Will be cancelled',
          status: 'PENDING_APPROVAL',
          requestedById: ceoUserId,
        },
        select: { id: true },
      });

      await prisma.masterDataChangeRequest.update({
        where: { id: created.id },
        data: { status: 'CANCELLED' },
      });

      const updated = await prisma.masterDataChangeRequest.findUnique({
        where: { id: created.id },
        select: { status: true },
      });

      expect(updated!.status).toBe('CANCELLED');
    });
  });

  describe('version snapshots (database level)', () => {
    it('can create a version snapshot manually', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Versioned Location' } },
          reason: 'Testing version creation',
          status: 'APPROVED',
          requestedById: ceoUserId,
          approvedById: ceoUserId,
          approvedAt: new Date(),
        },
        select: { id: true },
      });

      const version = await prisma.masterDataVersion.create({
        data: {
          changeRequestId: created.id,
          entityType: 'LOCATION',
          entityId: null,
          versionNumber: 1,
          snapshot: { name: 'Versioned Location' },
          changedFields: { name: 'Versioned Location' },
          effectiveFrom: new Date(),
          effectiveTo: null,
        },
        select: {
          id: true,
          versionNumber: true,
          snapshot: true,
          changedFields: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });

      expect(version.versionNumber).toBe(1);
      expect(version.snapshot).toEqual({ name: 'Versioned Location' });
      expect(version.changedFields).toEqual({ name: 'Versioned Location' });
      expect(version.effectiveFrom).toBeInstanceOf(Date);
      expect(version.effectiveTo).toBeNull();
    });

    it('enforces unique versionNumber per changeRequest', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'LOCATION',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Unique Version Location' } },
          reason: 'Testing unique version',
          status: 'APPROVED',
          requestedById: ceoUserId,
          approvedById: ceoUserId,
          approvedAt: new Date(),
        },
        select: { id: true },
      });

      await prisma.masterDataVersion.create({
        data: {
          changeRequestId: created.id,
          entityType: 'LOCATION',
          entityId: null,
          versionNumber: 1,
          snapshot: { name: 'Versioned Location' },
          changedFields: { name: 'Versioned Location' },
          effectiveFrom: new Date(),
        },
      });

      await expect(
        prisma.masterDataVersion.create({
          data: {
            changeRequestId: created.id,
            entityType: 'LOCATION',
            entityId: null,
            versionNumber: 1,
            snapshot: { name: 'Another' },
            changedFields: { name: 'Another' },
            effectiveFrom: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('stores effectiveFrom and effectiveTo on version', async () => {
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'FUNDING_SOURCE',
          entityId: null,
          proposedChanges: { name: { from: null, to: 'Effective Dated Fund' } },
          reason: 'Testing effective dating on version',
          status: 'APPROVED',
          requestedById: ceoUserId,
          approvedById: ceoUserId,
          approvedAt: new Date(),
          effectiveDate: new Date('2025-03-01'),
          expiresAt: new Date('2025-09-30'),
        },
        select: { id: true, effectiveDate: true, expiresAt: true },
      });

      const version = await prisma.masterDataVersion.create({
        data: {
          changeRequestId: created.id,
          entityType: 'FUNDING_SOURCE',
          entityId: null,
          versionNumber: 1,
          snapshot: { name: 'Effective Dated Fund' },
          changedFields: { name: 'Effective Dated Fund' },
          effectiveFrom: created.effectiveDate!,
          effectiveTo: created.expiresAt!,
        },
        select: {
          effectiveFrom: true,
          effectiveTo: true,
        },
      });

      expect(version.effectiveFrom).toBeInstanceOf(Date);
      expect(version.effectiveTo).toBeInstanceOf(Date);
      expect(version.effectiveFrom!.getTime()).toBe(new Date('2025-03-01').getTime());
      expect(version.effectiveTo!.getTime()).toBe(new Date('2025-09-30').getTime());
    });

    it('stores effectiveFrom as approvedAt when effectiveDate is null', async () => {
      const approvedAt = new Date('2025-06-15');
      const created = await prisma.masterDataChangeRequest.create({
        data: {
          organizationId: orgId,
          entityType: 'CURRENCY',
          entityId: null,
          proposedChanges: { code: { from: null, to: 'JPY' }, name: { from: null, to: 'Japanese Yen' } },
          reason: 'Testing effectiveFrom fallback',
          status: 'APPROVED',
          requestedById: ceoUserId,
          approvedById: ceoUserId,
          approvedAt,
          effectiveDate: null,
          expiresAt: null,
        },
        select: { id: true },
      });

      const version = await prisma.masterDataVersion.create({
        data: {
          changeRequestId: created.id,
          entityType: 'CURRENCY',
          entityId: null,
          versionNumber: 1,
          snapshot: { code: 'JPY', name: 'Japanese Yen' },
          changedFields: { code: 'JPY', name: 'Japanese Yen' },
          effectiveFrom: approvedAt,
        },
        select: { effectiveFrom: true },
      });

      expect(version.effectiveFrom).toBeInstanceOf(Date);
      expect(version.effectiveFrom!.getTime()).toBe(approvedAt.getTime());
    });
  });

  describe('Master Data Change Requests - Effective Dating', () => {
  it('stores effectiveDate and expiresAt on the change request', async () => {
    const created = await prisma.masterDataChangeRequest.create({
      data: {
        organizationId: orgId,
        entityType: 'FUNDING_SOURCE',
        entityId: null,
        proposedChanges: { name: { from: null, to: 'Effective Dated Fund' } },
        reason: 'Testing effective dating',
        status: 'PENDING_APPROVAL',
        requestedById: ceoUserId,
        effectiveDate: new Date('2025-03-01'),
        expiresAt: new Date('2025-09-30'),
      },
      select: { effectiveDate: true, expiresAt: true, status: true },
    });

    expect(created.effectiveDate).toBeInstanceOf(Date);
    expect(created.expiresAt).toBeInstanceOf(Date);
    expect(created.status).toBe('PENDING_APPROVAL');
  });

  it('allows effectiveDate without expiresAt', async () => {
    const created = await prisma.masterDataChangeRequest.create({
      data: {
        organizationId: orgId,
        entityType: 'PROJECT',
        entityId: null,
        proposedChanges: { name: { from: null, to: 'Future Project' } },
        reason: 'Testing effectiveDate only',
        status: 'PENDING_APPROVAL',
        requestedById: ceoUserId,
        effectiveDate: new Date('2026-01-01'),
        expiresAt: null,
      },
      select: { effectiveDate: true, expiresAt: true },
    });

    expect(created.effectiveDate).toBeInstanceOf(Date);
    expect(created.expiresAt).toBeNull();
  });

  it('allows expiresAt without effectiveDate', async () => {
    const created = await prisma.masterDataChangeRequest.create({
      data: {
        organizationId: orgId,
        entityType: 'CURRENCY',
        entityId: null,
        proposedChanges: { code: { from: 'USD', to: 'EUR' } },
        reason: 'Testing expiresAt only',
        status: 'PENDING_APPROVAL',
        requestedById: ceoUserId,
        effectiveDate: null,
        expiresAt: new Date('2025-12-31'),
      },
      select: { effectiveDate: true, expiresAt: true },
    });

    expect(created.effectiveDate).toBeNull();
    expect(created.expiresAt).toBeInstanceOf(Date);
  });
});
});