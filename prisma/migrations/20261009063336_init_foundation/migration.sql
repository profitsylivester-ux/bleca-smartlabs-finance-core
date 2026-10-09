-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "MfaMethod" AS ENUM ('TOTP', 'WEBAUTHN');

-- CreateEnum
CREATE TYPE "MfaDeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SessionRevokeReason" AS ENUM ('LOGOUT', 'TIMEOUT_IDLE', 'TIMEOUT_ABSOLUTE', 'PASSWORD_CHANGED', 'MFA_CHANGED', 'ADMIN_REVOKED', 'SUSPECTED_COMPROMISE');

-- CreateEnum
CREATE TYPE "LoginOutcome" AS ENUM ('SUCCESS', 'FAILURE_BAD_CREDENTIALS', 'FAILURE_MFA', 'FAILURE_LOCKED', 'FAILURE_INACTIVE', 'FAILURE_EXPIRED_PASSWORD', 'BLOCKED_RATE_LIMIT');

-- CreateEnum
CREATE TYPE "PasswordHashAlgorithm" AS ENUM ('ARGON2ID', 'BCRYPT');

-- CreateEnum
CREATE TYPE "DelegationKind" AS ENUM ('APPROVAL_AUTHORITY', 'TEMPORARY_ACCESS', 'ACTING_CAPACITY');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('VIEW', 'CREATE', 'EDIT', 'SUBMIT', 'APPROVE', 'REJECT', 'POST', 'REVERSE', 'EXPORT', 'CONFIGURE', 'ADMINISTER');

-- CreateEnum
CREATE TYPE "ModuleKey" AS ENUM ('DASHBOARD_CEO', 'DASHBOARD_FINANCE', 'USERS_ROLES', 'CHART_OF_ACCOUNTS', 'JOURNAL_ENTRIES', 'GENERAL_LEDGER', 'TRIAL_BALANCE', 'TRANSACTIONS', 'APPROVALS', 'PERIODS', 'FINANCIAL_CLOSE', 'CASH', 'BANK', 'MOBILE_MONEY', 'PAYMENT_GATEWAYS', 'TREASURY_TRANSFERS', 'STATEMENT_IMPORT', 'RECONCILIATION', 'BUDGETS', 'COMMITMENTS', 'CUSTOMERS', 'SUPPLIERS', 'QUOTATIONS', 'INVOICES', 'PAYMENTS', 'RECEIPTS', 'CREDIT_NOTES', 'DOCUMENTS', 'MASTER_DATA', 'REPORTS', 'EXPORTS', 'AUDIT_TRAIL', 'TAX_COMPLIANCE', 'IMPORTS', 'ANOMALY_DETECTION', 'NOTIFICATIONS', 'SEARCH', 'BACKUP_ADMIN', 'API_ADMIN', 'PROCUREMENT', 'INVENTORY', 'ASSETS', 'FUNDING', 'PROJECTS_FULL', 'CRM');

-- CreateEnum
CREATE TYPE "ScopeDimension" AS ENUM ('PROJECT', 'DEPARTMENT', 'COST_CENTRE', 'LOCATION', 'FUNDING_SOURCE', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "RoleType" AS ENUM ('SYSTEM', 'STANDARD', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "AccessReviewStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('SINGLE_ENTITY');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('NOT_REGISTERED', 'PENDING', 'REGISTERED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'SESSION_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'MFA_ENROLLED', 'MFA_VERIFIED', 'MFA_DISABLED', 'USER_CREATED', 'USER_UPDATED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_SUSPENDED', 'ROLE_ASSIGNED', 'ROLE_REMOVED', 'PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'ROLE_CREATED', 'ROLE_UPDATED', 'DELEGATION_GRANTED', 'DELEGATION_REVOKED', 'DELEGATION_EXPIRED', 'ACCESS_REVIEW_COMPLETED', 'CONFIGURATION_CHANGES', 'EXPORT', 'DOCUMENT_UPLOADED', 'DOCUMENT_DOWNLOADED', 'REPORT_GENERATED', 'SECURITY_EVENT', 'RATE_LIMIT_TRIPPED', 'ACCESS_DENIED', 'SOD_VIOLATION_ATTEMPT', 'SCOPE_VIOLATION', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'IDEMPOTENCY_CONFLICT', 'RETENTION_APPLIED', 'OFFLINE_QUEUE_REPLAY_ATTEMPT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('USER', 'ROLE', 'PERMISSION', 'SESSION', 'ORGANIZATION', 'AUTH_POLICY', 'DELEGATION', 'ACCESS_REVIEW', 'AUDIT_LOG', 'SECURITY_EVENT', 'NOTIFICATION', 'API_KEY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "AuditChannel" AS ENUM ('WEB', 'API', 'CLI', 'SYSTEM', 'SYNC');

-- CreateEnum
CREATE TYPE "SecurityEventSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('BRUTE_FORCE_ATTEMPT', 'CREDENTIAL_STUFFING_PATTERN', 'NEW_DEVICE_LOGIN', 'NEW_COUNTRY_LOGIN', 'PRIVILEGE_ESCALATION_ATTEMPT', 'SOD_VIOLATION_ATTEMPT', 'PERMISSION_DENIED_SPIKE', 'SCOPE_VIOLATION', 'IDEMPOTENCY_CONFLICT', 'MALFORMED_UPLOAD', 'VELOCITY_ANOMALY', 'TIME_ANOMALY', 'CONFIG_CHANGED_OUT_OF_BAND', 'AUDIT_CHAIN_BROKEN', 'AUDIT_CHAIN_VERIFIED', 'OFFLINE_QUEUE_REPLAY_ATTEMPT', 'RATE_LIMIT_TRIPPED', 'ACCOUNT_LOCKED', 'MFA_FAILED_REPEATEDLY', 'INSECURE_SESSION_POLICY');

-- CreateEnum
CREATE TYPE "ChainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'BROKEN');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'READ', 'ARCHIVED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('APPROVAL', 'SECURITY_ALERT', 'ACCESS_REVIEW', 'SYSTEM', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IdempotencyKeyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "job_title" TEXT,
    "phone" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMP(3),
    "deactivation_reason" TEXT,
    "password_hash" TEXT,
    "password_algorithm" "PasswordHashAlgorithm",
    "password_changed_at" TIMESTAMP(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "email_verified_at" TIMESTAMP(3),
    "password_reset_token" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "password_history" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfa_enforced" BOOLEAN NOT NULL DEFAULT false,
    "mfa_verified_at" TIMESTAMP(3),
    "primary_location_id" TEXT,
    "home_department_id" TEXT,
    "data_classification" TEXT NOT NULL DEFAULT 'INTERNAL',
    "retention_review_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "method" "MfaMethod" NOT NULL DEFAULT 'TOTP',
    "label" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "recovery_codes_enc" TEXT,
    "status" "MfaDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "confirmed_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_counter" INTEGER NOT NULL DEFAULT -1,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_fingerprint" TEXT,
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_timeout_at" TIMESTAMP(3),
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" "SessionRevokeReason",
    "mfa_satisfied_at" TIMESTAMP(3),
    "step_up_satisfied_at" TIMESTAMP(3),
    "step_up_expires_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "email_attempted" TEXT NOT NULL,
    "outcome" "LoginOutcome" NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_fingerprint" TEXT,
    "mfa_attempted" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "session_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "max_failed_attempts" INTEGER NOT NULL DEFAULT 5,
    "lockout_duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "rate_limit_window_seconds" INTEGER NOT NULL DEFAULT 60,
    "max_attempts_per_window" INTEGER NOT NULL DEFAULT 10,
    "ip_rate_limit_per_minute" INTEGER NOT NULL DEFAULT 20,
    "session_idle_timeout_minutes" INTEGER NOT NULL DEFAULT 30,
    "session_absolute_timeout_hours" INTEGER NOT NULL DEFAULT 12,
    "password_min_length" INTEGER NOT NULL DEFAULT 12,
    "password_require_uppercase" BOOLEAN NOT NULL DEFAULT true,
    "password_require_lowercase" BOOLEAN NOT NULL DEFAULT true,
    "password_require_number" BOOLEAN NOT NULL DEFAULT true,
    "password_require_symbol" BOOLEAN NOT NULL DEFAULT true,
    "mfa_required_role_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfa_challenge_timeout_minutes" INTEGER NOT NULL DEFAULT 10,
    "step_up_timeout_minutes" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" TEXT,

    CONSTRAINT "auth_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "RoleType" NOT NULL DEFAULT 'STANDARD',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "is_final_approver" BOOLEAN NOT NULL DEFAULT false,
    "can_bypass_approval" BOOLEAN NOT NULL DEFAULT false,
    "max_approval_amount" DECIMAL(20,6),
    "approval_currency" CHAR(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "module" "ModuleKey" NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "resource" TEXT,
    "description" TEXT,
    "requires_step_up_auth" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "conditions" JSONB,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "is_temporary" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "granted_by_id" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_scope_grants" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT,
    "dimension" "ScopeDimension" NOT NULL,
    "dimension_value_id" TEXT,
    "include_children" BOOLEAN NOT NULL DEFAULT false,
    "effect" TEXT NOT NULL DEFAULT 'ALLOW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_scope_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delegations" (
    "id" TEXT NOT NULL,
    "grantor_id" TEXT NOT NULL,
    "grantee_id" TEXT NOT NULL,
    "kind" "DelegationKind" NOT NULL,
    "role_id" TEXT,
    "scope" JSONB,
    "reason" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" TEXT,
    "revocation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_reviews" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" "AccessReviewStatus" NOT NULL DEFAULT 'OPEN',
    "scope_json" JSONB,
    "initiated_by_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_review_items" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "current_expires_at" TIMESTAMP(3),
    "decision" TEXT,
    "decision_reason" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "actioned_at" TIMESTAMP(3),

    CONSTRAINT "access_review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "type" "OrganizationType" NOT NULL DEFAULT 'SINGLE_ENTITY',
    "registration_status" "RegistrationStatus" NOT NULL DEFAULT 'NOT_REGISTERED',
    "registration_number" TEXT,
    "tin" TEXT,
    "base_currency" CHAR(3) NOT NULL DEFAULT 'TZS',
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "fiscal_year_end_day" INTEGER NOT NULL DEFAULT 31,
    "tax_jurisdictions" JSONB,
    "default_location_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("organization_id","user_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "sequence" BIGSERIAL NOT NULL,
    "previous_hash" TEXT,
    "entry_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signature_key_version" INTEGER NOT NULL DEFAULT 1,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action" "AuditAction" NOT NULL,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT,
    "entity_label" TEXT,
    "description" TEXT NOT NULL,
    "changes" JSONB,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "session_id" TEXT,
    "channel" "AuditChannel" NOT NULL DEFAULT 'WEB',
    "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
    "error_message" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "sequence" BIGINT NOT NULL DEFAULT 0,
    "entry_hash" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_checkpoints" (
    "id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "sealed_through_sequence" BIGINT NOT NULL,
    "sealed_entry_hash" TEXT NOT NULL,
    "sealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "status" "ChainVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "entries_checked" INTEGER NOT NULL DEFAULT 0,
    "broken_at_sequence" BIGINT,
    "detail" TEXT,

    CONSTRAINT "audit_chain_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "audit_log_id" TEXT,
    "type" "SecurityEventType" NOT NULL,
    "severity" "SecurityEventSeverity" NOT NULL,
    "subject_type" "AuditEntityType",
    "subject_id" TEXT,
    "subject_label" TEXT,
    "description" TEXT NOT NULL,
    "detail" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" TEXT,
    "acknowledgement_note" TEXT,
    "resolved_at" TIMESTAMP(3),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actor_id" TEXT,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyKeyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "user_id" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "action_url" TEXT,
    "suppressed_reason" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "users_password_reset_token_key" ON "users"("password_reset_token");

-- CreateIndex
CREATE INDEX "users_status_isActive_idx" ON "users"("status", "isActive");

-- CreateIndex
CREATE INDEX "users_primary_location_id_idx" ON "users"("primary_location_id");

-- CreateIndex
CREATE INDEX "users_home_department_id_idx" ON "users"("home_department_id");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "mfa_devices_user_id_status_idx" ON "mfa_devices"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE INDEX "sessions_user_id_last_active_at_idx" ON "sessions"("user_id", "last_active_at");

-- CreateIndex
CREATE INDEX "sessions_device_fingerprint_idx" ON "sessions"("device_fingerprint");

-- CreateIndex
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "sessions_revoked_at_idx" ON "sessions"("revoked_at");

-- CreateIndex
CREATE INDEX "login_history_user_id_occurred_at_idx" ON "login_history"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "login_history_email_attempted_occurred_at_idx" ON "login_history"("email_attempted", "occurred_at");

-- CreateIndex
CREATE INDEX "login_history_outcome_occurred_at_idx" ON "login_history"("outcome", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_policies_name_key" ON "auth_policies"("name");

-- CreateIndex
CREATE INDEX "auth_policies_isActive_priority_idx" ON "auth_policies"("isActive", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "roles_isSystem_isActive_idx" ON "roles"("isSystem", "isActive");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_module_action_resource_key" ON "permissions"("module", "action", "resource");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_revoked_at_idx" ON "user_roles"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "user_roles_expires_at_idx" ON "user_roles"("expires_at");

-- CreateIndex
CREATE INDEX "role_scope_grants_role_id_dimension_idx" ON "role_scope_grants"("role_id", "dimension");

-- CreateIndex
CREATE INDEX "role_scope_grants_dimension_dimension_value_id_idx" ON "role_scope_grants"("dimension", "dimension_value_id");

-- CreateIndex
CREATE INDEX "delegations_grantee_id_expires_at_idx" ON "delegations"("grantee_id", "expires_at");

-- CreateIndex
CREATE INDEX "delegations_grantor_id_idx" ON "delegations"("grantor_id");

-- CreateIndex
CREATE INDEX "delegations_role_id_idx" ON "delegations"("role_id");

-- CreateIndex
CREATE INDEX "access_reviews_status_idx" ON "access_reviews"("status");

-- CreateIndex
CREATE INDEX "access_review_items_user_id_idx" ON "access_review_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_review_items_review_id_user_id_role_id_key" ON "access_review_items"("review_id", "user_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_code_key" ON "organizations"("code");

-- CreateIndex
CREATE INDEX "organizations_registration_status_idx" ON "organizations"("registration_status");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_idx" ON "organization_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_sequence_key" ON "audit_logs"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_entry_hash_key" ON "audit_logs"("entry_hash");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_occurred_at_idx" ON "audit_logs"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_result_occurred_at_idx" ON "audit_logs"("result", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs"("request_id");

-- CreateIndex
CREATE INDEX "audit_chain_checkpoints_period_end_idx" ON "audit_chain_checkpoints"("period_end");

-- CreateIndex
CREATE INDEX "audit_chain_checkpoints_status_idx" ON "audit_chain_checkpoints"("status");

-- CreateIndex
CREATE INDEX "security_events_severity_occurred_at_idx" ON "security_events"("severity", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_type_occurred_at_idx" ON "security_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_acknowledged_at_idx" ON "security_events"("acknowledged_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_key_scope_key" ON "idempotency_keys"("key", "scope");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_created_at_idx" ON "notifications"("user_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_channel_dedupe_key_key" ON "notifications"("user_id", "channel", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_category_channel_key" ON "notification_preferences"("user_id", "category", "channel");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_devices" ADD CONSTRAINT "mfa_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scope_grants" ADD CONSTRAINT "role_scope_grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_scope_grants" ADD CONSTRAINT "role_scope_grants_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_grantor_id_fkey" FOREIGN KEY ("grantor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "access_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_audit_log_id_fkey" FOREIGN KEY ("audit_log_id") REFERENCES "audit_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
