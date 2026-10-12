import type { ApprovalPolicy, ApprovalPolicyStep, ApprovalRequest, ApprovalStepInstance, ApprovalDecisionRecord, SODWaiver, Delegation, User, Role, Prisma } from '@/generated/prisma/client';

export type ApprovalEntityType = ApprovalPolicy['entityType'];
export type ApprovalStepType = ApprovalPolicyStep['type'];
export type ApprovalAssigneeType = ApprovalPolicyStep['assigneeType'];
export type ResolutionMode = ApprovalPolicyStep['resolutionMode'];
export type ApprovalConditionOperator = ApprovalPolicyStep['conditionOperator'];
export type ApprovalRequestStatus = ApprovalRequest['status'];
export type ApprovalDecision = ApprovalDecisionRecord['decision'];
export type SODWaiverStatus = SODWaiver['status'];

export interface PolicySnapshotStep {
  stepOrder: number;
  name: string;
  type: ApprovalStepType;
  assigneeType: ApprovalAssigneeType;
  assigneeRoleId: string | null;
  assigneeUserId: string | null;
  resolutionMode: ResolutionMode;
  quorum: number | null;
  conditionOperator: ApprovalConditionOperator | null;
  conditionValue: Prisma.InputJsonValue | null;
  isRequired: boolean;
  isFinalApprover: boolean;
  resolvedAssigneeIds: string[];
}

export interface PolicySnapshot {
  policyId: string;
  policyName: string;
  entityType: ApprovalEntityType;
  steps: PolicySnapshotStep[];
  createdAt: Date;
}

export interface ConditionContext {
  amount?: number;
  currencyCode?: string;
  projectId?: string | null;
  departmentId?: string | null;
  costCentreId?: string | null;
  fundingSourceId?: string | null;
  accountId?: string | null;
  transactionDate?: Date;
  requiredCondition?: ApprovalConditionOperator;
  counterpartyId?: string | null;
  counterpartyBankDetailsChanged?: boolean;
  organizationId: string;
  entityType: ApprovalEntityType;
  entityId: string;
  submittedById: string;
}

export interface ApproverResolutionResult {
  assigneeType: ApprovalAssigneeType;
  assigneeRoleId: string | null;
  assigneeUserId: string | null;
  resolvedAssigneeIds: string[];
  delegationId: string | null;
  sodViolation: boolean;
  sodWaiverId: string | null;
}

export interface AdvanceRequestResult {
  request: ApprovalRequest;
  stepInstance: ApprovalStepInstance | null;
  decisionRecord: ApprovalDecisionRecord;
  isComplete: boolean;
  nextStepInstance: ApprovalStepInstance | null;
}

export interface DelegationScope {
  maxAmount?: number;
  currency?: string;
  entityTypes?: ApprovalEntityType[];
  dimensionLimits?: Record<string, string[]>;
}

export interface SelectPolicyResult {
  policy: ApprovalPolicy & { steps: (ApprovalPolicyStep & { assigneeRole: Role | null; assigneeUser: User | null })[] };
  snapshot: PolicySnapshot;
}

export { ApprovalRequest, ApprovalStepInstance, ApprovalDecisionRecord };
