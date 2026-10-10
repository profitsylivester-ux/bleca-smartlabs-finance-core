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
