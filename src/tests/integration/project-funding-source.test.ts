import { beforeAll, describe, it, expect } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { seedTestFixtures } from '../setup/fixtures';

beforeAll(async () => {
  await seedTestFixtures(prisma);
});

describe('Project and FundingSource models', () => {
  it('can query projects table', async () => {
    const count = await prisma.project.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('can query funding_sources table', async () => {
    const count = await prisma.fundingSource.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('can create a project', async () => {
    const org = await prisma.organization.findFirstOrThrow({ where: { code: 'BLECA' } });
    const project = await prisma.project.create({
      data: {
        organizationId: org.id,
        code: 'TEST-PROJ',
        name: 'Test Project',
        status: 'ACTIVE',
      },
    });
    expect(project.code).toBe('TEST-PROJ');
    expect(project.status).toBe('ACTIVE');
  });

  it('can create a funding source', async () => {
    const org = await prisma.organization.findFirstOrThrow({ where: { code: 'BLECA' } });
    const fs = await prisma.fundingSource.create({
      data: {
        organizationId: org.id,
        code: 'TEST-FS',
        name: 'Test Funding Source',
        type: 'UNRESTRICTED',
      },
    });
    expect(fs.code).toBe('TEST-FS');
    expect(fs.type).toBe('UNRESTRICTED');
  });
});