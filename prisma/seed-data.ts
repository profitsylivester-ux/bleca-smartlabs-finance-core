import type { ModuleKey, PermissionAction, ProjectStatus, FundingSourceType, CurrencyType } from '@/generated/prisma/client';

/** Reason code categories. */
export type ReasonCodeCategory = 'REVENUE' | 'EXPENSE' | 'TRANSFER' | 'ADJUSTMENT' | 'OTHER';

/**
 * Permission catalogue.
 *
 * Permissions are the Cartesian product of Module x Action, created as DATA. That
 * is the whole point of RBAC being configurable by role, module and action
 * (PDF 5): adding a role or revoking a permission is an insert or a delete on
 * role_permissions, not a code change and not a deploy.
 *
 * Two entries deliberately carry requiresStepUpAuth:
 *   - USER_ROLES / ADMINISTER: granting permissions is the highest-value action
 *     in the system. A stolen CEO password should not be enough to mint a new CEO.
 *   - SUPPLIERS / EDIT on supplier.bank_details: PDF 23's fraud pattern.
 */

export interface PermissionSeed {
  module: ModuleKey;
  action: PermissionAction;
  resource?: string;
  description: string;
  requiresStepUpAuth?: boolean;
}

/** Actions that only ever make sense on a module that owns records. */
const FULL_CRUD: PermissionAction[] = [
  'VIEW',
  'CREATE',
  'EDIT',
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'POST',
  'REVERSE',
];

const READ_EXPORT: PermissionAction[] = ['VIEW', 'EXPORT'];
const READ_EXPORT_CONFIG: PermissionAction[] = ['VIEW', 'EXPORT', 'CONFIGURE'];

/**
 * Named action sets rather than inline array literals: spreading a
 * `PermissionAction[]` into a new array widens the element type back to string,
 * which silently loses the enum type at the boundary.
 */
const BUDGET_ACTIONS: PermissionAction[] = [
  'VIEW',
  'EXPORT',
  'CREATE',
  'EDIT',
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'POST',
];

const SALES_ACTIONS: PermissionAction[] = [...BUDGET_ACTIONS, 'REVERSE'];

export const PERMISSIONS: PermissionSeed[] = [
  // ---- Dashboards -----------------------------------------------------------
  { module: 'DASHBOARD_CEO', action: 'VIEW', description: 'View the executive dashboard' },
  { module: 'DASHBOARD_FINANCE', action: 'VIEW', description: 'View the finance dashboard' },

  // ---- Identity and access --------------------------------------------------
  { module: 'USERS_ROLES', action: 'VIEW', description: 'View users, roles and grants' },
  { module: 'USERS_ROLES', action: 'CREATE', description: 'Create users and roles' },
  { module: 'USERS_ROLES', action: 'EDIT', description: 'Edit user profiles and role assignments' },
  {
    module: 'USERS_ROLES',
    action: 'ADMINISTER',
    description: 'Grant and revoke permissions',
    requiresStepUpAuth: true,
  },
  {
    module: 'USERS_ROLES',
    action: 'CONFIGURE',
    description: 'Change authentication policy (lockout, timeouts, MFA requirements)',
    requiresStepUpAuth: true,
  },
  { module: 'USERS_ROLES', action: 'EXPORT', description: 'Export the user and access register' },

  // ---- Accounting -----------------------------------------------------------
  ...(
    ['CHART_OF_ACCOUNTS', 'JOURNAL_ENTRIES', 'GENERAL_LEDGER', 'TRANSACTIONS'] as ModuleKey[]
  ).flatMap((module): PermissionSeed[] =>
    FULL_CRUD.map((action) => ({ module, action, description: `${action} ${module}` })),
  ),
  { module: 'TRIAL_BALANCE', action: 'VIEW', description: 'View the trial balance' },
  { module: 'APPROVALS', action: 'VIEW', description: 'View approval requests and history' },
  {
    module: 'APPROVALS',
    action: 'APPROVE',
    description: 'Approve or reject requests assigned to you',
  },
  { module: 'APPROVALS', action: 'ADMINISTER', description: 'Configure approval policies' },
  { module: 'PERIODS', action: 'VIEW', description: 'View financial periods' },
  { module: 'PERIODS', action: 'EDIT', description: 'Open, close and reopen periods' },
  {
    module: 'PERIODS',
    action: 'ADMINISTER',
    description: 'Reopen a locked period',
    requiresStepUpAuth: true,
  },
  { module: 'FINANCIAL_CLOSE', action: 'VIEW', description: 'View the close checklist' },
  { module: 'FINANCIAL_CLOSE', action: 'SUBMIT', description: 'Submit the close for sign-off' },
  { module: 'FINANCIAL_CLOSE', action: 'APPROVE', description: 'Give final close sign-off' },

  // ---- Treasury -------------------------------------------------------------
  ...(['CASH', 'BANK', 'MOBILE_MONEY', 'PAYMENT_GATEWAYS'] as ModuleKey[]).flatMap(
    (module): PermissionSeed[] =>
      READ_EXPORT_CONFIG.map((action) => ({
        module,
        action,
        description: `${action} ${module} accounts`,
      })),
  ),
  ...(['TREASURY_TRANSFERS', 'RECONCILIATION', 'STATEMENT_IMPORT'] as ModuleKey[]).flatMap(
    (module): PermissionSeed[] =>
      FULL_CRUD.map((action) => ({ module, action, description: `${action} ${module}` })),
  ),

  // ---- Planning and counterparties ------------------------------------------
  ...(['BUDGETS', 'COMMITMENTS'] as ModuleKey[]).flatMap((module): PermissionSeed[] =>
    BUDGET_ACTIONS.map((action) => ({
      module,
      action,
      description: `${action} ${module}`,
    })),
  ),
  ...(
    [
      'CUSTOMERS',
      'SUPPLIERS',
      'QUOTATIONS',
      'INVOICES',
      'PAYMENTS',
      'RECEIPTS',
      'CREDIT_NOTES',
    ] as ModuleKey[]
  ).flatMap((module): PermissionSeed[] =>
    SALES_ACTIONS.map((action) => ({
      module,
      action,
      description: `${action} ${module}`,
    })),
  ),
  {
    module: 'SUPPLIERS',
    action: 'EDIT',
    resource: 'supplier.bank_details',
    description: 'Change supplier bank details (controlled change, PDF 23)',
    requiresStepUpAuth: true,
  },

  // ---- Documents, master data, tax -------------------------------------------
  ...(['DOCUMENTS', 'MASTER_DATA', 'IMPORTS'] as ModuleKey[]).flatMap((module): PermissionSeed[] =>
    READ_EXPORT_CONFIG.map((action) => ({ module, action, description: `${action} ${module}` })),
  ),
  { module: 'DOCUMENTS', action: 'EDIT', description: 'Classify, tag and version documents' },
  { module: 'DOCUMENTS', action: 'APPROVE', description: 'Approve documents for use as evidence' },
  { module: 'MASTER_DATA', action: 'APPROVE', description: 'Approve master data changes' },
  ...(
    ['TAX_COMPLIANCE', 'REPORTS', 'NOTIFICATIONS', 'SEARCH', 'ANOMALY_DETECTION'] as ModuleKey[]
  ).flatMap((module): PermissionSeed[] =>
    READ_EXPORT.map((action) => ({ module, action, description: `${action} ${module}` })),
  ),
  {
    module: 'TAX_COMPLIANCE',
    action: 'CONFIGURE',
    description: 'Configure tax rules (accountant verified)',
  },
  {
    module: 'TAX_COMPLIANCE',
    action: 'APPROVE',
    description: 'Record accountant sign-off on tax rules',
  },
  { module: 'REPORTS', action: 'CONFIGURE', description: 'Manage the report registry' },

  // ---- Governance -----------------------------------------------------------
  { module: 'AUDIT_TRAIL', action: 'VIEW', description: 'Query the audit trail' },
  {
    module: 'AUDIT_TRAIL',
    action: 'EXPORT',
    description: 'Export audit data',
    requiresStepUpAuth: true,
  },
  { module: 'AUDIT_TRAIL', action: 'ADMINISTER', description: 'Verify and seal the audit chain' },
  { module: 'BACKUP_ADMIN', action: 'VIEW', description: 'View backup and restore history' },
  { module: 'BACKUP_ADMIN', action: 'ADMINISTER', description: 'Run and verify restores' },
  {
    module: 'API_ADMIN',
    action: 'ADMINISTER',
    description: 'Manage API keys and webhooks',
    requiresStepUpAuth: true,
  },
];

export interface RoleSeed {
  code: string;
  name: string;
  description: string;
  isFinalApprover: boolean;
  permissions: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }>;
}

/**
 * Which permission tuples each Phase 1 role receives.
 *
 * Read this as the answer to "what can this person do", not as a UI concern.
 * Q2 is encoded here and nowhere else: the CEO holds APPROVE on every financial
 * module, and there is no amount band below which approval is skipped.
 */

/** Modules where an item must reach the CEO before it can move (Q2: every amount). */
const CEO_APPROVAL_MODULES: ModuleKey[] = [
  'TRANSACTIONS',
  'JOURNAL_ENTRIES',
  'INVOICES',
  'PAYMENTS',
  'RECEIPTS',
  'CREDIT_NOTES',
  'BUDGETS',
  'COMMITMENTS',
  'TREASURY_TRANSFERS',
];

const CEO_ONLY: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }> = [
  ...CEO_APPROVAL_MODULES.flatMap((module) => [
    { module, action: 'APPROVE' as PermissionAction },
    { module, action: 'REJECT' as PermissionAction },
  ]),
  { module: 'APPROVALS', action: 'APPROVE' },
  { module: 'APPROVALS', action: 'ADMINISTER' },
  { module: 'FINANCIAL_CLOSE', action: 'APPROVE' },
  { module: 'PERIODS', action: 'ADMINISTER' },
  { module: 'AUDIT_TRAIL', action: 'ADMINISTER' },
];

const CEO_ADDITIONAL: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }> = [
  { module: 'USERS_ROLES', action: 'ADMINISTER' },
  { module: 'USERS_ROLES', action: 'CONFIGURE' },
  { module: 'API_ADMIN', action: 'ADMINISTER' },
  { module: 'BACKUP_ADMIN', action: 'ADMINISTER' },
  { module: 'AUDIT_TRAIL', action: 'EXPORT' },
  { module: 'SUPPLIERS', action: 'EDIT', resource: 'supplier.bank_details' },
];

/** Everything the CEO may read or change, short of the CEO_ONLY list. */
const CEO_BREADTH: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }> =
  PERMISSIONS.filter(
    (p) =>
      p.action !== 'APPROVE' &&
      p.action !== 'REJECT' &&
      !CEO_ADDITIONAL.some(
        (c) => c.module === p.module && c.action === p.action && c.resource === p.resource,
      ),
  ).map((p) => ({ module: p.module, action: p.action, resource: p.resource }));

const FINANCE_OFFICER_BREADTH: Array<{
  module: ModuleKey;
  action: PermissionAction;
  resource?: string;
}> = PERMISSIONS.filter(
  (p) =>
    // Deliberately absent: ADMINISTER and CONFIGURE everywhere, every
    // APPROVE and REJECT, and the step-up-protected supplier bank details.
    p.action !== 'APPROVE' &&
    p.action !== 'REJECT' &&
    p.action !== 'ADMINISTER' &&
    p.action !== 'CONFIGURE' &&
    !(p.module === 'SUPPLIERS' && p.resource === 'supplier.bank_details'),
).map((p) => ({ module: p.module, action: p.action, resource: p.resource }));

export const ROLES: RoleSeed[] = [
  {
    code: 'CEO',
    name: 'Chief Executive Officer',
    description:
      'Final approval authority for every financial action. Unrestricted scope. Cannot be silently bypassed; where the CEO prepares and posts a personal item, a waiver is recorded and shown as a SoD exception.',
    isFinalApprover: true,
    permissions: dedupe([...CEO_BREADTH, ...CEO_ADDITIONAL, ...CEO_ONLY]),
  },
  {
    code: 'FINANCE_OFFICER',
    name: 'Finance Officer',
    description:
      'Records, reconciles and prepares. Submits for approval. Cannot approve any submission, including their own, and cannot approve own work at any step of the chain.',
    isFinalApprover: false,
    permissions: dedupe(FINANCE_OFFICER_BREADTH),
  },
  {
    code: 'AUDITOR',
    name: 'Auditor (read-only)',
    description:
      'Seeded and unassigned in Phase 1. Read-only across ledger, reports and audit, with no EDIT, POST or APPROVE anywhere. Exists now so access reviews have something to certify against on day one.',
    isFinalApprover: false,
    permissions: dedupe(
      PERMISSIONS.filter((p) => p.action === 'VIEW' || p.action === 'EXPORT').map((p) => ({
        module: p.module,
        action: p.action,
        resource: p.resource,
      })),
    ),
  },
];

function dedupe(
  permissions: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }>,
): Array<{ module: ModuleKey; action: PermissionAction; resource?: string }> {
  const seen = new Set<string>();
  const out: Array<{ module: ModuleKey; action: PermissionAction; resource?: string }> = [];
  for (const p of permissions) {
    const key = `${p.module}:${p.action}:${p.resource ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const ORG = {
  code: 'BLECA',
  name: 'BLECA SmartLabs',
  legalName: null,
  /**
   * PDF 2: not yet registered, no permanent premises, operating from Mbeya using
   * university facilities with permission. registrationStatus stays NOT_REGISTERED
   * and tin stays null until that changes in reality - the schema tolerates both
   * rather than pretending otherwise.
   */
  registrationStatus: 'NOT_REGISTERED' as const,
  baseCurrency: 'TZS',
  fiscalYearStartMonth: 1,
  fiscalYearEndDay: 31,
};

export const AUTH_POLICY = {
  name: 'DEFAULT',
  priority: 100,
  maxFailedAttempts: 5,
  lockoutDurationMinutes: 15,
  rateLimitWindowSeconds: 15,
  maxAttemptsPerWindow: 8,
  ipRateLimitPerMinute: 20,
  sessionIdleTimeoutMinutes: 30,
  sessionAbsoluteTimeoutHours: 12,
  passwordMinLength: 12,
  passwordRequireUppercase: true,
  passwordRequireLowercase: true,
  passwordRequireNumber: true,
  passwordRequireSymbol: true,
  // PDF 4 plus BUILD_PROMPT 7: the two roles that can move money must hold MFA.
  mfaRequiredRoleCodes: ['CEO', 'FINANCE_OFFICER'],
  mfaChallengeTimeoutMinutes: 10,
  stepUpTimeoutMinutes: 5,
};

export const PROJECTS = [
  {
    code: 'IVENTIKA',
    name: 'Iventika',
    description: 'Iventika research and development project.',
    status: 'ACTIVE' as ProjectStatus,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2026-12-31'),
    isActive: true,
  },
  {
    code: 'UZANITE',
    name: 'Uzanite',
    description: 'Uzanite infrastructure project.',
    status: 'ACTIVE' as ProjectStatus,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2027-06-30'),
    isActive: true,
  },
];

export const FUNDING_SOURCES = [
  {
    code: 'UNRESTRICTED',
    name: 'Unrestricted Funds',
    type: 'UNRESTRICTED' as FundingSourceType,
    description: 'General unrestricted operating funds.',
    isRestricted: false,
    restrictions: undefined,
    isActive: true,
  },
  {
    code: 'RESTRICTED-GRANT',
    name: 'Restricted Grant',
    type: 'RESTRICTED_GRANT' as FundingSourceType,
    description: 'Externally restricted grant funding with specific use constraints.',
    isRestricted: true,
    restrictions: { allowedProjects: ['IVENTIKA', 'UZANITE'], allowedCostCategories: ['PERSONNEL', 'EQUIPMENT', 'TRAVEL'] },
    isActive: true,
  },
];

export const CURRENCIES = [
  {
    code: 'TZS',
    name: 'Tanzanian Shilling',
    symbol: 'TSh',
    type: 'FIAT' as CurrencyType,
    decimalPlaces: 2,
    isBase: true,
    isActive: true,
  },
  {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    type: 'FIAT' as CurrencyType,
    decimalPlaces: 2,
    isBase: false,
    isActive: true,
  },
  {
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    type: 'FIAT' as CurrencyType,
    decimalPlaces: 2,
    isBase: false,
    isActive: true,
  },
  {
    code: 'GBP',
    name: 'British Pound',
    symbol: '£',
    type: 'FIAT' as CurrencyType,
    decimalPlaces: 2,
    isBase: false,
    isActive: true,
  },
];

export interface ReasonCodeSeed {
  code: string;
  name: string;
  description: string;
  category: ReasonCodeCategory;
}

export const REASON_CODES: ReasonCodeSeed[] = [
  // Revenue reasons
  { code: 'GRANT-UNRESTRICTED', name: 'Unrestricted Grant Revenue', description: 'Revenue from unrestricted grants', category: 'REVENUE' },
  { code: 'GRANT-RESTRICTED', name: 'Restricted Grant Revenue', description: 'Revenue from restricted grants with specific use constraints', category: 'REVENUE' },
  { code: 'CONTRACT-REVENUE', name: 'Contract Revenue', description: 'Revenue from service contracts and deliverables', category: 'REVENUE' },
  { code: 'DONATION', name: 'Donation Revenue', description: 'Unrestricted donations and contributions', category: 'REVENUE' },
  { code: 'INTEREST-INCOME', name: 'Interest Income', description: 'Interest earned on bank deposits and investments', category: 'REVENUE' },
  { code: 'OTHER-INCOME', name: 'Other Income', description: 'Miscellaneous income not categorized elsewhere', category: 'REVENUE' },

  // Expense reasons
  { code: 'PERSONNEL', name: 'Personnel Costs', description: 'Salaries, wages, benefits, and payroll taxes', category: 'EXPENSE' },
  { code: 'TRAVEL', name: 'Travel & Subsistence', description: 'Travel expenses, accommodation, and daily allowances', category: 'EXPENSE' },
  { code: 'EQUIPMENT', name: 'Equipment & Supplies', description: 'Purchase of equipment, furniture, and consumable supplies', category: 'EXPENSE' },
  { code: 'CONSULTANCY', name: 'Consultancy & Professional Fees', description: 'External consultants, auditors, and professional services', category: 'EXPENSE' },
  { code: 'WORKSHOP', name: 'Workshops & Training', description: 'Training courses, workshops, and capacity building events', category: 'EXPENSE' },
  { code: 'OFFICE-RENT', name: 'Office Rent & Utilities', description: 'Rent, electricity, water, internet, and office maintenance', category: 'EXPENSE' },
  { code: 'COMMUNICATION', name: 'Communication', description: 'Phone, postage, and communication expenses', category: 'EXPENSE' },
  { code: 'VEHICLE', name: 'Vehicle Running Costs', description: 'Fuel, maintenance, insurance, and vehicle hire', category: 'EXPENSE' },
  { code: 'BANK-CHARGES', name: 'Bank Charges', description: 'Bank fees, transfer charges, and currency conversion fees', category: 'EXPENSE' },
  { code: 'OTHER-EXPENSE', name: 'Other Expenses', description: 'Miscellaneous expenses not categorized elsewhere', category: 'EXPENSE' },

  // Transfer reasons
  { code: 'INTER-PROJECT', name: 'Inter-Project Transfer', description: 'Transfer of funds between projects', category: 'TRANSFER' },
  { code: 'CORE-FUNDING', name: 'Core Funding Allocation', description: 'Allocation from core/unrestricted funds to projects', category: 'TRANSFER' },
  { code: 'RETURN-FUNDS', name: 'Return of Funds', description: 'Return of unspent funds to donor or central pool', category: 'TRANSFER' },

  // Adjustment reasons
  { code: 'FX-GAIN', name: 'Foreign Exchange Gain', description: 'Realized or unrealized gain from currency fluctuations', category: 'ADJUSTMENT' },
  { code: 'FX-LOSS', name: 'Foreign Exchange Loss', description: 'Realized or unrealized loss from currency fluctuations', category: 'ADJUSTMENT' },
  { code: 'REVALUATION', name: 'Asset Revaluation', description: 'Revaluation of assets or liabilities', category: 'ADJUSTMENT' },
  { code: 'WRITE-OFF', name: 'Write-off', description: 'Write-off of unrecoverable receivables or obsolete assets', category: 'ADJUSTMENT' },
  { code: 'PRIOR-YEAR', name: 'Prior Year Adjustment', description: 'Correction of prior period errors', category: 'ADJUSTMENT' },

  // Other
  { code: 'OPENING-BAL', name: 'Opening Balance', description: 'Opening balance entry for new accounts or periods', category: 'OTHER' },
  { code: 'CLOSING-BAL', name: 'Closing Balance', description: 'Closing balance entry at period end', category: 'OTHER' },
];

export interface AccountSeed {
  code: string;
  name: string;
  description?: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subCategory?: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  parentCode?: string;
  isPostable?: boolean;
  isReconcilable?: boolean;
  requiresDocument?: boolean;
  status?: 'ACTIVE' | 'INACTIVE' | 'LOCKED' | 'PENDING_ARCHIVE';
}

export const CHART_OF_ACCOUNTS_PDF7: AccountSeed[] = [
  // ============================================================
  // ASSETS (normal balance: DEBIT)
  // ============================================================
  { code: '1000', name: 'Assets', description: 'Total assets', type: 'ASSET', normalBalance: 'DEBIT', isPostable: false },
  
  // Current Assets
  { code: '1100', name: 'Current Assets', description: 'Current assets', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', isPostable: false },
  
  // Cash & Cash Equivalents
  { code: '1110', name: 'Cash & Cash Equivalents', description: 'Cash and cash equivalents', type: 'ASSET', subCategory: 'CASH', normalBalance: 'DEBIT', parentCode: '1100', isPostable: false },
  { code: '1111', name: 'Cash on Hand', description: 'Physical cash held', type: 'ASSET', subCategory: 'CASH', normalBalance: 'DEBIT', parentCode: '1110', isPostable: true, isReconcilable: true },
  { code: '1112', name: 'Petty Cash', description: 'Petty cash fund', type: 'ASSET', subCategory: 'CASH', normalBalance: 'DEBIT', parentCode: '1110', isPostable: true, isReconcilable: true },
  
  // Bank Accounts
  { code: '1120', name: 'Bank Accounts', description: 'Bank account balances', type: 'ASSET', subCategory: 'BANK', normalBalance: 'DEBIT', parentCode: '1100', isPostable: false },
  { code: '1121', name: 'CRDB Bank - TZS', description: 'CRDB Bank Tanzanian Shilling account', type: 'ASSET', subCategory: 'BANK', normalBalance: 'DEBIT', parentCode: '1120', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1122', name: 'CRDB Bank - USD', description: 'CRDB Bank US Dollar account', type: 'ASSET', subCategory: 'BANK', normalBalance: 'DEBIT', parentCode: '1120', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1123', name: 'NMB Bank - TZS', description: 'NMB Bank Tanzanian Shilling account', type: 'ASSET', subCategory: 'BANK', normalBalance: 'DEBIT', parentCode: '1120', isPostable: true, isReconcilable: true, requiresDocument: true },
  
  // Mobile Money
  { code: '1130', name: 'Mobile Money', description: 'Mobile money balances', type: 'ASSET', subCategory: 'MOBILE_MONEY', normalBalance: 'DEBIT', parentCode: '1100', isPostable: false },
  { code: '1131', name: 'M-Pesa', description: 'Vodacom M-Pesa balance', type: 'ASSET', subCategory: 'MOBILE_MONEY', normalBalance: 'DEBIT', parentCode: '1130', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1132', name: 'Tigo Pesa', description: 'Tigo Pesa balance', type: 'ASSET', subCategory: 'MOBILE_MONEY', normalBalance: 'DEBIT', parentCode: '1130', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1133', name: 'Airtel Money', description: 'Airtel Money balance', type: 'ASSET', subCategory: 'MOBILE_MONEY', normalBalance: 'DEBIT', parentCode: '1130', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1134', name: 'Halopesa', description: 'Halopesa balance', type: 'ASSET', subCategory: 'MOBILE_MONEY', normalBalance: 'DEBIT', parentCode: '1130', isPostable: true, isReconcilable: true, requiresDocument: true },
  
  // Receivables
  { code: '1140', name: 'Receivables', description: 'Trade and other receivables', type: 'ASSET', subCategory: 'RECEIVABLE', normalBalance: 'DEBIT', parentCode: '1100', isPostable: false },
  { code: '1141', name: 'Trade Receivables', description: 'Customer invoices outstanding', type: 'ASSET', subCategory: 'RECEIVABLE', normalBalance: 'DEBIT', parentCode: '1140', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '1142', name: 'Staff Advances', description: 'Advances to staff', type: 'ASSET', subCategory: 'RECEIVABLE', normalBalance: 'DEBIT', parentCode: '1140', isPostable: true, isReconcilable: true },
  { code: '1143', name: 'Other Receivables', description: 'Miscellaneous receivables', type: 'ASSET', subCategory: 'RECEIVABLE', normalBalance: 'DEBIT', parentCode: '1140', isPostable: true },
  
  // Inventory (Phase 2 - dormant)
  { code: '1150', name: 'Inventory', description: 'Inventory stock', type: 'ASSET', subCategory: 'INVENTORY', normalBalance: 'DEBIT', parentCode: '1100', isPostable: false, status: 'INACTIVE' },
  { code: '1151', name: 'Raw Materials', description: 'Raw materials inventory', type: 'ASSET', subCategory: 'INVENTORY', normalBalance: 'DEBIT', parentCode: '1150', isPostable: true, status: 'INACTIVE' },
  { code: '1152', name: 'Work in Progress', description: 'Work in progress inventory', type: 'ASSET', subCategory: 'INVENTORY', normalBalance: 'DEBIT', parentCode: '1150', isPostable: true, status: 'INACTIVE' },
  { code: '1153', name: 'Finished Goods', description: 'Finished goods inventory', type: 'ASSET', subCategory: 'INVENTORY', normalBalance: 'DEBIT', parentCode: '1150', isPostable: true, status: 'INACTIVE' },
  
  // Non-Current Assets
  { code: '1200', name: 'Non-Current Assets', description: 'Long-term assets', type: 'ASSET', normalBalance: 'DEBIT', parentCode: '1000', isPostable: false },
  
  // Equipment (Phase 2 - dormant)
  { code: '1210', name: 'Equipment', description: 'Equipment and machinery', type: 'ASSET', subCategory: 'EQUIPMENT', normalBalance: 'DEBIT', parentCode: '1200', isPostable: false, status: 'INACTIVE' },
  { code: '1211', name: 'Office Equipment', description: 'Office equipment and furniture', type: 'ASSET', subCategory: 'EQUIPMENT', normalBalance: 'DEBIT', parentCode: '1210', isPostable: true, status: 'INACTIVE' },
  { code: '1212', name: 'Lab Equipment', description: 'Laboratory equipment', type: 'ASSET', subCategory: 'EQUIPMENT', normalBalance: 'DEBIT', parentCode: '1210', isPostable: true, status: 'INACTIVE' },
  { code: '1213', name: 'Computer Equipment', description: 'Computers and peripherals', type: 'ASSET', subCategory: 'EQUIPMENT', normalBalance: 'DEBIT', parentCode: '1210', isPostable: true, status: 'INACTIVE' },
  
  // Other Assets
  { code: '1290', name: 'Other Non-Current Assets', description: 'Other long-term assets', type: 'ASSET', subCategory: 'OTHER_ASSET', normalBalance: 'DEBIT', parentCode: '1200', isPostable: false },
  { code: '1291', name: 'Intangible Assets', description: 'Software licenses, patents', type: 'ASSET', subCategory: 'OTHER_ASSET', normalBalance: 'DEBIT', parentCode: '1290', isPostable: true },
  { code: '1292', name: 'Deposits & Prepayments', description: 'Long-term deposits and prepayments', type: 'ASSET', subCategory: 'OTHER_ASSET', normalBalance: 'DEBIT', parentCode: '1290', isPostable: true },
  
  // ============================================================
  // LIABILITIES (normal balance: CREDIT)
  // ============================================================
  { code: '2000', name: 'Liabilities', description: 'Total liabilities', type: 'LIABILITY', normalBalance: 'CREDIT', isPostable: false },
  
  // Current Liabilities
  { code: '2100', name: 'Current Liabilities', description: 'Short-term obligations', type: 'LIABILITY', normalBalance: 'CREDIT', parentCode: '2000', isPostable: false },
  
  // Supplier Payables
  { code: '2110', name: 'Supplier Payables', description: 'Trade payables to suppliers', type: 'LIABILITY', subCategory: 'SUPPLIER_PAYABLE', normalBalance: 'CREDIT', parentCode: '2100', isPostable: false },
  { code: '2111', name: 'Trade Payables', description: 'Supplier invoices outstanding', type: 'LIABILITY', subCategory: 'SUPPLIER_PAYABLE', normalBalance: 'CREDIT', parentCode: '2110', isPostable: true, isReconcilable: true, requiresDocument: true },
  { code: '2112', name: 'Accrued Supplier Invoices', description: 'Accrued but not yet invoiced', type: 'LIABILITY', subCategory: 'SUPPLIER_PAYABLE', normalBalance: 'CREDIT', parentCode: '2110', isPostable: true, isReconcilable: true },
  
  // Tax Payables
  { code: '2120', name: 'Tax Payables', description: 'Tax obligations', type: 'LIABILITY', subCategory: 'TAX_PAYABLE', normalBalance: 'CREDIT', parentCode: '2100', isPostable: false },
  { code: '2121', name: 'VAT Payable', description: 'Value Added Tax payable', type: 'LIABILITY', subCategory: 'TAX_PAYABLE', normalBalance: 'CREDIT', parentCode: '2120', isPostable: true, requiresDocument: true },
  { code: '2122', name: 'PAYE Payable', description: 'Pay As You Earn tax payable', type: 'LIABILITY', subCategory: 'TAX_PAYABLE', normalBalance: 'CREDIT', parentCode: '2120', isPostable: true, requiresDocument: true },
  { code: '2123', name: 'SDL Payable', description: 'Skills Development Levy payable', type: 'LIABILITY', subCategory: 'TAX_PAYABLE', normalBalance: 'CREDIT', parentCode: '2120', isPostable: true, requiresDocument: true },
  { code: '2124', name: 'WHT Payable', description: 'Withholding Tax payable', type: 'LIABILITY', subCategory: 'TAX_PAYABLE', normalBalance: 'CREDIT', parentCode: '2120', isPostable: true, requiresDocument: true },
  
  // Accrued Expenses
  { code: '2130', name: 'Accrued Expenses', description: 'Expenses incurred but not yet paid', type: 'LIABILITY', subCategory: 'ACCRUED_EXPENSE', normalBalance: 'CREDIT', parentCode: '2100', isPostable: false },
  { code: '2131', name: 'Accrued Salaries', description: 'Salaries earned but not yet paid', type: 'LIABILITY', subCategory: 'ACCRUED_EXPENSE', normalBalance: 'CREDIT', parentCode: '2130', isPostable: true },
  { code: '2132', name: 'Accrued Expenses - Other', description: 'Other accrued expenses', type: 'LIABILITY', subCategory: 'ACCRUED_EXPENSE', normalBalance: 'CREDIT', parentCode: '2130', isPostable: true },
  
  // Other Current Liabilities
  { code: '2190', name: 'Other Current Liabilities', description: 'Other short-term obligations', type: 'LIABILITY', subCategory: 'OTHER_OBLIGATION', normalBalance: 'CREDIT', parentCode: '2100', isPostable: false },
  { code: '2191', name: 'Deferred Revenue', description: 'Revenue received in advance', type: 'LIABILITY', subCategory: 'OTHER_OBLIGATION', normalBalance: 'CREDIT', parentCode: '2190', isPostable: true, requiresDocument: true },
  { code: '2192', name: 'Staff Deductions Payable', description: 'Statutory and voluntary deductions', type: 'LIABILITY', subCategory: 'OTHER_OBLIGATION', normalBalance: 'CREDIT', parentCode: '2190', isPostable: true },
  
  // Non-Current Liabilities
  { code: '2200', name: 'Non-Current Liabilities', description: 'Long-term obligations', type: 'LIABILITY', normalBalance: 'CREDIT', parentCode: '2000', isPostable: false },
  { code: '2210', name: 'Long-term Loans', description: 'Long-term borrowings', type: 'LIABILITY', subCategory: 'LOAN', normalBalance: 'CREDIT', parentCode: '2200', isPostable: true, requiresDocument: true },
  
  // ============================================================
  // EQUITY (normal balance: CREDIT)
  // ============================================================
  { code: '3000', name: 'Equity', description: 'Total equity', type: 'EQUITY', normalBalance: 'CREDIT', isPostable: false },
  { code: '3100', name: 'Share Capital', description: 'Issued share capital', type: 'EQUITY', subCategory: 'CAPITAL', normalBalance: 'CREDIT', parentCode: '3000', isPostable: true, requiresDocument: true },
  { code: '3200', name: 'Retained Earnings', description: 'Accumulated profits/losses', type: 'EQUITY', subCategory: 'RETAINED_EARNINGS', normalBalance: 'CREDIT', parentCode: '3000', isPostable: false },
  { code: '3201', name: 'Retained Earnings Brought Forward', description: 'Opening retained earnings', type: 'EQUITY', subCategory: 'RETAINED_EARNINGS', normalBalance: 'CREDIT', parentCode: '3200', isPostable: true },
  { code: '3202', name: 'Current Year Earnings', description: 'Profit/loss for current year', type: 'EQUITY', subCategory: 'RETAINED_EARNINGS', normalBalance: 'CREDIT', parentCode: '3200', isPostable: false },
  
  // Future Investment (Phase 2 - dormant)
  { code: '3300', name: 'Future Investment Reserve', description: 'Reserve for future investments', type: 'EQUITY', subCategory: 'FUTURE_INVESTMENT', normalBalance: 'CREDIT', parentCode: '3000', isPostable: true, status: 'INACTIVE' },
  
  // ============================================================
  // REVENUE (normal balance: CREDIT)
  // ============================================================
  { code: '4000', name: 'Revenue', description: 'Total revenue', type: 'REVENUE', normalBalance: 'CREDIT', isPostable: false },
  
  // Training Revenue
  { code: '4100', name: 'Training Revenue', description: 'Revenue from training services', type: 'REVENUE', subCategory: 'REVENUE_TRAINING', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false },
  { code: '4101', name: 'Training - Corporate', description: 'Corporate training programs', type: 'REVENUE', subCategory: 'REVENUE_TRAINING', normalBalance: 'CREDIT', parentCode: '4100', isPostable: true, requiresDocument: true },
  { code: '4102', name: 'Training - Public', description: 'Public training courses', type: 'REVENUE', subCategory: 'REVENUE_TRAINING', normalBalance: 'CREDIT', parentCode: '4100', isPostable: true, requiresDocument: true },
  { code: '4103', name: 'Training - Online', description: 'Online training revenue', type: 'REVENUE', subCategory: 'REVENUE_TRAINING', normalBalance: 'CREDIT', parentCode: '4100', isPostable: true, requiresDocument: true },
  
  // Consulting Revenue
  { code: '4200', name: 'Consulting Revenue', description: 'Revenue from consulting services', type: 'REVENUE', subCategory: 'REVENUE_CONSULTING', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false },
  { code: '4201', name: 'Consulting - Strategy', description: 'Strategic consulting services', type: 'REVENUE', subCategory: 'REVENUE_CONSULTING', normalBalance: 'CREDIT', parentCode: '4200', isPostable: true, requiresDocument: true },
  { code: '4202', name: 'Consulting - Technical', description: 'Technical consulting services', type: 'REVENUE', subCategory: 'REVENUE_CONSULTING', normalBalance: 'CREDIT', parentCode: '4200', isPostable: true, requiresDocument: true },
  { code: '4203', name: 'Consulting - Research', description: 'Research consulting services', type: 'REVENUE', subCategory: 'REVENUE_CONSULTING', normalBalance: 'CREDIT', parentCode: '4200', isPostable: true, requiresDocument: true },
  
  // Software Revenue
  { code: '4300', name: 'Software Revenue', description: 'Revenue from software products', type: 'REVENUE', subCategory: 'REVENUE_SOFTWARE', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false },
  { code: '4301', name: 'Software - Licenses', description: 'Software license sales', type: 'REVENUE', subCategory: 'REVENUE_SOFTWARE', normalBalance: 'CREDIT', parentCode: '4300', isPostable: true, requiresDocument: true },
  { code: '4302', name: 'Software - Custom Development', description: 'Custom software development', type: 'REVENUE', subCategory: 'REVENUE_SOFTWARE', normalBalance: 'CREDIT', parentCode: '4300', isPostable: true, requiresDocument: true },
  
  // SaaS Revenue (Phase 2)
  { code: '4400', name: 'SaaS Revenue', description: 'Software as a Service revenue', type: 'REVENUE', subCategory: 'REVENUE_SAAS', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4401', name: 'SaaS - Subscriptions', description: 'SaaS subscription revenue', type: 'REVENUE', subCategory: 'REVENUE_SAAS', normalBalance: 'CREDIT', parentCode: '4400', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4402', name: 'SaaS - Usage Based', description: 'Usage-based SaaS revenue', type: 'REVENUE', subCategory: 'REVENUE_SAAS', normalBalance: 'CREDIT', parentCode: '4400', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // AI Services Revenue (Phase 2)
  { code: '4500', name: 'AI Services Revenue', description: 'AI and ML services revenue', type: 'REVENUE', subCategory: 'REVENUE_AI_SERVICES', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4501', name: 'AI - Model Training', description: 'AI model training services', type: 'REVENUE', subCategory: 'REVENUE_AI_SERVICES', normalBalance: 'CREDIT', parentCode: '4500', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4502', name: 'AI - Inference API', description: 'AI inference API revenue', type: 'REVENUE', subCategory: 'REVENUE_AI_SERVICES', normalBalance: 'CREDIT', parentCode: '4500', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // IoT Services Revenue (Phase 2)
  { code: '4600', name: 'IoT Services Revenue', description: 'Internet of Things services revenue', type: 'REVENUE', subCategory: 'REVENUE_IOT_SERVICES', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4601', name: 'IoT - Platform', description: 'IoT platform revenue', type: 'REVENUE', subCategory: 'REVENUE_IOT_SERVICES', normalBalance: 'CREDIT', parentCode: '4600', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4602', name: 'IoT - Device Management', description: 'IoT device management revenue', type: 'REVENUE', subCategory: 'REVENUE_IOT_SERVICES', normalBalance: 'CREDIT', parentCode: '4600', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Hardware Revenue (Phase 2)
  { code: '4700', name: 'Hardware Revenue', description: 'Hardware product sales', type: 'REVENUE', subCategory: 'REVENUE_HARDWARE', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4701', name: 'Hardware - Devices', description: 'Hardware device sales', type: 'REVENUE', subCategory: 'REVENUE_HARDWARE', normalBalance: 'CREDIT', parentCode: '4700', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4702', name: 'Hardware - Prototypes', description: 'Prototype hardware sales', type: 'REVENUE', subCategory: 'REVENUE_HARDWARE', normalBalance: 'CREDIT', parentCode: '4700', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Electronics Revenue (Phase 2)
  { code: '4800', name: 'Electronics Revenue', description: 'Electronics product sales', type: 'REVENUE', subCategory: 'REVENUE_ELECTRONICS', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4801', name: 'Electronics - Components', description: 'Electronic component sales', type: 'REVENUE', subCategory: 'REVENUE_ELECTRONICS', normalBalance: 'CREDIT', parentCode: '4800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4802', name: 'Electronics - Assemblies', description: 'Electronic assembly sales', type: 'REVENUE', subCategory: 'REVENUE_ELECTRONICS', normalBalance: 'CREDIT', parentCode: '4800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Component Sales Revenue (Phase 2)
  { code: '4900', name: 'Component Sales Revenue', description: 'Component and parts sales', type: 'REVENUE', subCategory: 'REVENUE_COMPONENT_SALES', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4901', name: 'Components - Electronic', description: 'Electronic component sales', type: 'REVENUE', subCategory: 'REVENUE_COMPONENT_SALES', normalBalance: 'CREDIT', parentCode: '4900', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4902', name: 'Components - Mechanical', description: 'Mechanical component sales', type: 'REVENUE', subCategory: 'REVENUE_COMPONENT_SALES', normalBalance: 'CREDIT', parentCode: '4900', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Subscription Revenue
  { code: '4950', name: 'Subscription Revenue', description: 'Recurring subscription revenue', type: 'REVENUE', subCategory: 'REVENUE_SUBSCRIPTION', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false },
  { code: '4951', name: 'Subscriptions - Monthly', description: 'Monthly subscription revenue', type: 'REVENUE', subCategory: 'REVENUE_SUBSCRIPTION', normalBalance: 'CREDIT', parentCode: '4950', isPostable: true, requiresDocument: true },
  { code: '4952', name: 'Subscriptions - Annual', description: 'Annual subscription revenue', type: 'REVENUE', subCategory: 'REVENUE_SUBSCRIPTION', normalBalance: 'CREDIT', parentCode: '4950', isPostable: true, requiresDocument: true },
  
  // Token Packages Revenue (Phase 2)
  { code: '4960', name: 'Token Packages Revenue', description: 'Token/credit package sales', type: 'REVENUE', subCategory: 'REVENUE_TOKEN_PACKAGES', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false, status: 'INACTIVE' },
  { code: '4961', name: 'Tokens - AI Compute', description: 'AI compute token packages', type: 'REVENUE', subCategory: 'REVENUE_TOKEN_PACKAGES', normalBalance: 'CREDIT', parentCode: '4960', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '4962', name: 'Tokens - API Calls', description: 'API call token packages', type: 'REVENUE', subCategory: 'REVENUE_TOKEN_PACKAGES', normalBalance: 'CREDIT', parentCode: '4960', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Other Revenue
  { code: '4990', name: 'Other Revenue', description: 'Miscellaneous revenue', type: 'REVENUE', subCategory: 'REVENUE_OTHER', normalBalance: 'CREDIT', parentCode: '4000', isPostable: false },
  { code: '4991', name: 'Interest Income', description: 'Interest earned on deposits', type: 'REVENUE', subCategory: 'REVENUE_OTHER', normalBalance: 'CREDIT', parentCode: '4990', isPostable: true },
  { code: '4992', name: 'Foreign Exchange Gain', description: 'Realized FX gains', type: 'REVENUE', subCategory: 'REVENUE_OTHER', normalBalance: 'CREDIT', parentCode: '4990', isPostable: true },
  { code: '4993', name: 'Other Income', description: 'Miscellaneous other income', type: 'REVENUE', subCategory: 'REVENUE_OTHER', normalBalance: 'CREDIT', parentCode: '4990', isPostable: true },
  
  // ============================================================
  // EXPENSES (normal balance: DEBIT)
  // ============================================================
  { code: '5000', name: 'Expenses', description: 'Total expenses', type: 'EXPENSE', normalBalance: 'DEBIT', isPostable: false },
  
  // Internet & Connectivity
  { code: '5100', name: 'Internet & Connectivity', description: 'Internet and connectivity costs', type: 'EXPENSE', subCategory: 'EXPENSE_INTERNET', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5101', name: 'Internet - Office', description: 'Office internet service', type: 'EXPENSE', subCategory: 'EXPENSE_INTERNET', normalBalance: 'DEBIT', parentCode: '5100', isPostable: true, requiresDocument: true },
  { code: '5102', name: 'Internet - Mobile Data', description: 'Mobile data plans', type: 'EXPENSE', subCategory: 'EXPENSE_INTERNET', normalBalance: 'DEBIT', parentCode: '5100', isPostable: true, requiresDocument: true },
  { code: '5103', name: 'Internet - Cloud Connectivity', description: 'Dedicated cloud connections', type: 'EXPENSE', subCategory: 'EXPENSE_INTERNET', normalBalance: 'DEBIT', parentCode: '5100', isPostable: true, requiresDocument: true },
  
  // Cloud Services
  { code: '5200', name: 'Cloud Services', description: 'Cloud infrastructure and services', type: 'EXPENSE', subCategory: 'EXPENSE_CLOUD', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5201', name: 'Cloud - Compute', description: 'Cloud compute instances', type: 'EXPENSE', subCategory: 'EXPENSE_CLOUD', normalBalance: 'DEBIT', parentCode: '5200', isPostable: true, requiresDocument: true },
  { code: '5202', name: 'Cloud - Storage', description: 'Cloud storage services', type: 'EXPENSE', subCategory: 'EXPENSE_CLOUD', normalBalance: 'DEBIT', parentCode: '5200', isPostable: true, requiresDocument: true },
  { code: '5203', name: 'Cloud - Managed Services', description: 'Managed database, Kubernetes, etc.', type: 'EXPENSE', subCategory: 'EXPENSE_CLOUD', normalBalance: 'DEBIT', parentCode: '5200', isPostable: true, requiresDocument: true },
  { code: '5204', name: 'Cloud - CDN & Edge', description: 'Content delivery and edge services', type: 'EXPENSE', subCategory: 'EXPENSE_CLOUD', normalBalance: 'DEBIT', parentCode: '5200', isPostable: true, requiresDocument: true },
  
  // AI API Costs
  { code: '5300', name: 'AI API Costs', description: 'Third-party AI API usage', type: 'EXPENSE', subCategory: 'EXPENSE_AI_API', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5301', name: 'AI - LLM API', description: 'Large language model API calls', type: 'EXPENSE', subCategory: 'EXPENSE_AI_API', normalBalance: 'DEBIT', parentCode: '5300', isPostable: true, requiresDocument: true },
  { code: '5302', name: 'AI - Embedding API', description: 'Embedding model API calls', type: 'EXPENSE', subCategory: 'EXPENSE_AI_API', normalBalance: 'DEBIT', parentCode: '5300', isPostable: true, requiresDocument: true },
  { code: '5303', name: 'AI - Vision API', description: 'Computer vision API calls', type: 'EXPENSE', subCategory: 'EXPENSE_AI_API', normalBalance: 'DEBIT', parentCode: '5300', isPostable: true, requiresDocument: true },
  
  // Transport
  { code: '5400', name: 'Transport', description: 'Travel and transport costs', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5401', name: 'Transport - Local', description: 'Local transport (taxi, bus, etc.)', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5400', isPostable: true, requiresDocument: true },
  { code: '5402', name: 'Transport - Domestic Flights', description: 'Domestic air travel', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5400', isPostable: true, requiresDocument: true },
  { code: '5403', name: 'Transport - International Flights', description: 'International air travel', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5400', isPostable: true, requiresDocument: true },
  { code: '5404', name: 'Transport - Fuel', description: 'Vehicle fuel', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5400', isPostable: true, requiresDocument: true },
  { code: '5405', name: 'Transport - Vehicle Maintenance', description: 'Vehicle repairs and maintenance', type: 'EXPENSE', subCategory: 'EXPENSE_TRANSPORT', normalBalance: 'DEBIT', parentCode: '5400', isPostable: true, requiresDocument: true },
  
  // Marketing
  { code: '5500', name: 'Marketing', description: 'Marketing and promotion costs', type: 'EXPENSE', subCategory: 'EXPENSE_MARKETING', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5501', name: 'Marketing - Digital Ads', description: 'Online advertising', type: 'EXPENSE', subCategory: 'EXPENSE_MARKETING', normalBalance: 'DEBIT', parentCode: '5500', isPostable: true, requiresDocument: true },
  { code: '5502', name: 'Marketing - Events', description: 'Events and conferences', type: 'EXPENSE', subCategory: 'EXPENSE_MARKETING', normalBalance: 'DEBIT', parentCode: '5500', isPostable: true, requiresDocument: true },
  { code: '5503', name: 'Marketing - Content', description: 'Content creation and design', type: 'EXPENSE', subCategory: 'EXPENSE_MARKETING', normalBalance: 'DEBIT', parentCode: '5500', isPostable: true, requiresDocument: true },
  { code: '5504', name: 'Marketing - SEO/SEM', description: 'Search engine optimization and marketing', type: 'EXPENSE', subCategory: 'EXPENSE_MARKETING', normalBalance: 'DEBIT', parentCode: '5500', isPostable: true, requiresDocument: true },
  
  // Software Expenses
  { code: '5600', name: 'Software Expenses', description: 'Software subscriptions and licenses', type: 'EXPENSE', subCategory: 'EXPENSE_SOFTWARE', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5601', name: 'Software - Productivity', description: 'Office and productivity software', type: 'EXPENSE', subCategory: 'EXPENSE_SOFTWARE', normalBalance: 'DEBIT', parentCode: '5600', isPostable: true, requiresDocument: true },
  { code: '5602', name: 'Software - Development Tools', description: 'IDEs, CI/CD, dev tools', type: 'EXPENSE', subCategory: 'EXPENSE_SOFTWARE', normalBalance: 'DEBIT', parentCode: '5600', isPostable: true, requiresDocument: true },
  { code: '5603', name: 'Software - Design', description: 'Design and creative software', type: 'EXPENSE', subCategory: 'EXPENSE_SOFTWARE', normalBalance: 'DEBIT', parentCode: '5600', isPostable: true, requiresDocument: true },
  { code: '5604', name: 'Software - Security', description: 'Security and monitoring tools', type: 'EXPENSE', subCategory: 'EXPENSE_SOFTWARE', normalBalance: 'DEBIT', parentCode: '5600', isPostable: true, requiresDocument: true },
  
  // Workspace
  { code: '5700', name: 'Workspace', description: 'Office and workspace costs', type: 'EXPENSE', subCategory: 'EXPENSE_WORKSPACE', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5701', name: 'Workspace - Rent', description: 'Office rent', type: 'EXPENSE', subCategory: 'EXPENSE_WORKSPACE', normalBalance: 'DEBIT', parentCode: '5700', isPostable: true, requiresDocument: true },
  { code: '5702', name: 'Workspace - Utilities', description: 'Electricity, water, internet', type: 'EXPENSE', subCategory: 'EXPENSE_WORKSPACE', normalBalance: 'DEBIT', parentCode: '5700', isPostable: true, requiresDocument: true },
  { code: '5703', name: 'Workspace - Maintenance', description: 'Office maintenance and cleaning', type: 'EXPENSE', subCategory: 'EXPENSE_WORKSPACE', normalBalance: 'DEBIT', parentCode: '5700', isPostable: true, requiresDocument: true },
  { code: '5704', name: 'Workspace - Supplies', description: 'Office supplies and consumables', type: 'EXPENSE', subCategory: 'EXPENSE_WORKSPACE', normalBalance: 'DEBIT', parentCode: '5700', isPostable: true },
  
  // Salaries (Phase 2)
  { code: '5800', name: 'Salaries & Benefits', description: 'Personnel costs', type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false, status: 'INACTIVE' },
  { code: '5801', name: 'Salaries - Basic', description: 'Basic salary payments', type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES', normalBalance: 'DEBIT', parentCode: '5800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5802', name: 'Salaries - Allowances', description: 'Housing, transport, other allowances', type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES', normalBalance: 'DEBIT', parentCode: '5800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5803', name: 'Salaries - Statutory Contributions', description: 'NSSF, NHIF, WCF contributions', type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES', normalBalance: 'DEBIT', parentCode: '5800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5804', name: 'Salaries - Bonuses', description: 'Performance bonuses', type: 'EXPENSE', subCategory: 'EXPENSE_SALARIES', normalBalance: 'DEBIT', parentCode: '5800', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Training Expenses
  { code: '5900', name: 'Training & Development', description: 'Staff training and development', type: 'EXPENSE', subCategory: 'EXPENSE_TRAINING', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5901', name: 'Training - External Courses', description: 'External training programs', type: 'EXPENSE', subCategory: 'EXPENSE_TRAINING', normalBalance: 'DEBIT', parentCode: '5900', isPostable: true, requiresDocument: true },
  { code: '5902', name: 'Training - Certifications', description: 'Professional certifications', type: 'EXPENSE', subCategory: 'EXPENSE_TRAINING', normalBalance: 'DEBIT', parentCode: '5900', isPostable: true, requiresDocument: true },
  { code: '5903', name: 'Training - Conferences', description: 'Conference attendance', type: 'EXPENSE', subCategory: 'EXPENSE_TRAINING', normalBalance: 'DEBIT', parentCode: '5900', isPostable: true, requiresDocument: true },
  
  // Hardware Prototyping (Phase 2)
  { code: '5950', name: 'Hardware Prototyping', description: 'R&D hardware prototyping costs', type: 'EXPENSE', subCategory: 'EXPENSE_HARDWARE_PROTOTYPING', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false, status: 'INACTIVE' },
  { code: '5951', name: 'Prototyping - Components', description: 'Electronic components for prototypes', type: 'EXPENSE', subCategory: 'EXPENSE_HARDWARE_PROTOTYPING', normalBalance: 'DEBIT', parentCode: '5950', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5952', name: 'Prototyping - PCBs', description: 'PCB fabrication and assembly', type: 'EXPENSE', subCategory: 'EXPENSE_HARDWARE_PROTOTYPING', normalBalance: 'DEBIT', parentCode: '5950', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5953', name: 'Prototyping - 3D Printing', description: '3D printing materials and services', type: 'EXPENSE', subCategory: 'EXPENSE_HARDWARE_PROTOTYPING', normalBalance: 'DEBIT', parentCode: '5950', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  { code: '5954', name: 'Prototyping - Testing', description: 'Testing and certification costs', type: 'EXPENSE', subCategory: 'EXPENSE_HARDWARE_PROTOTYPING', normalBalance: 'DEBIT', parentCode: '5950', isPostable: true, requiresDocument: true, status: 'INACTIVE' },
  
  // Other Expenses
  { code: '5990', name: 'Other Expenses', description: 'Miscellaneous expenses', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5000', isPostable: false },
  { code: '5991', name: 'Bank Charges', description: 'Bank fees and charges', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true, requiresDocument: true },
  { code: '5992', name: 'Foreign Exchange Loss', description: 'Realized FX losses', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true },
  { code: '5993', name: 'Professional Fees', description: 'Legal, audit, consulting fees', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true, requiresDocument: true },
  { code: '5994', name: 'Insurance', description: 'Insurance premiums', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true, requiresDocument: true },
  { code: '5995', name: 'Donations & CSR', description: 'Charitable donations and CSR', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true, requiresDocument: true },
  { code: '5999', name: 'Miscellaneous Expenses', description: 'Other uncategorized expenses', type: 'EXPENSE', subCategory: 'EXPENSE_OTHER', normalBalance: 'DEBIT', parentCode: '5990', isPostable: true },
  
  // Control Accounts (non-postable)
  { code: '9000', name: 'Control Accounts', description: 'System control accounts', type: 'ASSET', subCategory: 'CONTROL', normalBalance: 'DEBIT', isPostable: false },
  { code: '9001', name: 'Suspense Account', description: 'Temporary holding account', type: 'ASSET', subCategory: 'CONTROL', normalBalance: 'DEBIT', parentCode: '9000', isPostable: false },
  { code: '9002', name: 'Opening Balance Offset', description: 'Opening balance contra account', type: 'EQUITY', subCategory: 'CONTROL', normalBalance: 'CREDIT', parentCode: '9000', isPostable: false },
];

export interface ProductServiceSeed {
  code: string;
  name: string;
  description: string;
  type: 'PRODUCT' | 'SERVICE';
  unit: string;
  unitPrice?: string;
  currencyCode: string;
}

export const PRODUCTS_SERVICES: ProductServiceSeed[] = [
  { code: 'CONSULT-DAY', name: 'Consultancy Services (Daily)', description: 'Daily rate for consultancy services', type: 'SERVICE', unit: 'DAY', unitPrice: '500.00', currencyCode: 'USD' },
  { code: 'CONSULT-HOUR', name: 'Consultancy Services (Hourly)', description: 'Hourly rate for consultancy services', type: 'SERVICE', unit: 'HOUR', unitPrice: '75.00', currencyCode: 'USD' },
  { code: 'TRAINING-DAY', name: 'Training Delivery (Daily)', description: 'Daily rate for training delivery', type: 'SERVICE', unit: 'DAY', unitPrice: '800.00', currencyCode: 'USD' },
  { code: 'RESEARCH-HOUR', name: 'Research Services (Hourly)', description: 'Hourly rate for research services', type: 'SERVICE', unit: 'HOUR', unitPrice: '100.00', currencyCode: 'USD' },
  { code: 'REPORT', name: 'Report Preparation', description: 'Fixed fee for report preparation and delivery', type: 'PRODUCT', unit: 'UNIT', unitPrice: '2000.00', currencyCode: 'USD' },
  { code: 'SOFTWARE-LIC', name: 'Software License', description: 'Annual software license fee', type: 'PRODUCT', unit: 'YEAR', unitPrice: '5000.00', currencyCode: 'USD' },
  { code: 'PUBLICATION', name: 'Research Publication', description: 'Publication and dissemination services', type: 'PRODUCT', unit: 'UNIT', unitPrice: '1500.00', currencyCode: 'USD' },
];
