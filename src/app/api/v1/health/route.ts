import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { ok, requestId } from '@/lib/api/responses';

export async function GET() {
  const reqId = await requestId();
  const startTime = Date.now();

  try {
    // Check database connectivity
    await prisma.$queryRaw`SELECT 1`;

    // Get last backup timestamp
    const lastBackup = await prisma.backupRun.findFirst({
      where: { status: { in: ['SUCCEEDED', 'VERIFIED'] } },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true, type: true },
    });

    const uptime = process.uptime();

    const health = {
      status: 'healthy',
      uptime: Math.floor(uptime),
      uptimeHuman: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        latencyMs: Date.now() - startTime,
      },
      lastBackup: lastBackup
        ? {
            completedAt: lastBackup.completedAt?.toISOString(),
            type: lastBackup.type,
          }
        : null,
      version: process.env.npm_package_version ?? 'unknown',
      environment: process.env.NODE_ENV ?? 'development',
    };

    return ok(health, 200, reqId);
  } catch (error) {
    const health = {
      status: 'unhealthy',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      lastBackup: null,
      version: process.env.npm_package_version ?? 'unknown',
      environment: process.env.NODE_ENV ?? 'development',
    };

    return NextResponse.json(health, { status: 503, headers: { 'x-request-id': reqId } });
  }
}
