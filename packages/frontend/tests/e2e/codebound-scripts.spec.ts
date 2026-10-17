// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';

// Browser workflow tests mock HTTP. Real JWT/DB authorization is tested by backend AppModule smoke.
const user = { id: 'u', organizationId: 'o', email: 'test@example.invalid', name: 'Test', role: 'ADMIN', emailVerified: true };
async function setup(page: Page, mode: 'normal' | 'conflict' | 'denied' = 'normal') {
  let saved: Record<string, unknown> | null = null;
  await page.context().addCookies([{ name: 'amcp_token', value: 'test-token', url: 'http://localhost:3100' }]);
  await page.addInitScript(user => {
    localStorage.setItem('amcp_token', 'test-token'); localStorage.setItem('amcp_user', JSON.stringify(user));
  }, user);
  await page.route(/\/(api|health)\//, async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/health/server-info') return json({ deploymentMode: 'self-hosted', hasUsers: true, mcpAuthMode: 'none' });
    if (path.endsWith('/users/me/onboarding-state')) return json({ onboardingCompletedAt: '2026-01-01' });
    if (path.endsWith('/users/me')) return json(user);
    if (path.endsWith('/organizations/current')) return json({ id: 'o', name: 'Test organization' });
    if (path.endsWith('/organizations/mine')) return json([{ id: 'o', name: 'Test organization', role: 'ADMIN' }]);
    if (path.endsWith('/license/status')) return json({ plan: 'community', status: 'active' });
    if (!path.startsWith('/api/codebound/')) return json({});
    expect(req.headers().authorization).toBe('Bearer test-token');
    if (mode === 'denied') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Denied' } }, 403);
    if (path.endsWith('/bindings')) return json({ ok: true, value: { items: [{ connectorName: 'Owned connector', toolName: 'Read items',
      binding: { connectorId: 'c', toolId: 't', definitionSha256: 'a'.repeat(64) } }], nextCursor: null } });
    if (path.endsWith('/scripts/execute')) {
      expect(req.postDataJSON()).toEqual({ scriptId: 's', expectedRevision: saved?.revision, input: {} });
      return json({ ok: true, value: { executionId: 'execution-1', status: 'succeeded', output: { count: 2, text: '<script>window.pwned=true</script>' } } });
    }
    if (path.endsWith('/scripts') && req.method() === 'GET') return json({ ok: true, value: saved ? [saved] : [] });
    if (req.method() === 'POST') {
      expect(Object.keys(req.postDataJSON())).toEqual(['definition']);
      saved = { ...req.postDataJSON().definition, id: 's', revision: 1, organizationId: 'o', ownerUserId: 'u', sourceSha256: 'b'.repeat(64) };
      return json({ ok: true, value: saved }, 201);
    }
    if (req.method() === 'PUT') {
      expect(req.postDataJSON().expectedRevision).toBe(1);
      if (mode === 'conflict') return json({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Changed' } }, 409);
      saved = { ...saved, ...req.postDataJSON().definition, revision: 2 }; return json({ ok: true, value: saved });
    }
    if (req.method() === 'DELETE') {
      expect(req.postDataJSON().expectedRevision).toBe(2); saved = null; return json({ ok: true, value: null });
    }
    return json({ ok: true, value: saved });
  });
  await page.goto('/scripts');
  await expect(page.getByRole('heading', { name: 'Create script' })).toBeVisible();
}
async function create(page: Page) {
  await page.getByLabel('Name', { exact: true }).fill('Compact summary');
  await page.getByLabel('Connector / GET tool').selectOption('t');
  await page.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit script · revision 1' })).toBeVisible();
}
test('creates, edits, runs and deletes a saved script; output stays text', async ({ page }) => {
  await setup(page);
  await expect(page.getByRole('link', { name: 'CODEBOUND Scripts' })).toHaveAttribute('href', '/scripts');
  await expect(page.getByText('No saved scripts yet.')).toBeVisible();
  await create(page);
  await page.getByLabel('JavaScript', { exact: true }).fill('async function main(input, api) { const data = await api.read(input); return { count: data.length }; }');
  await expect(page.getByRole('button', { name: 'Run saved script' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit script · revision 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Run saved script' }).click();
  await expect(page.getByText('Execution succeeded · execution-1')).toBeVisible();
  await expect(page.locator('pre')).toContainText('"count": 2');
  expect(await page.evaluate(() => 'pwned' in window)).toBe(false);
  await page.getByRole('button', { name: 'Delete script', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByText('No saved scripts yet.')).toBeVisible();
});
test('preserves edits on conflict and supports reload', async ({ page }) => {
  await setup(page, 'conflict'); await create(page);
  await page.getByLabel('Name', { exact: true }).fill('Unsaved edit');
  await page.getByRole('button', { name: 'Save script', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Script error' })).toContainText('Revision conflict');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved edit');
  await page.getByRole('button', { name: 'Reload script' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Compact summary');
});
test('shows permission failure without exposing backend details', async ({ page }) => {
  await setup(page, 'denied');
  await expect(page.getByRole('alert', { name: 'Script error' })).toContainText('Permission denied');
});
test('signed-out users follow existing login protection', async ({ page }) => {
  await page.goto('/scripts'); await expect(page).toHaveURL(/\/login/);
});
