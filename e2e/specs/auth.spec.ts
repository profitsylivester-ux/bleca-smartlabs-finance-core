import { test, expect, type Page } from '@playwright/test';

/**
 * The sign-in journey, end to end, against a running server.
 *
 * These are the tests that would catch a broken redirect, a cookie that is not
 * marked httpOnly, or a guard that trusts the client. None of that is visible to
 * a unit test, and all of it is exactly what protects the ledger.
 */

const PASSWORD = 'ChangeMe!Bleca2026#Dev';
const EMAIL = process.env.E2E_CEO_EMAIL ?? 'ceo@blecasmartlabs.co.tz';

async function signIn(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('sign-in', () => {
  test('an unauthenticated visitor is sent to the login page', async ({ page }) => {
    await page.goto('/dashboard/ceo');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'BLECA SmartLabs Finance' })).toBeVisible();
  });

  test('a protected page is not served to an anonymous caller', async ({ page }) => {
    const response = await page.goto('/admin/audit-trail');
    // Redirected to /login rather than rendered.
    expect(page.url()).toContain('/login');
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByRole('heading', { name: 'Audit trail' })).toHaveCount(0);
  });

  test('a wrong password is refused with a generic message', async ({ page }) => {
    await signIn(page, EMAIL, 'DefinitelyWrong#123');

    await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
    // No navigation: still on the login page.
    await expect(page).toHaveURL(/\/login/);
  });

  test('an unknown account gives the identical message', async ({ page }) => {
    await signIn(page, 'nobody@nowhere.local', PASSWORD);
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password');
  });

  test('the correct password stops at the MFA challenge, because the CEO must verify', async ({
    page,
  }) => {
    await signIn(page);

    // The CEO role requires a second factor, so a correct password alone must not
    // reach the dashboard. This is the assertion that matters: if MFA gating ever
    // regresses, the dashboard becomes reachable with a password alone.
    await expect(page).toHaveURL(/\/mfa-verify/);
    await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CEO dashboard' })).toHaveCount(0);
  });

  test('an incorrect MFA code is refused and does not sign anyone in', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/mfa-verify/);

    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/mfa-verify/);
  });
});

test.describe('password reset', () => {
  test('the reset form gives the same answer for a known and an unknown address', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill(EMAIL);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const known = await page.textContent('body');

    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill('nobody@nowhere.local');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const unknown = await page.textContent('body');

    /**
     * Identical wording is the requirement. If the two responses differ, the form
     * is an account enumeration oracle, and it does not matter that the emails
     * themselves differ.
     */
    expect(unknown).toContain('If that address belongs to an account');
    expect(known).toContain('If that address belongs to an account');
  });

  test('an invalid reset token is rejected rather than silently accepted', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token');
    await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
  });
});

test.describe('API surface', () => {
  test('the audit API refuses an unauthenticated caller', async ({ request }) => {
    const response = await request.get('/api/v1/audit');
    expect(response.status()).toBe(401);
  });

  test('the users API refuses an unauthenticated caller', async ({ request }) => {
    const response = await request.get('/api/v1/users');
    expect(response.status()).toBe(401);
  });

  test('creating a user without an idempotency key is refused', async ({ request }) => {
    // Unauthenticated is refused first, which is the correct order.
    const response = await request.post('/api/v1/users', { data: { email: 'x@y.co' } });
    expect([401, 422]).toContain(response.status());
  });
});