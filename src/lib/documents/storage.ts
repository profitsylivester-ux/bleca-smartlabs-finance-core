import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/lib/env';

export interface DocumentStorageProvider {
  put(key: string, contentType: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class LocalDocumentStorage implements DocumentStorageProvider {
  private filePath(key: string): string {
    const root = path.resolve(process.cwd(), env().STORAGE_LOCAL_ROOT, 'documents');
    const target = path.resolve(root, key);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid document storage key.');
    }
    return target;
  }

  async put(key: string, _contentType: string, bytes: Buffer): Promise<void> {
    const target = this.filePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.filePath(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }
}

class S3DocumentStorage implements DocumentStorageProvider {
  private objectUrl(key: string): URL {
    const settings = env();
    const url = new URL(settings.S3_ENDPOINT);
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    if (settings.S3_FORCE_PATH_STYLE) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(settings.S3_BUCKET)}/${encodedKey}`;
    } else {
      url.hostname = `${settings.S3_BUCKET}.${url.hostname}`;
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodedKey}`;
    }
    return url;
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType?: string) {
    const settings = env();
    if (!settings.S3_ACCESS_KEY_ID || !settings.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3.');
    }

    const url = this.objectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
    const signedHeaders = contentType
      ? 'content-type;host;x-amz-content-sha256;x-amz-date'
      : 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = contentType
      ? `content-type:${contentType.trim()}\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
      : `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${settings.S3_REGION}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const dateKey = createHmac('sha256', `AWS4${settings.S3_SECRET_ACCESS_KEY}`).update(dateStamp).digest();
    const regionKey = createHmac('sha256', dateKey).update(settings.S3_REGION).digest();
    const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
    const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${settings.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = new Headers({
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization,
    });
    if (contentType) headers.set('content-type', contentType);
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'PUT' && body ? new Uint8Array(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`S3 storage returned ${response.status} for ${method.toLowerCase()}.`);
    }
    return response;
  }

  async put(key: string, contentType: string, bytes: Buffer): Promise<void> {
    await this.request('PUT', key, bytes, contentType);
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', key);
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    await this.request('DELETE', key);
  }
}

let local: LocalDocumentStorage | undefined;
let s3: S3DocumentStorage | undefined;

export function documentStorage(): DocumentStorageProvider {
  const driver = env().STORAGE_DRIVER;
  if (driver === 's3') return (s3 ??= new S3DocumentStorage());
  return (local ??= new LocalDocumentStorage());
}
