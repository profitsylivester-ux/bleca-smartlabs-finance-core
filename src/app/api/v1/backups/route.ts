import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { apiError, ok, requestId } from '@/lib/api/responses';
import { listBackups } from '@/lib/backup/service';

export async function GET() {
  const reqId = await requestId();
  try {
    const ctx = await requireContext();
    await authorize(ctx, { module: 'BACKUP_ADMIN', action: 'VIEW' });

    if (!ctx.actor.organizationId) {
      return apiError(new Error('No organization context'), reqId);
    }

    const backups = await listBackups(ctx.actor.organizationId);

    return ok({ data: backups, count: backups.length }, 200, reqId);
  } catch (error) {
    return apiError(error, reqId);
  }
}