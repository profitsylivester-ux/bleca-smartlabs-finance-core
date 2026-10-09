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
import { ConflictError, NotFoundError, ValidationError } from '@/lib/kernel/errors';

/**
 * /api/v1/users
 *
 * The API surface and the Server Actions call the same authorization layer and
 * the same audit writer. That is deliberate: taking the API path must not be a
 * way around a permission check, so the check lives beneath both rather than in
 * either of them.
 */

const createSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(120),
  jobTitle: z.string().max(120).nullish(),
  roleCode: z.string().min(1),
  temporary: z.boolean().optional(),
  expiresAt: z.string().datetime().nullish(),
});

async function auditOptions(reqId: string) {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
    userAgent: h.get('user-agent'),
    requestId: reqId,
  };
}

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW' });

    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        email: true,
        status: true,
        isActive: true,
        lastLoginAt: true,
        mfaEnforced: true,
        userRoles: {
          where: { revokedAt: null },
          select: {
            role: { select: { code: true, name: true } },
            isTemporary: true,
            expiresAt: true,
          },
        },
      },
    });

    return ok({ data: users, count: users.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'USERS_ROLES', action: 'CREATE' });

    const key = request.headers.get('idempotency-key');
    if (!key) {
      return apiError(
        new ValidationError('An Idempotency-Key header is required on this endpoint.'),
        reqId,
      );
    }

    const body = createSchema.parse(await request.json());

    if (body.temporary && !body.expiresAt) {
      return apiError(new ValidationError('Temporary access requires an expiry date.'), reqId);
    }

    const emailNormalized = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { emailNormalized },
      select: { id: true },
    });
    if (existing) {
      return apiError(new ConflictError('That email is already registered.'), reqId);
    }

    const role = await prisma.role.findUnique({
      where: { code: body.roleCode },
      select: { id: true },
    });
    if (!role) {
      return apiError(new NotFoundError('Role', body.roleCode), reqId);
    }

    const net = await auditOptions(reqId);

    const outcome = await runIdempotent({
      key,
      scope: 'POST /api/v1/users',
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
            const created = await tx.user.create({
              data: {
                email: body.email,
                emailNormalized,
                fullName: body.fullName,
                jobTitle: body.jobTitle ?? null,
                status: 'INVITED',
                isActive: true,
                userRoles: {
                  create: {
                    roleId: role.id,
                    isTemporary: body.temporary ?? false,
                    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
                    grantedById: ctx.actor.userId,
                    reason: 'Created via API',
                  },
                },
                ...(ctx.actor.organizationId
                  ? {
                      organizationMemberships: {
                        create: { organizationId: ctx.actor.organizationId, isDefault: true },
                      },
                    }
                  : {}),
              },
              select: { id: true, email: true, fullName: true },
            });

            await writeAuditEntry(
              tx,
              { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes },
              {
                action: 'USER_CREATED',
                entityType: 'USER',
                entityId: created.id,
                entityLabel: created.email,
                description: `Created account ${created.email} with role ${body.roleCode} via API`,
                changes: {
                  email: { from: null, to: created.email },
                  roleCode: { from: null, to: body.roleCode },
                },
              },
              {
                organizationId: ctx.actor.organizationId,
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId,
              },
            );

            return { status: 201, body: { data: created } };
          },
        ),
    });

    if (outcome.kind === 'REPLAYED') {
      return NextResponse.json(outcome.responseBody, { status: outcome.responseStatus });
    }

    return ok(outcome.result, 201, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}
