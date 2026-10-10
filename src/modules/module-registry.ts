import type { ModuleKey, PermissionAction } from '@/generated/prisma/client';

/**
 * Module registry (PHASE_1_PLAN.md 2.2).
 *
 * One source of truth for navigation, RBAC gating and the "this is not built
 * yet" screen. A route segment does not get to decide on its own whether it
 * exists: if it is not registered here, the shell does not render a link to it
 * and the guard reports it honestly.
 *
 * The M1 modules are the ones that exist today. Phase 2 modules are listed as
 * declared-but-unavailable rather than omitted, because their permission grants
 * are already seeded and a role that can be granted a permission it can never
 * use is a data problem waiting to confuse someone.
 */

export type ModuleAvailability = 'AVAILABLE' | 'PLANNED';

export interface ModuleDefinition {
  key: ModuleKey;
  /** URL segment under the authenticated shell, null for groups. */
  path: string | null;
  label: string;
  description: string;
  availability: ModuleAvailability;
  /** Milestone that delivers it. Null means it exists now. */
  milestone: string | null;
  icon: string;
  group: 'dashboard' | 'accounting' | 'treasury' | 'sales' | 'documents' | 'admin' | 'system';
  /** Permissions required to see the entry at all. */
  requires: PermissionAction[];
  order: number;
}

const PHASE_1 = 'M1';

export const MODULES: ModuleDefinition[] = [
  {
    key: 'DASHBOARD_CEO',
    path: '/dashboard/ceo',
    label: 'CEO Dashboard',
    description: 'Cash, revenue, pending approvals and risk at a glance.',
    availability: 'AVAILABLE',
    milestone: PHASE_1,
    icon: 'gauge',
    group: 'dashboard',
    requires: ['VIEW'],
    order: 10,
  },
  {
    key: 'DASHBOARD_FINANCE',
    path: '/dashboard/finance',
    label: 'Finance Dashboard',
    description: 'Transactions awaiting action, reconciliation and budget alerts.',
    availability: 'AVAILABLE',
    milestone: PHASE_1,
    icon: 'gauge',
    group: 'dashboard',
    requires: ['VIEW'],
    order: 20,
  },
{
    key: 'MASTER_DATA',
    path: '/master-data',
    label: 'Master Data',
    description: 'Locations, departments, cost centres, projects, funding sources, currencies, rates and reason codes.',
    availability: 'AVAILABLE',
    milestone: PHASE_1,
    icon: 'list-tree',
    group: 'accounting',
    requires: ['VIEW'],
    order: 90,
  },
  {
    key: 'CHART_OF_ACCOUNTS',
    path: null,
    label: 'Chart of Accounts',
    description: 'Configurable account structure with dormant Phase 2 accounts reserved.',
    availability: 'PLANNED',
    milestone: 'M3',
    icon: 'list-tree',
    group: 'accounting',
    requires: ['VIEW'],
    order: 100,
  },
  {
    key: 'JOURNAL_ENTRIES',
    path: '/accounting/journal-entries',
    label: 'Journal Entries',
    description: 'Double-entry postings and their reversals.',
    availability: 'AVAILABLE',
    milestone: 'M4',
    icon: 'book-open',
    group: 'accounting',
    requires: ['VIEW'],
    order: 110,
  },
  {
    key: 'GENERAL_LEDGER',
    path: '/accounting/general-ledger',
    label: 'General Ledger',
    description: 'Running balance and dimension breakdown for every account.',
    availability: 'AVAILABLE',
    milestone: 'M4',
    icon: 'list-tree',
    group: 'accounting',
    requires: ['VIEW'],
    order: 115,
  },
  {
    key: 'TRIAL_BALANCE',
    path: '/accounting/trial-balance',
    label: 'Trial Balance',
    description: 'Debits equal credits across all accounts at a point in time.',
    availability: 'AVAILABLE',
    milestone: 'M4',
    icon: 'scale',
    group: 'accounting',
    requires: ['VIEW'],
    order: 118,
  },
  {
    key: 'TRANSACTIONS',
    path: null,
    label: 'Transactions',
    description: 'Full lifecycle from draft through posting, adjustment and reversal.',
    availability: 'PLANNED',
    milestone: 'M5',
    icon: 'arrow-left-right',
    group: 'accounting',
    requires: ['VIEW'],
    order: 120,
  },
  {
    key: 'APPROVALS',
    path: null,
    label: 'Approvals',
    description: 'Configurable approval engine with CEO final authority.',
    availability: 'PLANNED',
    milestone: 'M6',
    icon: 'check-square',
    group: 'accounting',
    requires: ['VIEW'],
    order: 130,
  },
  {
    key: 'TREASURY_TRANSFERS',
    path: null,
    label: 'Cash, Bank & Mobile Money',
    description: 'Treasury accounts, transfers and cash position.',
    availability: 'PLANNED',
    milestone: 'M7',
    icon: 'wallet',
    group: 'treasury',
    requires: ['VIEW'],
    order: 200,
  },
  {
    key: 'RECONCILIATION',
    path: null,
    label: 'Reconciliation',
    description: 'Bank, cash and mobile money matching with an exception queue.',
    availability: 'PLANNED',
    milestone: 'M8',
    icon: 'scale',
    group: 'treasury',
    requires: ['VIEW'],
    order: 210,
  },
  {
    key: 'BUDGETS',
    path: null,
    label: 'Budgets & Commitments',
    description: 'Approved less commitments less actual, with over-budget approval.',
    availability: 'PLANNED',
    milestone: 'M9',
    icon: 'target',
    group: 'accounting',
    requires: ['VIEW'],
    order: 140,
  },
  {
    key: 'SUPPLIERS',
    path: null,
    label: 'Suppliers',
    description: 'Supplier register with controlled bank-detail changes.',
    availability: 'PLANNED',
    milestone: 'M10',
    icon: 'truck',
    group: 'sales',
    requires: ['VIEW'],
    order: 300,
  },
  {
    key: 'INVOICES',
    path: null,
    label: 'Invoices & Receipts',
    description: 'Sequential numbering with gap detection.',
    availability: 'PLANNED',
    milestone: 'M11',
    icon: 'receipt',
    group: 'sales',
    requires: ['VIEW'],
    order: 310,
  },
  {
    key: 'DOCUMENTS',
    path: null,
    label: 'Documents',
    description: 'Private storage, version history, retention and legal holds.',
    availability: 'PLANNED',
    milestone: 'M12',
    icon: 'folder',
    group: 'documents',
    requires: ['VIEW'],
    order: 400,
  },
  {
    key: 'TAX_COMPLIANCE',
    path: null,
    label: 'Tax & Compliance',
    description: 'Configurable rules with accountant sign-off. No hardcoded values.',
    availability: 'PLANNED',
    milestone: 'M13',
    icon: 'landmark',
    group: 'system',
    requires: ['VIEW'],
    order: 500,
  },
  {
    key: 'REPORTS',
    path: '/reports/financial',
    label: 'Financial Reports',
    description: 'Income statement, balance sheet, cash flow and comparative views.',
    availability: 'AVAILABLE',
    milestone: 'M4',
    icon: 'file-chart',
    group: 'accounting',
    requires: ['VIEW'],
    order: 125,
  },
  {
    key: 'NOTIFICATIONS',
    path: null,
    label: 'Notifications',
    description: 'In-app and email delivery with per-category preferences.',
    availability: 'PLANNED',
    milestone: 'M16',
    icon: 'bell',
    group: 'system',
    requires: ['VIEW'],
    order: 520,
  },
  {
    key: 'USERS_ROLES',
    path: '/admin/users',
    label: 'Users & Roles',
    description: 'Accounts, role grants, temporary access and access reviews.',
    availability: 'AVAILABLE',
    milestone: PHASE_1,
    icon: 'users',
    group: 'admin',
    requires: ['VIEW'],
    order: 600,
  },
  {
    key: 'AUDIT_TRAIL',
    path: '/admin/audit-trail',
    label: 'Audit Trail',
    description: 'Append-only, hash-chained record of every sensitive action.',
    availability: 'AVAILABLE',
    milestone: PHASE_1,
    icon: 'scroll-text',
    group: 'admin',
    requires: ['VIEW'],
    order: 610,
  },
];

export const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function availableModules(): ModuleDefinition[] {
  return MODULES.filter((m) => m.availability === 'AVAILABLE');
}

export function moduleByPath(path: string): ModuleDefinition | undefined {
  return MODULES.find((m) => m.path !== null && (path === m.path || path.startsWith(`${m.path}/`)));
}

export interface ModuleGateInput {
  module: ModuleKey;
  action: PermissionAction;
}

/**
 * Reports a module honestly rather than half-building it.
 *
 * The failure this prevents: a seeded permission for a Phase 2 module producing
 * a navigation link to a 404, which reads as a bug rather than as scope.
 */
export function gate(input: {
  module: ModuleKey;
  granted: boolean;
}): 'AVAILABLE' | 'FORBIDDEN' | 'NOT_YET_AVAILABLE' {
  const definition = MODULE_BY_KEY.get(input.module);
  if (!definition) return 'NOT_YET_AVAILABLE';
  if (definition.availability !== 'AVAILABLE') return 'NOT_YET_AVAILABLE';
  return input.granted ? 'AVAILABLE' : 'FORBIDDEN';
}

export const GROUPS = [
  { key: 'dashboard', label: 'Overview' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'treasury', label: 'Treasury' },
  { key: 'sales', label: 'Sales & Purchases' },
  { key: 'documents', label: 'Documents' },
  { key: 'system', label: 'System' },
  { key: 'admin', label: 'Administration' },
] as const;
