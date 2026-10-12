import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

export interface SignedDocumentDownload {
  documentId: string;
  organizationId: string;
  actorId: string;
  expiresAt: number;
}

function signature(payload: string): Buffer {
  return createHmac('sha256', env().AUTH_SECRET).update(payload).digest();
}

export function signDocumentDownload(input: SignedDocumentDownload): string {
  const payload = Buffer.from(JSON.stringify(input)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyDocumentDownload(token: string, now = Date.now()): SignedDocumentDownload | null {
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra !== undefined) return null;

  const expected = signature(payload);
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SignedDocumentDownload>;
    if (
      typeof data.documentId !== 'string' ||
      typeof data.organizationId !== 'string' ||
      typeof data.actorId !== 'string' ||
      typeof data.expiresAt !== 'number' ||
      !Number.isFinite(data.expiresAt) ||
      data.expiresAt <= now
    ) {
      return null;
    }
    return {
      documentId: data.documentId,
      organizationId: data.organizationId,
      actorId: data.actorId,
      expiresAt: data.expiresAt,
    };
  } catch {
    return null;
  }
}
