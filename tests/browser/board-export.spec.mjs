import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureDatabase } from './fixture-db.mjs';

const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000081', name: 'Export owner', email: 'export-owner@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  return { context, page: await context.newPage() };
}

async function openBoard(page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  const canvas = page.getByRole('application', { name: 'Board canvas' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  return canvas;
}

const isSave = (response) => /\/api\/canvas-boards\/[^/]+$/.test(new URL(response.url()).pathname) && ['PUT', 'PATCH'].includes(response.request().method());

test('Board export: SVG, JPG and text CSV come from the board data', async ({ browser, baseURL }, info) => {
  test.setTimeout(300000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${OWNER.id}, ${OWNER.email}, 'unused', 'unused', 1, ${OWNER.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`]);
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Board export ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const { context, page } = await signIn(browser, baseURL, OWNER, project.id);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openBoard(page);

  await page.getByRole('button', { name: 'Sticky options' }).click();
  await page.getByRole('menuitem', { name: 'Bulk mode' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add stickies in bulk' });
  await dialog.getByRole('textbox').fill('Alpha <b>\n=Beta\nGamma');
  const firstSave = page.waitForResponse(isSave);
  await dialog.getByRole('button', { name: 'Add 3 stickies' }).click();
  await firstSave;

  await page.keyboard.press('Escape');
  await canvas.click({ position: { x: 1000, y: 120 } });
  const exportButton = page.getByRole('button', { name: 'Export', exact: true });
  await exportButton.click();
  const menu = page.getByRole('menu').filter({ hasText: 'Save as SVG' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Download original file' })).toBeDisabled();
  await info.attach('export-menu', { body: await page.screenshot(), contentType: 'image/png' });

  const svgDownload = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Save as SVG' }).click();
  const svg = await readFile(await (await svgDownload).path(), 'utf8');
  expect(svg).toMatch(/^<\?xml|^<svg/);
  expect(svg).toContain('Alpha &lt;b&gt;');
  expect(svg).not.toContain('<b>');

  await exportButton.click();
  const jpgDownload = page.waitForEvent('download');
  await page.getByRole('menu').filter({ hasText: 'Save as SVG' }).getByRole('menuitem', { name: /Save as JPG \(Small\)/ }).click();
  const jpg = await (await jpgDownload);
  expect(jpg.suggestedFilename()).toMatch(/\.jpe?g$/);
  const bytes = await readFile(await jpg.path());
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);

  await exportButton.click();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('menu').filter({ hasText: 'Save as SVG' }).getByRole('menuitem', { name: 'Export text as CSV' }).click();
  const csv = await readFile(await (await csvDownload).path(), 'utf8');
  expect(csv).toContain('Alpha <b>');
  expect(csv).toContain("'=Beta");
  expect(errors).toEqual([]);
  await context.close();
});
