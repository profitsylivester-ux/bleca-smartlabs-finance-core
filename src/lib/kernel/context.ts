import type {
  AuditAction,
  AuditChannel,
  AuditEntityType,
  ModuleKey,
  PermissionAction,
} from '@/generated/prisma/client';
import type { ScopeDimension } from '@/generated/prisma/client';

/**
 * RequestContext (PHASE_1_PLAN.md 2.4).
 *
 * Service functions take this explicitly so that authorization, audit and
 * idempotency cannot be bypassed by taking the internal path instead of the API.
 * There is no module-level "current user" for business logic to read: if a
 * function does not have a context, it is not doing an authorised action and
 * must not be calling the ledger.
 */
export interface ActorContext {
  userId: string;
  email: string;
  fullName: string;
  roleCodes: string[];
  isFinalApprover: boolean;
  organizationId: string | null;
  sessionId: string | null;
  mfaSatisfiedAt: Date | null;
  stepUpSatisfiedAt: Date | null;
  stepUpExpiresAt: Date | null;
}

export interface RequestContext {
  actor: ActorContext;
  requestId: string;
  channel: AuditChannel;
  idempotencyKey: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Set by the PWA sync path so the audit trail can tell replay from live entry. */
  syncBatchId: string | null;
}

/**
 * The uniform dimension projection for any business record
 * (PHASE_1_PLAN.md 5.3). Extracting dimensions through one helper is what lets a
 * single scope filter work identically across transactions, invoices, budgets and
 * journal lines.
 */
export interface Dimensions {
  projectId: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  locationId: string | null;
  fundingSourceId: string | null;
  accountId: string | null;
}

export const EMPTY_DIMENSIONS: Dimensions = {
  projectId: null,
  departmentId: null,
  costCentreId: null,
  locationId: null,
  fundingSourceId: null,
  accountId: null,
};

export function dimensionsOf(partial: Partial<Dimensions>): Dimensions {
  return { ...EMPTY_DIMENSIONS, ...partial };
}

export interface AuthorizationRequest {
  module: ModuleKey;
  action: PermissionAction;
  /** Narrow to a specific sub-resource, e.g. "supplier.bank_details". */
  resource?: string;
  entity?: {
    type: AuditEntityType;
    id?: string;
    label?: string;
    dimensions?: Dimensions;
  };
  /** Extra facts a policy condition may need, e.g. { amount, currency }. */
  context?: Record<string, unknown>;
}

export type {
  AuditAction,
  AuditChannel,
  AuditEntityType,
  ModuleKey,
  PermissionAction,
  ScopeDimension,
};
