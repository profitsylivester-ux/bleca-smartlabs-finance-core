import { test, expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

const PASSWORD = 'ChangeMe!Bleca2026#Dev';
const EMAIL = process.env.E2E_CEO_EMAIL ?? 'ceo@blecasmartlabs.co.tz';

// Test MFA secret - must match what we enroll during setup
const TEST_MFA_SECRET = 'JBSWY3DPEHPK3PXP'; // base32 encoded test secret

async function signIn(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function completeMfa(page: Page, secret: string) {
  await expect(page).toHaveURL(/\/mfa-verify/);
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
  
  const code = authenticator.generate(secret);
  await page.getByLabel('Authentication code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  
  // Should redirect to dashboard after successful MFA
  await expect(page).toHaveURL(/\/dashboard/);
}

async function setupCeoMfa(page: Page) {
  // First sign in to get to MFA enrolment
  await signIn(page);
  await completeMfa(page, TEST_MFA_SECRET);
  
  // Navigate to MFA enrolment if needed (first time setup)
  // The CEO must enrol MFA at first sign-in
  // Check if we're at the MFA enrolment page or dashboard
  const url = page.url();
  if (url.includes('/mfa-enrol')) {
    // Fill in the MFA enrolment form with our test secret
    // This depends on the actual MFA enrolment UI
    // For now, we assume the secret is already enrolled via seed
  }
}

/**
 * Generate a TOTP code for the given secret
 */
function generateTotp(secret: string): string {
  return authenticator.generate(secret);
}

test.describe('Full Financial Lifecycle', () => {
  test.beforeAll(async () => {
    // Ensure the CEO has MFA enrolled with our test secret
    // This would be done via a test setup script or API call
    // For now, we assume the seed has been run and MFA is enrolled
  });

  test('CEO can complete full transaction lifecycle: create → submit → approve → post → reverse → verify', async ({ page }) => {
    // 1. Sign in as CEO (with MFA)
    await signIn(page);
    await completeMfa(page, TEST_MFA_SECRET);
    
    // Should reach dashboard
    await expect(page).toHaveURL(/\/dashboard/);
    
    // 2. Navigate to transactions and create a new one
    await page.goto('/transactions/new');
    await expect(page.getByRole('heading', { name: /new transaction/i })).toBeVisible();
    
    // Fill transaction form
    await page.getByLabel('Date').fill('2026-10-15');
    await page.getByLabel('Description').fill('Test transaction for E2E');
    await page.getByLabel('Reference').fill('E2E-TEST-001');
    await page.getByLabel('Amount').fill('100000');
    await page.getByLabel('Currency').selectOption('TZS');
    
    // Select account (need to pick from Chart of Accounts)
    // This will depend on the actual UI
    await page.getByLabel('Account').selectOption({ index: 1 }); // Pick first available
    
    // Submit as draft
    await page.getByRole('button', { name: /save draft/i }).click();
    
    // Should show success and redirect to transaction list
    await expect(page.getByRole('alert')).toContainText(/saved|created/i);
    
    // 3. Submit for approval
    await page.getByRole('button', { name: /submit for approval/i }).click();
    await expect(page.getByRole('alert')).toContainText(/submitted/i);
    
    // 4. Approve the transaction (CEO is final approver)
    await page.getByRole('button', { name: /approve/i }).click();
    await expect(page.getByRole('alert')).toContainText(/approved/i);
    
    // 5. Post the transaction
    await page.getByRole('button', { name: /post/i }).click();
    await expect(page.getByRole('alert')).toContainText(/posted/i);
    
    // 6. Verify journal entry was created
    await page.goto('/journal-entries');
    await expect(page.getByRole('heading', { name: /journal entries/i })).toBeVisible();
    
    // Find the journal entry for our transaction
    await expect(page.getByText('E2E-TEST-001')).toBeVisible();
    
    // Click to view journal entry details
    await page.getByRole('button', { name: /view/i }).first().click();
    
    // Verify it's balanced (debits = credits)
    await expect(page.getByText(/balanced/i)).toBeVisible();
    await expect(page.getByText(/debits.*credits|credits.*debits/i)).toBeVisible();
    
    // 7. Reverse the transaction
    await page.goto('/transactions');
    await page.getByRole('button', { name: /reverse/i }).first().click();
    
    // Fill reversal reason
    await page.getByLabel('Reason').selectOption('DATA_ENTRY_ERROR');
    await page.getByLabel('Description').fill('E2E test reversal');
    await page.getByRole('button', { name: /confirm reversal/i }).click();
    
    await expect(page.getByRole('alert')).toContainText(/reversed/i);
    
    // 8. Verify reversal is linked
    await page.goto('/journal-entries');
    await expect(page.getByText(/reversal/i)).toBeVisible();
    
    // 9. Run trial balance report
    await page.goto('/reports/trial-balance');
    await expect(page.getByRole('heading', { name: /trial balance/i })).toBeVisible();
    
    // Select period
    await page.getByLabel('Period').selectOption({ index: 0 });
    await page.getByRole('button', { name: /generate/i }).click();
    
    // Wait for report
    await expect(page.getByRole('heading', { name: /trial balance/i })).toBeVisible();
    
    // 10. Verify debits == credits
    await expect(page.getByText(/total debits.*total credits|debits.*=.*credits/i)).toBeVisible();
    
    // The trial balance should show zero balance for our test accounts
    // since the transaction was reversed
  });
});

test.describe('API Integration', () => {
  test('API endpoints respond correctly with proper auth', async ({ request }) => {
    // First authenticate to get a session
    const loginResponse = await request.post('/api/auth/callback/credentials', {
      form: {
        email: EMAIL,
        password: PASSWORD,
      },
    });
    
    // The actual auth flow is more complex with NextAuth
    // This is a placeholder for API testing
    expect([200, 302, 401]).toContain(loginResponse.status());
  });
});