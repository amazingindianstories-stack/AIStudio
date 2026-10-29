import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixtureDatabase } from './fixture-db.mjs';

// Number labels stay readable while the complete permanent name remains accessible.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

for (const zoom of [120, 260]) {
test(`overlay names preserve suffixes and accessibility at thumbnail size ${zoom}`, async ({ page, context, baseURL }, testInfo) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const tag = `Names${randomUUID().slice(0, 8)}`;
  const projectResponse = await context.request.post('/api/projects', { headers: { Origin: baseURL }, data: { op: 'createProject', name: tag } });
  expect(projectResponse.ok()).toBeTruthy();
  const { project } = await projectResponse.json();
  const id = randomUUID();
  const stem = `${tag}_${'Very_Long_Folder_Ancestry_'.repeat(6)}Shot`;
  const now = Date.now();
  await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, permanent_name, created_at, updated_at)
    SELECT ${id}, 'image', 'succeeded', 'Nano Banana Pro', ${`${tag} prompt`}, '1:1', url,
      ${USER_ID}, ${project.id}, ${`${stem}_0007`}, ${now}, ${now}
      FROM generations WHERE id='10000000-0000-4000-8000-000000000000'`;
  await page.addInitScript(({ projectId, zoom }) => {
    localStorage.setItem('veevee-asset-zoom-v1', String(zoom));
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, { projectId: project.id, zoom });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const panel = page.locator('#desktop-history-panel');
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await panel.getByRole('button', { name: /Unsorted$/ }).first().click();
    await panel.getByRole('button', { name: 'View settings', exact: true }).click();
    const slider = page.getByRole('slider');
    await slider.press(zoom === 120 ? 'Home' : 'End');
    await expect(slider).toHaveValue(String(zoom));
    await page.keyboard.press('Escape');
    const library = panel.locator(`[data-asset-card-id="${id}"]`);
    const chat = page.locator(`[data-generation-id="${id}"]`);
    for (const card of [library, chat]) {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      const name = card.locator('[data-generation-name]');
      await page.mouse.move(1, 1);
      const original = await name.boundingBox();
      await card.hover();
      await expect(name).toHaveAttribute('title', new RegExp(`^${stem}_0007\\.\\w+$`));
      const sequence = name.locator('span').last();
      await expect(name.locator('.sr-only')).toHaveText(`${stem}_0007.png`);
      await expect(sequence).toHaveText(card === library ? '0007' : '_0007');
      await expect(name.locator('[aria-hidden="true"]')).toHaveCount(card === library ? 1 : 2);
      if (card === library) {
        const box = await card.boundingBox();
        if (zoom === 120) expect(box.width).toBeLessThan(180);
        else expect(box.width).toBeGreaterThanOrEqual(260);
        expect(Math.abs(box.height - box.width)).toBeLessThan(1);
        const checkbox = await card.getByRole('checkbox').boundingBox();
        const label = await name.boundingBox();
        expect(label.x).toBeGreaterThan(original.x);
        expect(label.x).toBeGreaterThanOrEqual(checkbox.x + checkbox.width + 2);
      }
      const digits = await sequence.boundingBox();
      for (const container of [await name.boundingBox(), await card.boundingBox()]) {
        expect(digits.x).toBeGreaterThanOrEqual(container.x);
        expect(digits.y).toBeGreaterThanOrEqual(container.y);
        expect(digits.x + digits.width).toBeLessThanOrEqual(container.x + container.width + 0.5);
        expect(digits.y + digits.height).toBeLessThanOrEqual(container.y + container.height + 0.5);
      }
      // Nothing clips or covers the last digit.
      expect(await sequence.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.right - 1, box.top + box.height / 2));
      })).toBe(true);
      await card.screenshot({ path: testInfo.outputPath(`${card === library ? 'library' : 'chat'}-overlay-${zoom}.png`) });
    }
  } finally {
    await db`DELETE FROM generations WHERE project_id = ${project.id}`;
    await db`DELETE FROM project_members WHERE project_id = ${project.id}`;
    await db`DELETE FROM projects WHERE id = ${project.id}`;
  }
});
}

test('main chat follows folder switches and Unsorted with the same membership as the library', async ({ page, context, baseURL }) => {
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const tag = `Scope${randomUUID().slice(0, 8)}`;
  const projectResponse = await context.request.post('/api/projects', { headers: { Origin: baseURL }, data: { op: 'createProject', name: tag } });
  const { project } = await projectResponse.json();
  const folders = [], ids = [];
  try {
    for (const name of ['First', 'Second']) {
      const response = await context.request.post('/api/folders', { headers: { Origin: baseURL }, data: { name, projectId: project.id } });
      expect(response.ok()).toBeTruthy();
      folders.push((await response.json()).folder);
    }
    for (const [index, folder] of [...folders, null].entries()) {
      const id = randomUUID(); ids.push(id);
      await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, folder_id, permanent_name, created_at, updated_at)
        SELECT ${id},kind,status,model,${`${tag} ${index}`},aspect_ratio,url,user_id,${project.id},${folder?.id || null},${`${tag}_${index}_0001`},${Date.now()},${Date.now()}
        FROM generations WHERE id='10000000-0000-4000-8000-000000000000'`;
    }
    await page.addInitScript(projectId => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: projectId })), project.id);
    await page.goto('/');
    const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
    await expect(toggle).toBeVisible();
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const panel = page.locator('#desktop-history-panel');
    // Enter the project's tree through Unsorted, then alternate sibling folders.
    await panel.getByRole('button', { name: /Unsorted$/ }).first().click();
    for (const index of [0, 1, 2, 0]) {
      if (index === 2) await panel.getByRole('button', { name: /Unsorted$/ }).first().click();
      else await panel.getByRole('treeitem').filter({ hasText: folders[index].name }).click();
      await expect(panel.locator('[data-asset-card-id]')).toHaveCount(1);
      await expect(page.locator('[data-generation-id]')).toHaveCount(1);
      await expect(panel.locator(`[data-asset-card-id="${ids[index]}"]`)).toBeVisible();
      await expect(page.locator(`[data-generation-id="${ids[index]}"]`)).toBeVisible();
    }
  } finally {
    await db`DELETE FROM generations WHERE project_id=${project.id}`;
    for (const folder of folders) await db`DELETE FROM folders WHERE id=${folder.id}`;
    await db`DELETE FROM project_members WHERE project_id=${project.id}`;
    await db`DELETE FROM projects WHERE id=${project.id}`;
  }
});

test('ZIPs from All generations, folder views and a cross-folder selection name every file by its full location', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180000);
  await authenticate(context, baseURL);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  const tag = `Zip${randomUUID().slice(0, 8)}`;
  const post = (path, data) => context.request.post(path, { headers: { Origin: baseURL }, data });
  const { project } = await (await post('/api/projects', { op: 'createProject', name: tag })).json();
  const folders = [], ids = [], exports = [];
  try {
    let parentId;
    for (const name of [`${tag}One`, 'Two']) {
      const response = await post('/api/folders', { name, projectId: project.id, parentId, idempotencyKey: randomUUID() });
      expect(response.ok()).toBeTruthy();
      folders.push((await response.json()).folder);
      parentId = folders.at(-1).id;
    }
    const [outer, inner] = folders;
    const placement = { [outer.id]: [], [inner.id]: [] };
    for (const folder of [inner, inner, outer]) {
      const id = randomUUID(); ids.push(id); placement[folder.id].push(id);
      await db`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, created_at, updated_at)
        SELECT ${id},kind,status,model,${tag},aspect_ratio,url,user_id,${project.id},${Date.now()},${Date.now()}
        FROM generations WHERE id='10000000-0000-4000-8000-000000000000'`;
      const moved = await post('/api/history/move', { ids: [id], destination: { type: 'folder', folderId: folder.id } });
      expect(moved.ok()).toBeTruthy();
    }
    const individual = {};
    for (const id of ids) {
      const response = await context.request.get(`/api/generations/${id}/download`);
      expect(response.status()).toBe(200);
      individual[id] = /filename="([^"]+)"/.exec(response.headers()['content-disposition'])[1];
    }
    for (const id of placement[inner.id]) expect(individual[id]).toMatch(new RegExp(`^${tag}One_Two_\\d{4}\\.png$`));
    for (const id of placement[outer.id]) expect(individual[id]).toMatch(new RegExp(`^${tag}One_\\d{4}\\.png$`));

    await page.addInitScript(projectId => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: projectId })), project.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const panel = page.locator('#desktop-history-panel');
    async function open(view) {
      await page.goto('/');
      const toggle = page.locator('button[aria-controls="desktop-history-panel"]');
      await expect(toggle).toBeVisible();
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      if (view === 'all') await panel.getByRole('button', { name: 'All assets', exact: true }).click();
      else if (view === 'project') await panel.getByRole('button', { name: /^Project assets/ }).click();
      else if (view === 'outer') await panel.getByRole('treeitem', { name: new RegExp(`Tree folder actions: ${outer.name}$`) }).click();
      else {
        await panel.getByRole('button', { name: `Expand ${outer.name}`, exact: true }).click();
        await panel.getByRole('treeitem', { name: /Tree folder actions: Two$/ }).click();
      }
    }
    async function select(id) {
      const card = panel.locator(`[data-asset-card-id="${id}"]`);
      await expect(card).toHaveCount(1);
      await card.scrollIntoViewIfNeeded();
      await card.hover();
      await card.getByRole('checkbox', { name: 'Select', exact: true }).click();
    }
    async function selectAll(id) {
      await select(id);
      const all = panel.getByRole('checkbox', { name: 'Select all' });
      if (await all.getAttribute('aria-checked') !== 'true') await all.click();
    }
    async function zip(label) {
      const selected = await panel.locator('[data-asset-card-id]').evaluateAll(cards => cards
        .filter(card => card.querySelector('[role="checkbox"][aria-checked="true"]'))
        .map(card => [card.dataset.assetCardId, card.querySelector('[data-generation-name]').getAttribute('title')]));
      await panel.getByRole('button', { name: 'Download ZIP', exact: true }).click();
      const status = panel.getByRole('status', { name: 'ZIP export' });
      await expect(status.filter({ hasText: 'ZIP ready' })).toBeVisible({ timeout: 60000 });
      exports.push(...(await db`SELECT id FROM media_exports WHERE user_id=${USER_ID} ORDER BY created_at DESC LIMIT 1`).map(row => row.id));
      const downloading = page.waitForEvent('download');
      await status.getByRole('link', { name: 'Download', exact: true }).click();
      const download = await downloading;
      const path = testInfo.outputPath(`${label}.zip`);
      await download.saveAs(path);
      const entries = JSON.parse(execFileSync(process.env.E2E_PYTHON, ['-c',
        'import sys,json,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', path], { encoding: 'utf8' }));
      await testInfo.attach(`${label}-entries`, { body: JSON.stringify({ selected, entries }, null, 2), contentType: 'application/json' });
      expect(entries.length).toBe(selected.length);
      for (const [id, cardName] of selected) {
        expect(cardName).toBe(individual[id]);
        const directory = placement[inner.id].includes(id) ? `${outer.name}/Two` : outer.name;
        expect(entries).toContain(`Projects/${tag}/${directory}/${individual[id]}`);
      }
      return selected.map(([id]) => id).sort();
    }

    await open('all');
    for (const id of ids) await select(id);
    expect(await zip('all-generations')).toEqual([...ids].sort());
    await open('outer');
    await selectAll(placement[outer.id][0]);
    expect(await zip('folder-one')).toEqual(placement[outer.id]);
    await open('inner');
    await selectAll(placement[inner.id][0]);
    expect(await zip('folder-two')).toEqual([...placement[inner.id]].sort());
    await open('project');
    await select(placement[inner.id][1]);
    await select(placement[outer.id][0]);
    expect(await zip('multi-select')).toEqual([placement[inner.id][1], placement[outer.id][0]].sort());
  } finally {
    if (exports.length) await db`DELETE FROM media_exports WHERE id IN ${db(exports)}`;
    await db`DELETE FROM generations WHERE project_id=${project.id}`;
    for (const folder of folders.reverse()) await db`DELETE FROM folders WHERE id=${folder.id}`;
    await db`DELETE FROM project_members WHERE project_id=${project.id}`;
    await db`DELETE FROM projects WHERE id=${project.id}`;
  }
});
