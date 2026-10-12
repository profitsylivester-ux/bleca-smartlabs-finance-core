import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ConflictError, ValidationError } from '@/lib/kernel/errors';
import { createPartyMasterDataRequest } from '@/lib/parties/security';

const createSchema = z.object({
  code: z.string().min(2).max(50).toUpperCase(),
  kind: z.enum(['INDIVIDUAL', 'COMPANY']).default('COMPANY'),
  displayName: z.string().min(1).max(200),
  legalName: z.string().max(200).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  taxIdentifier: z.string().max(100).optional(),
  registrationNumber: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  website: z.string().url().optional(),
  status: z.enum(['PROSPECT', 'ACTIVE', 'INACTIVE', 'BLOCKED']).default('PROSPECT'),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  paymentCurrencyCode: z.string().length(3).toUpperCase().optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  performanceRating: z.number().min(0).max(5).optional(),
  deliveryRating: z.number().min(0).max(5).optional(),
  qualityRating: z.number().min(0).max(5).optional(),
  productServiceIds: z.array(z.string().cuid()).max(100).default([]),
});

export async function GET(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'VIEW' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') ?? 20)));
    const status = searchParams.get('status');
    const query = searchParams.get('search')?.trim();
    const where = {
      organizationId: ctx.actor.organizationId,
      deletedAt: null,
      ...(status ? { status: status as 'PROSPECT' | 'ACTIVE' | 'INACTIVE' | 'BLOCKED' } : {}),
      ...(query ? { OR: [
        { party: { displayName: { contains: query, mode: 'insensitive' as const } } },
        { party: { code: { contains: query, mode: 'insensitive' as const } } },
        { party: { taxIdentifier: { contains: query, mode: 'insensitive' as const } } },
      ] } : {}),
    };
    const [data, count] = await Promise.all([
      prisma.supplier.findMany({
        where,
        orderBy: [{ party: { displayName: 'asc' } }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, status: true, masterDataStatus: true, paymentTermsDays: true,
          paymentCurrencyCode: true, performanceRating: true, deliveryRating: true,
          qualityRating: true, riskLevel: true, createdAt: true,
          party: { select: { id: true, code: true, kind: true, displayName: true, legalName: true, email: true, phone: true, taxIdentifier: true } },
        },
      }),
      prisma.supplier.count({ where }),
    ]);
    return ok({ data, count, page, pageSize, totalPages: Math.ceil(count / pageSize) }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'SUPPLIERS', action: 'CREATE' });
    if (!ctx.actor.organizationId) return apiError(new ValidationError('No organization context'), reqId);
    const key = request.headers.get('idempotency-key');
    if (!key) return apiError(new ValidationError('An Idempotency-Key header is required.'), reqId);
    const body = createSchema.parse(await request.json());
    const [duplicate, products] = await Promise.all([
      prisma.party.findFirst({ where: { organizationId: ctx.actor.organizationId, code: body.code, deletedAt: null }, select: { id: true } }),
      body.productServiceIds.length ? prisma.productService.findMany({
        where: { id: { in: body.productServiceIds }, organizationId: ctx.actor.organizationId, isActive: true }, select: { id: true },
      }) : Promise.resolve([]),
    ]);
    if (duplicate) return apiError(new ConflictError(`Counterparty code ${body.code} already exists.`), reqId);
    if (products.length !== new Set(body.productServiceIds).size) {
      return apiError(new ValidationError('One or more supplied products or services are not active in this organization.'), reqId);
    }

    const h = await headers();
    const ipAddress = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
    const userAgent = h.get('user-agent');
    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/suppliers',
      actorId: ctx.actor.userId,
      body,
      handler: async () => withAudit({
        organizationId: ctx.actor.organizationId,
        actor: { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
        ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId,
      }, async (tx) => {
        const party = await tx.party.create({
          data: {
            organization: { connect: { id: ctx.actor.organizationId! } },
            code: body.code, kind: body.kind, displayName: body.displayName,
            legalName: body.legalName, firstName: body.firstName, lastName: body.lastName,
            taxIdentifier: body.taxIdentifier, registrationNumber: body.registrationNumber,
            email: body.email, phone: body.phone, website: body.website, createdById: ctx.actor.userId,
          },
          select: { id: true },
        });
        const supplier = await tx.supplier.create({
          data: {
            organizationId: ctx.actor.organizationId!,
            partyId: party.id,
            status: body.status,
            masterDataStatus: 'PENDING_APPROVAL',
            paymentTermsDays: body.paymentTermsDays,
            paymentCurrencyCode: body.paymentCurrencyCode,
            riskLevel: body.riskLevel,
            performanceRating: body.performanceRating,
            deliveryRating: body.deliveryRating,
            qualityRating: body.qualityRating,
            createdById: ctx.actor.userId,
          },
          select: { id: true, status: true, masterDataStatus: true, riskLevel: true, party: { select: { id: true, code: true, displayName: true } } },
        });
        if (body.productServiceIds.length > 0) {
          await tx.supplierProductService.createMany({ data: body.productServiceIds.map((productServiceId) => ({ supplierId: supplier.id, productServiceId })) });
        }
        const change = await createPartyMasterDataRequest(tx, {
          organizationId: ctx.actor.organizationId!, entityType: 'SUPPLIER', entityId: supplier.id,
          proposedChanges: { masterDataStatus: 'ACTIVE' }, reason: 'Initial supplier master data approval', requestedById: ctx.actor.userId,
        });
        await writeAuditEntry(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, {
          action: 'SUPPLIER_CREATED', entityType: 'SUPPLIER', entityId: supplier.id, entityLabel: supplier.party.displayName,
          description: `Created supplier ${supplier.party.code}; master data awaits approval`,
          changes: { masterDataStatus: { from: null, to: 'PENDING_APPROVAL' }, status: { from: null, to: supplier.status } },
          metadata: { masterDataChangeRequestId: change.id },
        }, { organizationId: ctx.actor.organizationId!, ipAddress, userAgent, requestId: reqId, sessionId: ctx.actor.sessionId });
        return { status: 201, body: { data: supplier, masterDataChangeRequestId: change.id } };
      }),
    });
    if (outcome.kind === 'REPLAYED') return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
