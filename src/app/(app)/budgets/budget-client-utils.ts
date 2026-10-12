export interface ApiEnvelope<T> {
  data: T;
}

export async function budgetApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => null) as
    | { data?: T; error?: { message?: string } }
    | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? 'The request could not be completed.');
  }
  if (!body || !('data' in body)) throw new Error('The server returned an unexpected response.');
  return body.data as T;
}

export function mutationInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
