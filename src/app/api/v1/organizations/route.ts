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
import { ValidationError } from '@/lib/kernel/errors';
import type { InputJsonValue } from '@/generated/prisma/runtime/library';

const registrationStatusSchema = z.enum(['NOT_REGISTERED', 'PENDING', 'REGISTERED']);

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  legalName: z.string().max(200).nullish(),
  registrationStatus: registrationStatusSchema.optional(),
  registrationNumber: z.string().max(50).nullish(),
  tin: z.string().max(30).nullish(),
  baseCurrency: z.string().length(3).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  fiscalYearEndDay: z.number().int().min(1).max(31).optional(),
  defaultLocationId: z.string().cuid().nullish(),
  isActive: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).nullish(),
});

async function getAuditOptions(reqId: string, h: Headers) {
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

async function getOrganization(ctx: { actor: { organizationId: string | null } }) {
  if (!ctx.actor.organizationId) return null;
  return prisma.organization.findFirst({
    where: { id: ctx.actor.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      legalName: true,
      type: true,
      registrationStatus: true,
      registrationNumber: true,
      tin: true,
      baseCurrency: true,
      fiscalYearStartMonth: true,
      fiscalYearEndDay: true,
      taxJurisdictions: true,
      defaultLocationId: true,
      isActive: true,
      settings: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const organization = await getOrganization(ctx);
    if (!organization) {
      return apiError(new ValidationError('Organization not found'), reqId);
    }

    let defaultLocation = null;
    if (organization.defaultLocationId) {
      defaultLocation = await prisma.location.findUnique({
        where: { id: organization.defaultLocationId },
        select: { id: true, code: true, name: true },
      });
    }

    return ok({ data: { ...organization, defaultLocation } }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function PATCH(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'MASTER_DATA', action: 'EDIT' });

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const body = updateSchema.parse(await request.json());

    const current = await getOrganization(ctx);
    if (!current) {
      return apiError(new ValidationError('Organization not found'), reqId);
    }

    if (body.defaultLocationId) {
      const location = await prisma.location.findFirst({
        where: { id: body.defaultLocationId, organizationId: ctx.actor.organizationId },
        select: { id: true },
      });
      if (!location) {
        return apiError(new ValidationError('Default location not found in this organization'), reqId);
      }
    }

    const h = await headers();
    const net = await getAuditOptions(reqId, h);

    const outcome = await runIdempotent({
      key,
      scope: `PATCH /api/v1/organizations`,
      actorId: ctx.actor.userId,
      body,
      handler: async () =>
        withAudit(
          {
            organizationId: ctx.actor.organizationId,
            actor: {
              id: ctx.actor.userId,
              name: ctx.actor.fullName,
              roleCodes: ctx.actor.roleCodes,
            },
            ipAddress: net.ipAddress,
            userAgent: net.userAgent,
            requestId: reqId,
            sessionId: ctx.actor.sessionId,
          },
          async (tx) => {
            const updated = await tx.organization.update({
              where: { id: ctx.actor.organizationId! },
              data: {
                name: body.name ?? current.name,
                legalName: body.legalName ?? (current.legalName ?? undefined),
                registrationStatus: body.registrationStatus ?? current.registrationStatus,
                registrationNumber: body.registrationNumber ?? (current.registrationNumber ?? undefined),
                tin: body.tin ?? (current.tin ?? undefined),
                baseCurrency: body.baseCurrency ?? current.baseCurrency,
                fiscalYearStartMonth: body.fiscalYearStartMonth ?? current.fiscalYearStartMonth,
                fiscalYearEndDay: body.fiscalYearEndDay ?? current.fiscalYearEndDay,
                defaultLocationId: body.defaultLocationId ?? current.defaultLocationId,
                isActive: body.isActive ?? current.isActive,
                settings: (body.settings ?? (current.settings ?? undefined)) as import('@/generated/prisma/runtime/library').InputJsonValue | undefined,
              },
              select: {
                id: true,
                code: true,
                name: true,
                legalName: true,
                type: true,
                registrationStatus: true,
                registrationNumber: true,
                tin: true,
                baseCurrency: true,
                fiscalYearStartMonth: true,
                fiscalYearEndDay: true,
                defaultLocationId: true,
                isActive: true,
                updatedAt: true,
              },
            });

            const changes: Record<string, { from: InputJsonValue | null; to: InputJsonValue | null }> = {};
            if (body.name && body.name !== current.name) changes.name = { from: current.name, to: body.name };
            if (body.legalName !== undefined && body.legalName !== current.legalName)
              changes.legalName = { from: current.legalName, to: body.legalName };
            if (body.registrationStatus && body.registrationStatus !== current.registrationStatus)
              changes.registrationStatus = { from: current.registrationStatus, to: body.registrationStatus };
            if (body.registrationNumber !== undefined && body.registrationNumber !== current.registrationNumber)
              changes.registrationNumber = { from: current.registrationNumber, to: body.registrationNumber };
            if (body.tin !== undefined && body.tin !== current.tin)
              changes.tin = { from: current.tin, to: body.tin };
            if (body.baseCurrency && body.baseCurrency !== current.baseCurrency)
              changes.baseCurrency = { from: current.baseCurrency, to: body.baseCurrency };
            if (body.fiscalYearStartMonth && body.fiscalYearStartMonth !== current.fiscalYearStartMonth)
              changes.fiscalYearStartMonth = { from: current.fiscalYearStartMonth, to: body.fiscalYearStartMonth };
            if (body.fiscalYearEndDay && body.fiscalYearEndDay !== current.fiscalYearEndDay)
              changes.fiscalYearEndDay = { from: current.fiscalYearEndDay, to: body.fiscalYearEndDay };
            if (body.defaultLocationId !== undefined && body.defaultLocationId !== current.defaultLocationId)
              changes.defaultLocationId = { from: current.defaultLocationId, to: body.defaultLocationId };
            if (body.isActive !== undefined && body.isActive !== current.isActive)
              changes.isActive = { from: current.isActive, to: body.isActive };
            if (body.settings !== undefined && JSON.stringify(body.settings) !== JSON.stringify(current.settings))
              changes.settings = { from: current.settings as import('@/generated/prisma/runtime/library').InputJsonValue | null, to: body.settings as import('@/generated/prisma/runtime/library').InputJsonValue | null };

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'CONFIGURATION_CHANGES',
                entityType: 'ORGANIZATION',
                entityId: updated.id,
                entityLabel: updated.code,
                description: `Updated organization ${updated.code}`,
                changes,
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 200, body: { data: updated } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}