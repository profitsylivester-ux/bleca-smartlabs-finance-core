/**
 * i18n scaffold.
 *
 * Phase 1 is English only (BUILD_PROMPT.md section 2), but the requirements PDF
 * lists Swahili as a secondary language, so the structure exists now and a
 * translation file is a data change rather than a refactor.
 *
 * Every user-visible string in the shell resolves through here. If a component
 * hard-codes English prose, that is a bug: it is the thing that makes a
 * translation impossible later.
 */

export const DEFAULT_LOCALE = 'en';

export type Locale = 'en' | 'sw';

export const LOCALES: Array<{
  code: Locale;
  label: string;
  nativeLabel: string;
  enabled: boolean;
}> = [
  { code: 'en', label: 'English', nativeLabel: 'English', enabled: true },
  // Present but disabled, so the choice is recorded rather than forgotten.
  { code: 'sw', label: 'Swahili', nativeLabel: 'Kiswahili', enabled: false },
];

type Dictionary = Record<string, string>;

const en: Dictionary = {
  'app.name': 'BLECA SmartLabs Finance',
  'app.tagline': 'Finance management and accounting',

  'nav.dashboard': 'Dashboard',
  'nav.accounting': 'Accounting',
  'nav.treasury': 'Treasury',
  'nav.sales': 'Sales & Purchases',
  'nav.documents': 'Documents',
  'nav.system': 'System',
  'nav.admin': 'Administration',

  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.confirmPassword': 'Confirm password',
  'auth.rememberDevice': '',
  'auth.forgotPassword': 'Forgot your password?',
  'auth.noAccount': 'Accounts are created by an administrator. There is no self sign-up.',
  'auth.mfaTitle': 'Two-factor verification',
  'auth.mfaDescription': 'Enter the 6-digit code from your authenticator app.',
  'auth.mfaRecovery': 'Use a recovery code instead',
  'auth.verify': 'Verify',
  'auth.back': 'Back',
  'auth.resetTitle': 'Reset your password',
  'auth.resetDescription': 'Choose a new password. Signing in on other devices will end.',
  'auth.resetRequested': 'If that address belongs to an account, a reset link has been sent.',
  'auth.changePasswordTitle': 'Change your password',
  'auth.changePasswordDescription': 'Choose a new password before continuing.',
  'auth.currentPassword': 'Current password',
  'auth.newPassword': 'New password',

  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.search': 'Search',
  'common.filter': 'Filter',
  'common.export': 'Export',
  'common.loading': 'Loading',
  'common.none': 'None',
  'common.all': 'All',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.actions': 'Actions',
  'common.status': 'Status',
  'common.createdAt': 'Created',
  'common.updatedAt': 'Updated',
  'common.noResults': 'Nothing to show yet.',
  'common.required': 'Required',
  'common.optional': 'Optional',
  'common.copy': 'Copy',
  'common.copied': 'Copied',

  'module.planned': 'Not yet available',
  'module.plannedBody':
    '{module} is scheduled for {milestone}. The permission already exists so that role design is complete; there is simply nothing to open yet.',

  'audit.title': 'Audit trail',
  'audit.subtitle': 'Append-only and hash-chained. Entries cannot be edited or deleted.',
  'audit.verifyChain': 'Verify chain',
  'audit.chainVerified': 'Chain verified across {count} entries.',
  'audit.chainBroken': 'Chain verification FAILED at sequence {sequence}.',
  'audit.sequence': 'Seq',
  'audit.actor': 'Actor',
  'audit.action': 'Action',
  'audit.entity': 'Record',
  'audit.result': 'Result',
  'audit.channel': 'Channel',
  'audit.when': 'When',
  'audit.origin': 'Origin',

  'security.title': 'Security policy',
  'security.subtitle':
    'These thresholds are configuration, not code. Changing one is recorded in the audit trail.',
  'security.lockout': 'Account lockout',
  'security.sessions': 'Sessions',
  'security.password': 'Password policy',
  'security.mfa': 'Multi-factor authentication',

  'users.title': 'Users and roles',
  'users.subtitle': 'Accounts, role grants and access history.',
  'users.name': 'Name',
  'users.email': 'Email',
  'users.role': 'Role',
  'users.lastSignIn': 'Last sign-in',
  'users.mfa': 'MFA',

  'notFound.title': 'Page not found',
  'notFound.body': 'That page does not exist, or it is not available in Phase 1.',
};

const dictionaries: Partial<Record<Locale, Dictionary>> = { en };

export function t(key: string, vars: Record<string, string | number> = {}): string {
  const dictionary = dictionaries[DEFAULT_LOCALE];
  const template = dictionary?.[key];
  if (template === undefined) {
    // A missing key is a bug, not a cosmetic issue: returning the key makes it
    // visible in review rather than shipping a blank space.
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/** Shape check for the dictionary: keys used but not defined fail typecheck. */
export type DictionaryKey = keyof typeof en;
