export interface ApiResult<T> {
  data?: T;
  error?: { message?: string };
}

export async function salesRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result = await response.json() as ApiResult<T>;
  if (!response.ok) throw new Error(result.error?.message ?? 'The request could not be completed.');
  if (result.data === undefined) throw new Error('The server returned an empty response.');
  return result.data;
}

export function mutationHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() };
}

export interface PartyOption {
  id: string;
  status: string;
  masterDataStatus: string;
  currencyCode?: string;
  paymentCurrencyCode?: string | null;
  party: { code: string; displayName: string };
}

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  isPostable: boolean;
  children?: AccountOption[];
}

export interface TreasuryOption {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
}

export function flattenAccounts(accounts: AccountOption[]): AccountOption[] {
  return accounts.flatMap((account) => [account, ...flattenAccounts(account.children ?? [])]);
}
