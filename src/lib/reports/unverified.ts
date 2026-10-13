import { Decimal } from '@prisma/client/runtime/library';
import type { MarkedAmount, UnverifiedReason } from './types';

/**
 * markUnverified — the PDF §2 unverified-data marker (M14, risk R1).
 *
 * The single most important figure in BLECA's history is the ~TZS 3,900,000
 * bootcamp gross "before expenses were properly recorded" (PDF §2): a revenue
 * number with a known-incomplete expense side. The core principle the whole
 * product exists to honour is that such a figure must NEVER be presented as a
 * closed, accurate result. This helper is the one place that guarantee is built.
 *
 * Every report figure that could include an opening-balance or imported
 * historical posting passes through here. It attaches the provenance of any
 * unverified OpeningBalance that contributes to the amount, and reports the
 * answer to "is any part of this figure unverified?" as a first-class value the
 * renderers cannot drop.
 *
 * There is a regression test (src/tests/integration/m14-reports.test.ts) that
 * asserts a figure fed an unverified opening balance comes back flagged, and a
 * fully-verified figure comes back clean. If this helper is ever weakened to a
 * no-op, that test fails.
 */

/** One contributing opening-balance row, as the engine collects them. */
export interface UnverifiedContribution {
  accountCode: string;
  verificationStatus: 'UNVERIFIED' | 'PENDING_VERIFICATION' | 'VERIFIED' | 'DISPUTED' | 'SUPERSEDED';
  /** The mandatory provenance string on the OpeningBalance. */
  source: string;
}

const REASON_BY_STATUS: Record<
  UnverifiedContribution['verificationStatus'],
  { code: UnverifiedReason['code']; message: string } | null
> = {
  // VERIFIED contributes nothing: a verified opening balance is a real figure.
  VERIFIED: null,
  UNVERIFIED: {
    code: 'OPENING_BALANCE_UNVERIFIED',
    message: 'Includes an opening balance that has not been verified by an accountant.',
  },
  PENDING_VERIFICATION: {
    code: 'OPENING_BALANCE_PENDING',
    message: 'Includes an opening balance still pending verification.',
  },
  DISPUTED: {
    code: 'OPENING_BALANCE_DISPUTED',
    message: 'Includes a disputed opening balance. Treat this figure as provisional.',
  },
  // A superseded opening balance has been replaced; the replacement carries its
  // own status, so the superseded row itself is not counted as a reason.
  SUPERSEDED: null,
};

/**
 * Build a MarkedAmount, deriving its `unverified` reasons from the contributing
 * opening balances. `amount` is a Decimal/string; `contributions` is every
 * opening-balance row that fed into it (may be empty for a pure live ledger).
 */
export function markUnverified(
  amount: Decimal | string | number,
  currency: string,
  contributions: UnverifiedContribution[],
  fx?: { originalAmount?: string; originalCurrency?: string; fxRate?: string; fxRateDate?: string },
): MarkedAmount {
  const reasons: UnverifiedReason[] = [];
  const seen = new Set<string>();

  for (const contribution of contributions) {
    const reason = REASON_BY_STATUS[contribution.verificationStatus];
    if (!reason) continue;
    // De-duplicate: the same account+status+source is one reason, not many.
    const dedupeKey = `${reason.code}:${contribution.accountCode}:${contribution.source}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    reasons.push({
      code: reason.code,
      message: reason.message,
      source: contribution.source,
      accountCode: contribution.accountCode,
    });
  }

  const decimal = amount instanceof Decimal ? amount : new Decimal(amount);
  return {
    amount: decimal.toString(),
    currency,
    unverified: reasons,
    ...(fx?.originalAmount !== undefined ? { originalAmount: fx.originalAmount } : {}),
    ...(fx?.originalCurrency !== undefined ? { originalCurrency: fx.originalCurrency } : {}),
    ...(fx?.fxRate !== undefined ? { fxRate: fx.fxRate } : {}),
    ...(fx?.fxRateDate !== undefined ? { fxRateDate: fx.fxRateDate } : {}),
  };
}

/** A fully-verified amount with no contributing unverified data. */
export function verified(amount: Decimal | string | number, currency: string): MarkedAmount {
  return markUnverified(amount, currency, []);
}

/** True if a MarkedAmount carries any unverified provenance. */
export function isUnverified(value: MarkedAmount): boolean {
  return value.unverified.length > 0;
}

/**
 * Collect the union of reasons across several amounts — used to set a report's
 * top-level `hasUnverified` flag from its sections without re-reading the DB.
 */
export function anyUnverified(values: MarkedAmount[]): boolean {
  return values.some(isUnverified);
}
