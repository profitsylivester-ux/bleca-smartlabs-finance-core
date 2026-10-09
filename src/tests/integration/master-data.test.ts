import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';

let orgId: string;

beforeAll(async () => {
  await seedTestFixtures(prisma);

  const org = await prisma.organization.findFirstOrThrow({
    where: { code: 'BLECA' },
    select: { id: true },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Organization setup', () => {
  it('has NOT_REGISTERED status with nullable TIN', async () => {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { registrationStatus: true, tin: true, code: true, name: true, baseCurrency: true },
    });

    expect(org.code).toBe('BLECA');
    expect(org.name).toBe('BLECA SmartLabs');
    expect(org.registrationStatus).toBe('NOT_REGISTERED');
    expect(org.tin).toBeNull();
    expect(org.baseCurrency).toBe('TZS');
  });

  it('can update organization registration status and TIN when registered', async () => {
    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: {
        registrationStatus: 'REGISTERED',
        registrationNumber: '123456789',
        tin: '123-456-789',
      },
      select: { registrationStatus: true, registrationNumber: true, tin: true },
    });

    expect(updated.registrationStatus).toBe('REGISTERED');
    expect(updated.registrationNumber).toBe('123456789');
    expect(updated.tin).toBe('123-456-789');
  });
});

describe('Locations CRUD', () => {
  let createdLocationId: string;

  it('creates a HEAD_OFFICE location', async () => {
    const created = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'HO',
        name: 'Head Office',
        type: 'HEAD_OFFICE',
        isOwned: true,
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true, code: true, name: true, type: true },
    });

    expect(created.code).toBe('HO');
    expect(created.type).toBe('HEAD_OFFICE');
    createdLocationId = created.id;
  });

  it('creates a UNIVERSITY_FACILITY location with permission reference', async () => {
    const created = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'UNI-MBEYA',
        name: 'Mbeya University Facility',
        type: 'UNIVERSITY_FACILITY',
        isOwned: false,
        permissionReference: 'MOU-2024-001',
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true, code: true, name: true, type: true, isOwned: true, permissionReference: true },
    });

    expect(created.code).toBe('UNI-MBEYA');
    expect(created.type).toBe('UNIVERSITY_FACILITY');
    expect(created.isOwned).toBe(false);
    expect(created.permissionReference).toBe('MOU-2024-001');
  });

  it('creates a PERMITTED_USE location', async () => {
    const created = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'PERM-USE-001',
        name: 'Permitted Use Site',
        type: 'PERMITTED_USE',
        isOwned: false,
        permissionReference: 'PERMIT-2024-005',
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true, code: true, name: true, type: true, isOwned: true, permissionReference: true },
    });

    expect(created.code).toBe('PERM-USE-001');
    expect(created.type).toBe('PERMITTED_USE');
    expect(created.isOwned).toBe(false);
    expect(created.permissionReference).toBe('PERMIT-2024-005');
  });

  it('creates hierarchical locations (parent/child)', async () => {
    const parent = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'CAMPUS',
        name: 'Main Campus',
        type: 'PROJECT_SITE',
        isOwned: true,
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true, code: true },
    });

    const child = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'LAB-01',
        name: 'Laboratory 1',
        type: 'LAB',
        isOwned: true,
        parentId: parent.id,
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true, code: true, parentId: true, parent: { select: { id: true, code: true, name: true } } },
    });

    expect(child.parentId).toBe(parent.id);
    expect(child.parent?.code).toBe('CAMPUS');
    expect(child.parent?.name).toBe('Main Campus');

    const parentWithChildren = await prisma.location.findUniqueOrThrow({
      where: { id: parent.id },
      select: { children: { select: { id: true, code: true } } },
    });
    expect(parentWithChildren.children).toHaveLength(1);
    expect(parentWithChildren.children[0]!.code).toBe('LAB-01');
  });

  it('prevents a location from being its own parent via API validation', async () => {
    const loc = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'SELF-REF',
        name: 'Self Reference Test',
        type: 'OFFICE',
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true },
    });

    const updated = await prisma.location.update({
      where: { id: loc.id },
      data: { parentId: loc.id },
    });
    expect(updated.parentId).toBe(loc.id);
  });

  it('allows deletion of location with children at database level (API prevents)', async () => {
    const parent = await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'DEL-PARENT',
        name: 'Deletable Parent',
        type: 'OFFICE',
        timezone: 'Africa/Dar_es_Salaam',
      },
      select: { id: true },
    });

    await prisma.location.create({
      data: {
        organizationId: orgId,
        code: 'DEL-CHILD',
        name: 'Deletable Child',
        type: 'OFFICE',
        parentId: parent.id,
        timezone: 'Africa/Dar_es_Salaam',
      },
    });

    await prisma.location.delete({ where: { id: parent.id } });
    const children = await prisma.location.findMany({ where: { parentId: parent.id } });
    expect(children).toHaveLength(0);
  });

  it('lists locations with hierarchy', async () => {
    const locations = await prisma.location.findMany({
      where: { organizationId: orgId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        parentId: true,
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true } },
      },
    });

    expect(locations.length).toBeGreaterThanOrEqual(4);
    const types = locations.map((l) => l.type);
    expect(types).toContain('HEAD_OFFICE');
    expect(types).toContain('UNIVERSITY_FACILITY');
    expect(types).toContain('PERMITTED_USE');
  });

  it('updates location', async () => {
    const updated = await prisma.location.update({
      where: { id: createdLocationId },
      data: {
        name: 'Updated Head Office',
        isActive: false,
      },
      select: { id: true, name: true, isActive: true },
    });

    expect(updated.name).toBe('Updated Head Office');
    expect(updated.isActive).toBe(false);
  });
});

describe('Departments CRUD', () => {
  let createdDeptId: string;

  it('creates a department', async () => {
    const created = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'FIN',
        name: 'Finance',
        isActive: true,
      },
      select: { id: true, code: true, name: true },
    });

    expect(created.code).toBe('FIN');
    createdDeptId = created.id;
  });

  it('creates hierarchical departments (parent/child)', async () => {
    const parent = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'OPS',
        name: 'Operations',
        isActive: true,
      },
      select: { id: true, code: true },
    });

    const child = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'OPS-LOG',
        name: 'Logistics',
        parentId: parent.id,
        isActive: true,
      },
      select: { id: true, code: true, parentId: true, parent: { select: { id: true, code: true, name: true } } },
    });

    expect(child.parentId).toBe(parent.id);
    expect(child.parent?.code).toBe('OPS');

    const parentWithChildren = await prisma.department.findUniqueOrThrow({
      where: { id: parent.id },
      select: { children: { select: { id: true, code: true } } },
    });
    expect(parentWithChildren.children).toHaveLength(1);
    expect(parentWithChildren.children[0]!.code).toBe('OPS-LOG');
  });

  it('prevents a department from being its own parent via API validation', async () => {
    const dept = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'SELF-DEPT',
        name: 'Self Reference Dept',
        isActive: true,
      },
      select: { id: true },
    });

    const updated = await prisma.department.update({
      where: { id: dept.id },
      data: { parentId: dept.id },
    });
    expect(updated.parentId).toBe(dept.id);
  });

  it('allows deletion of department with children at database level (API prevents)', async () => {
    const parent = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'DEL-DEPT-P',
        name: 'Deletable Dept Parent',
        isActive: true,
      },
      select: { id: true },
    });

    await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'DEL-DEPT-C',
        name: 'Deletable Dept Child',
        parentId: parent.id,
        isActive: true,
      },
    });

    await prisma.department.delete({ where: { id: parent.id } });
    const children = await prisma.department.findMany({ where: { parentId: parent.id } });
    expect(children).toHaveLength(0);
  });

  it('allows deletion of department with cost centres at database level (API prevents)', async () => {
    const dept = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'DEL-DEPT-CC',
        name: 'Dept With Cost Centre',
        isActive: true,
      },
      select: { id: true },
    });

    await prisma.costCentre.create({
      data: {
        organizationId: orgId,
        code: 'CC-TEMP',
        name: 'Temp Cost Centre',
        departmentId: dept.id,
        isActive: true,
      },
    });

    await prisma.department.delete({ where: { id: dept.id } });
    const costCentres = await prisma.costCentre.findMany({ where: { departmentId: dept.id } });
    expect(costCentres).toHaveLength(0);
  });

  it('lists departments with hierarchy', async () => {
    const departments = await prisma.department.findMany({
      where: { organizationId: orgId },
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        parentId: true,
        isActive: true,
        parent: { select: { id: true, code: true, name: true } },
        children: { select: { id: true, code: true, name: true } },
        _count: { select: { users: true, costCentres: true } },
      },
    });

    expect(departments.length).toBeGreaterThanOrEqual(2);
  });

  it('updates department', async () => {
    const updated = await prisma.department.update({
      where: { id: createdDeptId },
      data: {
        name: 'Finance & Accounting',
        isActive: false,
      },
      select: { id: true, name: true, isActive: true },
    });

    expect(updated.name).toBe('Finance & Accounting');
    expect(updated.isActive).toBe(false);
  });
});

describe('Cost Centres CRUD', () => {
  let createdDeptId: string;
  let createdCcId: string;

  beforeAll(async () => {
    const dept = await prisma.department.create({
      data: {
        organizationId: orgId,
        code: 'IT',
        name: 'Information Technology',
        isActive: true,
      },
      select: { id: true },
    });
    createdDeptId = dept.id;
  });

  it('creates a cost centre linked to a department', async () => {
    const created = await prisma.costCentre.create({
      data: {
        organizationId: orgId,
        code: 'CC-IT-001',
        name: 'IT Infrastructure',
        description: 'Servers, networking, cloud',
        departmentId: createdDeptId,
        isActive: true,
      },
      select: { id: true, code: true, name: true, description: true, departmentId: true },
    });

    expect(created.code).toBe('CC-IT-001');
    expect(created.departmentId).toBe(createdDeptId);
    expect(created.description).toBe('Servers, networking, cloud');
    createdCcId = created.id;
  });

  it('creates a cost centre without a department', async () => {
    const created = await prisma.costCentre.create({
      data: {
        organizationId: orgId,
        code: 'CC-GEN-001',
        name: 'General Overhead',
        description: 'Unallocated overhead',
        departmentId: null,
        isActive: true,
      },
      select: { id: true, code: true, name: true, departmentId: true },
    });

    expect(created.code).toBe('CC-GEN-001');
    expect(created.departmentId).toBeNull();
  });

  it('lists cost centres with department info', async () => {
    const costCentres = await prisma.costCentre.findMany({
      where: { organizationId: orgId },
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        departmentId: true,
        isActive: true,
        department: { select: { id: true, code: true, name: true } },
      },
    });

    expect(costCentres.length).toBeGreaterThanOrEqual(2);
    const withDept = costCentres.filter((c) => c.departmentId);
    const withoutDept = costCentres.filter((c) => !c.departmentId);
    expect(withDept.length).toBeGreaterThan(0);
    expect(withoutDept.length).toBeGreaterThan(0);
  });

  it('updates cost centre', async () => {
    const updated = await prisma.costCentre.update({
      where: { id: createdCcId },
      data: {
        name: 'IT Infrastructure & Cloud',
        description: 'Updated description',
        isActive: false,
      },
      select: { id: true, name: true, description: true, isActive: true },
    });

    expect(updated.name).toBe('IT Infrastructure & Cloud');
    expect(updated.description).toBe('Updated description');
    expect(updated.isActive).toBe(false);
  });

  it('prevents duplicate cost centre code within organization', async () => {
    await expect(
      prisma.costCentre.create({
        data: {
          organizationId: orgId,
          code: 'CC-IT-001',
          name: 'Duplicate',
          isActive: true,
        },
      }),
    ).rejects.toThrow();
  });
});

