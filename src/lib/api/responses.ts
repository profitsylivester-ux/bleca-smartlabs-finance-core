import { NextResponse } from 'next/server';
import { KernelError } from '@/lib/kernel/errors';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';

/**
 * API error mapping.
 *
 * One place decides what an error looks like from outside. The rule the API must
 * never break: a permission failure says "you may not do this", not "the query
 * returned zero rows" and never a stack trace. A caller who cannot see internal
 * detail cannot use the API to learn about it.
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export async function requestId(): Promise<string> {
  const h = await headers();
  return h.get('x-request-id') ?? randomUUID();
}

export function apiError(error: unknown, reqId: string): NextResponse<ApiErrorBody> {
  if (error instanceof KernelError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: reqId,
        },
      },
      {
        status: error.status,
        headers:
          error.code === 'RATE_LIMITED' && typeof error.details?.retryAfterSeconds === 'number'
            ? { 'retry-after': String(error.details.retryAfterSeconds) }
            : undefined,
      },
    );
  }

  // Anything unrecognised is a bug. Report the reference, not the internals.
  console.error('[api] unhandled error', { requestId: reqId, error });

  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed. Quote the request id when reporting this.',
        requestId: reqId,
      },
    },
    { status: 500 },
  );
}

export function ok<T>(data: T, status = 200, reqId?: string): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: reqId ? { 'x-request-id': reqId } : undefined,
  });
}
