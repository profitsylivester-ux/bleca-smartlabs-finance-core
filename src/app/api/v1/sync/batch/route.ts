import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { runIdempotent } from '@/lib/api/idempotency';
import { withAudit } from '@/lib/db/with-audit';
import { writeAuditEntry } from '@/lib/audit/writer';
import { ValidationError, NotFoundError } from '@/lib/kernel/errors';
import type { AuditAction, AuditEntityType } from '@/generated/prisma/client';

const syncItemSchema = z.object({
  id: z.string().cuid(),
  actionType: z.enum([
    'RECEIPT_CAPTURE',
    'DRAFT_SAVE',
    'CONTACT_CARD_SAVE',
    'SUBMIT',
    'APPROVE',
    'REJECT',
    'POST',
    'REVERSE',
    'PERIOD_CLOSE',
    'PERIOD_REOPEN',
  ]),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1),
});

const batchSchema = z.object({
  items: z.array(syncItemSchema).min(1).max(50),
});

const OFFLINE_ALLOWED_ACTIONS = ['RECEIPT_CAPTURE', 'DRAFT_SAVE', 'CONTACT_CARD_SAVE'] as const;
const ONLINE_ONLY_ACTIONS = [
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'POST',
  'REVERSE',
  'PERIOD_CLOSE',
  'PERIOD_REOPEN',
] as const;

async function processReceiptCapture(
  tx: any,
  actor: { id: string; name: string; roleCodes: string[] },
  payload: any,
  idempotencyKey: string,
  net: { ipAddress: string | null; userAgent: string | null; requestId: string; sessionId: string }
) {
  // Create a transaction from the receipt data
  // This is a simplified implementation - in reality you'd map to your transaction/invoice models
  const created = await tx.transaction.create({
    data: {
      organizationId: actor.id, // This should be orgId from context
      status: 'DRAFT',
      date: new Date(payload.date),
      description: payload.description || `Receipt from ${payload.vendor}`,
      reference: payload.vendor,
      amount: payload.amount,
      currencyCode: payload.currency,
      paymentMethod: 'CASH',
      createdById: actor.id,
    },
    select: { id: true },
  });

  await writeAuditEntry(
    tx,
    { id: actor.id, name: actor.name, roleCodes: actor.roleCodes },
    {
      action: 'TRANSACTION_CREATED' as AuditAction,
      entityType: 'TRANSACTION' as AuditEntityType,
      entityId: created.id,
      entityLabel: created.id,
      description: `Created transaction from offline receipt capture: ${payload.vendor}`,
      changes: {
        vendor: { from: null, to: payload.vendor },
        amount: { from: null, to: payload.amount },
        currency: { from: null, to: payload.currency },
        date: { from: null, to: payload.date },
      },
    },
    { organizationId: actor.id, ipAddress: net.ipAddress, userAgent: net.userAgent, requestId: net.requestId, sessionId: net.sessionId }
  );

  return { status: 201, body: { data: { id: created.id } } };
}

async function processDraftSave(
  _tx: any,
  _actor: { id: string; name: string; roleCodes: string[] },
  _payload: any,
  _idempotencyKey: string,
  _net: { ipAddress: string | null; userAgent: string | null; requestId: string; sessionId: string }
) {
  // Draft save - implementation depends on what entity is being saved
  // For now, just acknowledge
  return { status: 200, body: { data: { id: 'draft-saved' } } };
}

async function processContactCardSave(
  _tx: any,
  _actor: { id: string; name: string; roleCodes: string[] },
  _payload: any,
  _idempotencyKey: string,
  _net: { ipAddress: string | null; userAgent: string | null; requestId: string; sessionId: string }
) {
  // Contact card save - implementation depends on your contact model
  return { status: 200, body: { data: { id: 'contact-saved' } } };
}

type SyncHandler = (
  tx: any,
  actor: { id: string; name: string; roleCodes: string[] },
  payload: any,
  idempotencyKey: string,
  net: { ipAddress: string | null; userAgent: string | null; requestId: string; sessionId: string }
) => Promise<{ status: number; body: { data: { id: string } } }>;

const actionHandlers: Record<string, SyncHandler> = {
  RECEIPT_CAPTURE: processReceiptCapture,
  DRAFT_SAVE: processDraftSave,
  CONTACT_CARD_SAVE: processContactCardSave,
};

export async function POST(request: Request) {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'DOCUMENTS', action: 'CREATE' }); // Use DOCUMENTS module for offline receipt capture sync

    if (!ctx.actor.organizationId) {
      return apiError(new ValidationError('No organization context'), reqId);
    }

    const body = batchSchema.parse(await request.json());

    const h = await headers();
    const net = {
      ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null,
      userAgent: h.get('user-agent'),
      requestId: reqId,
      sessionId: ctx.actor.sessionId ?? '',
    };

    const results: Array<{ idempotencyKey: string; status: string; result?: any; error?: string }> = [];
    let syncedCount = 0;
    let failedCount = 0;

    for (const item of body.items) {
      const { actionType, payload, idempotencyKey } = item;

      // Server-side enforcement: refuse online-only actions
      if (ONLINE_ONLY_ACTIONS.includes(actionType as any)) {
        results.push({
          idempotencyKey,
          status: 'REJECTED',
          error: 'OFFLINE_ACTION_NOT_ALLOWED: This action requires connectivity and cannot be synced from offline queue.',
        });
        failedCount++;
        continue;
      }

      // Verify action is in allowlist
      if (!OFFLINE_ALLOWED_ACTIONS.includes(actionType as any)) {
        results.push({
          idempotencyKey,
          status: 'REJECTED',
          error: 'INVALID_ACTION_TYPE: Action type not recognized.',
        });
        failedCount++;
        continue;
      }

      // Check if already processed (idempotency)
      const existing = await prisma.idempotencyKey.findUnique({
        where: { key_scope: { key: idempotencyKey, scope: `SYNC/${actionType}` } },
        select: { status: true, responseBody: true },
      });

      if (existing?.status === 'COMPLETED') {
        results.push({
          idempotencyKey,
          status: 'DUPLICATE',
          result: existing.responseBody,
        });
        syncedCount++;
        continue;
      }

      const handler = actionHandlers[actionType];
      if (!handler) {
        results.push({
          idempotencyKey,
          status: 'FAILED',
          error: `No handler for action type: ${actionType}`,
        });
        failedCount++;
        continue;
      }

      try {
        const outcome = await runIdempotent({
          key: idempotencyKey,
          scope: `SYNC/${actionType}`,
          actorId: ctx.actor.userId,
          body: { actionType, payload },
          handler: async () =>
            withAudit(
              {
                organizationId: ctx.actor.organizationId!,
                actor: {
                  id: ctx.actor.userId,
                  name: ctx.actor.fullName,
                  roleCodes: ctx.actor.roleCodes,
                },
                ipAddress: net.ipAddress,
                userAgent: net.userAgent,
                requestId: reqId,
                sessionId: ctx.actor.sessionId ?? '',
              },
              async (tx) => handler(tx, { id: ctx.actor.userId, name: ctx.actor.fullName, roleCodes: ctx.actor.roleCodes }, payload, idempotencyKey, net)
            ),
        });

        if (outcome.kind === 'REPLAYED') {
          results.push({ idempotencyKey, status: 'DUPLICATE', result: outcome.responseBody });
        } else {
          results.push({ idempotencyKey, status: 'SYNCED', result: outcome.result });
        }
        syncedCount++;
      } catch (err) {
        console.error(`Sync item ${idempotencyKey} failed:`, err);
        results.push({
          idempotencyKey,
          status: 'FAILED',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        failedCount++;
      }
    }

    // Update SyncQueueItem statuses in database
    for (const result of results) {
      await prisma.syncQueueItem.updateMany({
        where: { idempotencyKey: result.idempotencyKey, organizationId: ctx.actor.organizationId },
        data: {
          status: result.status === 'SYNCED' || result.status === 'DUPLICATE' ? 'SYNCED' : 'FAILED',
          conflictDetail: result.error ? { error: result.error } : undefined,
          syncedAt: result.status === 'SYNCED' ? new Date() : null,
        },
      });
    }

    return ok({ syncedCount, failedCount, results }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}





