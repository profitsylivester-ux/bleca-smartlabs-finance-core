import type {
  AuditAction,
  AuditChannel,
  AuditEntityType,
  AuditResult,
} from '@/generated/prisma/client';

/**
 * The shape of one audit entry as the caller supplies it.
 *
 * Deliberately separate from the Prisma model: the writer owns sequence,
 * previous_hash, entry_hash and signature, and a caller cannot influence any of
 * them. Accepting them as input would be the whole vulnerability.
 */
export interface AuditEntryInput {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  entityLabel?: string | null;
  description: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  metadata?: Record<string, unknown> | null;
  result?: AuditResult;
  errorMessage?: string | null;
  channel?: AuditChannel;
  occurredAt?: Date;
  /** Attach a SecurityEvent to this entry. */
  securityEvent?: SecurityEventInput;
  /** Do not let this audit write break the caller's transaction. */
  bestEffort?: boolean;
}

export interface SecurityEventInput {
  type:
    | 'BRUTE_FORCE_ATTEMPT'
    | 'CREDENTIAL_STUFFING_PATTERN'
    | 'NEW_DEVICE_LOGIN'
    | 'NEW_COUNTRY_LOGIN'
    | 'PRIVILEGE_ESCALATION_ATTEMPT'
    | 'SOD_VIOLATION_ATTEMPT'
    | 'PERMISSION_DENIED_SPIKE'
    | 'SCOPE_VIOLATION'
    | 'IDEMPOTENCY_CONFLICT'
    | 'MALFORMED_UPLOAD'
    | 'VELOCITY_ANOMALY'
    | 'TIME_ANOMALY'
    | 'CONFIG_CHANGED_OUT_OF_BAND'
    | 'AUDIT_CHAIN_BROKEN'
    | 'AUDIT_CHAIN_VERIFIED'
    | 'OFFLINE_QUEUE_REPLAY_ATTEMPT'
    | 'RATE_LIMIT_TRIPPED'
    | 'ACCOUNT_LOCKED'
    | 'MFA_FAILED_REPEATEDLY'
    | 'INSECURE_SESSION_POLICY';
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  subjectType?: AuditEntityType | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuditActor {
  id: string | null;
  name: string | null;
  roleCodes: string[];
}
