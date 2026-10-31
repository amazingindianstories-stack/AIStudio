import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER = 'b0a2d000-0000-4000-8000-000000000041';
function cookie(userId = USER) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

test('Board work: create cards, edit details, arrange columns, reload persisted records', async ({ browser, baseURL }) => {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([db.statement`INSERT INTO users (id,email,password_hash,password_salt,created_at,name,role,is_active,auth_version)
    VALUES (${USER},'work-owner@example.test','unused','unused',1,'Work owner','user',true,0)
    ON CONFLICT (id) DO UPDATE SET is_active=true, auth_version=0`]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: cookie(), url: baseURL }]);
  const result = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Work ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(result.ok()).toBeTruthy();
  const { project } = await result.json();
  await context.addInitScript(id => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })), project.id);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Cards and work' });
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await page.keyboard.press('d');
  await expect(panel.getByLabel('title', { exact: true })).toHaveValue('Untitled task');
  await panel.getByRole('button', { name: 'Close cards and work' }).click();
  await page.keyboard.press('Control+Shift+Enter');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close cards and work' }).click();
  await page.keyboard.press('Meta+Shift+Enter');
  await expect(panel).toBeVisible();
  await panel.getByLabel('title', { exact: true }).fill('Ship milestone');
  await panel.getByRole('textbox', { name: 'description', exact: true }).fill('Review the release checklist');
  await panel.getByLabel('start', { exact: true }).fill('2026-12-01');
  await panel.getByLabel('end', { exact: true }).fill('2026-12-15');
  await panel.getByLabel('tags', { exact: true }).fill('release, review');
  await panel.getByLabel('links', { exact: true }).fill('https://example.test/release');
  await panel.getByRole('combobox', { name: 'Status', exact: true }).selectOption('In progress');
  await panel.getByRole('combobox', { name: 'Assignee', exact: true }).selectOption(USER);
  await panel.getByRole('button', { name: 'Add columns', exact: true }).click();
  await panel.getByLabel('lanes name 1', { exact: true }).fill('Backlog');
  await panel.getByLabel('lanes color 1', { exact: true }).fill('#ff8800');
  await panel.getByRole('button', { name: 'Add column', exact: true }).click();
  await panel.getByLabel('lanes name 4', { exact: true }).fill('Review');
  await panel.getByRole('button', { name: 'Move Review up', exact: true }).click();
  await panel.getByRole('button', { name: 'Add swimlane', exact: true }).click();
  await panel.getByLabel('swimlanes name 2', { exact: true }).fill('Design');
  await panel.getByLabel('swimlanes color 2', { exact: true }).fill('#22aa66');
  await panel.getByRole('button', { name: 'Move Design up', exact: true }).click();
  await panel.getByRole('button', { name: 'Add card to columns', exact: true }).click();
  await panel.getByLabel('title', { exact: true }).fill('Lane task');
  await panel.getByRole('combobox', { name: 'lane', exact: true }).selectOption({ label: 'Review' });
  await panel.getByRole('combobox', { name: 'swimlane', exact: true }).selectOption({ label: 'Team' });
  const boards = await (await context.request.get(`/api/canvas-boards?projectId=${project.id}`)).json();
  const boardId = boards.boards[0].id;
  await expect.poll(async () => {
    const board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return board.data.nodes.filter(n => n.type === 'card').map(n => n.record.title).sort();
  }).toEqual(['Lane task', 'Ship milestone']);
  // Assert placement from persisted data, independently of rendered node visibility.
  await expect.poll(async () => {
    const board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    const columns = board.data.nodes.find(n => n.kind === 'columns');
    const task = board.data.nodes.find(n => n.record?.title === 'Lane task');
    return {
      lanes: columns.lanes.map(l => l.name), swimlanes: columns.swimlanes.map(l => l.name),
      colors: [columns.lanes[0].color, columns.swimlanes[0].color],
      parent: task.parentId === columns.id,
      lane: task.record.lane === columns.lanes[2].id,
      swimlane: task.record.swimlane === columns.swimlanes[1].id,
    };
  }).toMatchObject({
    lanes: ['Backlog', 'In progress', 'Review', 'Done'], swimlanes: ['Design', 'Team'],
    colors: ['#ff8800', '#22aa66'], parent: true, lane: true, swimlane: true,
  });
  const placed = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
  const columns = placed.data.nodes.find(n => n.kind === 'columns');
  const task = placed.data.nodes.find(n => n.record?.title === 'Lane task');
  expect(task.x).toBe(columns.x + 16 + 2 * (columns.w - 20) / 4);
  expect(task.y).toBe(columns.y + 84 + (columns.h - 72) / 2);
  expect(task.x + task.w).toBeLessThanOrEqual(columns.x + columns.w);
  expect(task.y + task.h).toBeLessThanOrEqual(columns.y + columns.h);
  await page.reload();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Team board' });
  await expect(panel.getByLabel('lanes name 3', { exact: true })).toHaveValue('Review');
  await expect(panel.getByLabel('lanes color 1', { exact: true })).toHaveValue('#ff8800');
  await expect(panel.getByLabel('swimlanes name 1', { exact: true })).toHaveValue('Design');
  await expect(panel.getByLabel('swimlanes color 1', { exact: true })).toHaveValue('#22aa66');
  await panel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Lane task' });
  await expect(panel.getByRole('combobox', { name: 'lane', exact: true })).toHaveValue(task.record.lane);
  await expect(panel.getByRole('combobox', { name: 'swimlane', exact: true })).toHaveValue(task.record.swimlane);
  await panel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Ship milestone' });
  await expect(panel.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('Review the release checklist');
  await expect(panel.getByRole('combobox', { name: 'Assignee', exact: true })).toHaveValue(USER);
  for (const [field, value] of Object.entries({ title: 'Ship milestone', description: 'Review the release checklist', start: '2026-12-01', end: '2026-12-15', tags: 'release, review', links: 'https://example.test/release' })) {
    await expect(panel.getByRole('textbox', { name: field, exact: true })).toHaveValue(value);
  }
  await expect(panel.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('In progress');
  // Pan far enough to unmount the card, then edit through the model-backed selector.
  const saved = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
  const cardId = saved.data.nodes.find(node => node.record?.title === 'Ship milestone').id;
  await panel.getByRole('button', { name: 'Close cards and work' }).click();
  const renderedCard = page.locator(`[data-node-id="${cardId}"]`);
  await expect(renderedCard).toBeVisible();
  await page.getByLabel('Board canvas', { exact: true }).hover({ position: { x: 700, y: 500 } });
  await page.mouse.wheel(10000, 10000);
  await expect(renderedCard).toHaveCount(0);
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Ship milestone' });
  await panel.getByRole('textbox', { name: 'description', exact: true }).fill('Edited while offscreen');
  await expect(renderedCard).toHaveCount(0);
  await expect.poll(async () => {
    const board = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
    return board.data.nodes.find(node => node.id === cardId)?.record.description;
  }).toBe('Edited while offscreen');
  await page.reload();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Ship milestone' });
  await expect(panel.getByRole('textbox', { name: 'description', exact: true })).toHaveValue('Edited while offscreen');
  // Both read-only roles can inspect all fields but cannot mutate board content.
  const readerId = 'b0a2d000-0000-4000-8000-000000000042';
  await db`INSERT INTO users (id,email,password_hash,password_salt,created_at,name,role,is_active,auth_version)
    VALUES (${readerId},'work-reader@example.test','unused','unused',1,'Work reader','user',true,0)
    ON CONFLICT (id) DO UPDATE SET role='user', is_active=true, auth_version=0`;
  const before = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
  for (const role of ['view', 'comment']) {
    await db`UPDATE canvas_boards SET team_role = ${role} WHERE id = ${boardId}`;
    const reader = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      await reader.addCookies([{ name: 'veevee_session', value: cookie(readerId), url: baseURL }]);
      await reader.addInitScript(id => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })), project.id);
      const readPage = await reader.newPage();
      const writes = [];
      readPage.on('request', request => {
        if (new URL(request.url()).pathname === `/api/canvas-boards/${boardId}` && ['PUT', 'PATCH'].includes(request.method())) writes.push(request.url());
      });
      await readPage.goto('/');
      await readPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
      await expect(readPage.getByRole('status').filter({ hasText: role === 'view' ? 'View only' : 'Comment only' })).toBeVisible();
      await readPage.keyboard.press('d');
      await expect(readPage.getByRole('dialog', { name: 'Cards and work' })).toHaveCount(0);
      await readPage.getByRole('button', { name: 'Cards and work', exact: true }).click();
      const readPanel = readPage.getByRole('dialog', { name: 'Cards and work' });
      await expect(readPanel.getByRole('button', { name: 'Add card (D)', exact: true })).toHaveCount(0);
      await expect(readPanel.getByRole('button', { name: 'Add columns', exact: true })).toHaveCount(0);
      await readPanel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Ship milestone' });
      for (const field of ['title', 'description', 'start', 'end', 'tags', 'links']) {
        await expect(readPanel.getByRole('textbox', { name: field, exact: true })).toBeDisabled();
      }
      await expect(readPanel.getByRole('textbox', { name: 'title', exact: true })).toHaveValue('Ship milestone');
      for (const field of ['Assignee', 'Status', 'Columns widget']) {
        await expect(readPanel.getByRole('combobox', { name: field, exact: true })).toBeDisabled();
      }
      await readPanel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Lane task' });
      for (const field of ['lane', 'swimlane']) {
        await expect(readPanel.getByRole('combobox', { name: field, exact: true })).toBeDisabled();
      }
      await readPanel.getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'Team board' });
      await expect(readPanel.getByRole('textbox', { name: 'Widget title', exact: true })).toBeDisabled();
      for (const [kind, lanes] of [['lanes', columns.lanes], ['swimlanes', columns.swimlanes]]) {
        for (const [index, lane] of lanes.entries()) {
          const name = readPanel.getByRole('textbox', { name: `${kind} name ${index + 1}`, exact: true });
          await expect(name).toHaveValue(lane.name);
          await expect(name).toBeDisabled();
          const color = readPanel.getByLabel(`${kind} color ${index + 1}`, { exact: true });
          await expect(color).toHaveValue(lane.color);
          await expect(color).toBeDisabled();
          await expect(readPanel.getByRole('button', { name: `Move ${lane.name} up`, exact: true })).toBeDisabled();
        }
      }
      for (const name of ['Add column', 'Add swimlane', 'Add card to columns', 'Arrange cards']) {
        await expect(readPanel.getByRole('button', { name, exact: true })).toBeDisabled();
      }
      // API authorization must hold even if a client bypasses disabled controls.
      const denied = await reader.request.put(`/api/canvas-boards/${boardId}`, {
        data: { data: before.data, version: before.version }, headers: { Origin: baseURL },
      });
      expect(denied.status()).toBe(403);
      expect(writes).toEqual([]);
      const after = await (await context.request.get(`/api/canvas-boards/${boardId}`)).json();
      expect(after.data).toEqual(before.data);
    } finally {
      await reader.close();
    }
  }
  await context.close();
});

test('Board work: data widgets group and load the whole table, link off-page records and build story maps', async ({ browser, baseURL }) => {
  test.setTimeout(240000);
  const owner = 'b0a2d000-0000-4000-8000-000000000043';
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db`INSERT INTO users (id,email,password_hash,password_salt,created_at,name,role,is_active,auth_version)
    VALUES (${owner},'work-data@example.test','unused','unused',1,'Data owner','user',true,0)
    ON CONFLICT (id) DO UPDATE SET is_active=true, auth_version=0`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'veevee_session', value: cookie(owner), url: baseURL }]);
  const { project } = await (await context.request.post('/api/projects', { data: { op: 'createProject', name: `Work data ${randomUUID()}` }, headers: { Origin: baseURL } })).json();
  await context.addInitScript(id => localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id })), project.id);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cards and work' }).getByRole('button', { name: 'Add Table', exact: true }).click();
  const records = page.getByRole('dialog', { name: 'Work records' });
  await expect(records.getByRole('heading', { name: 'New table' })).toBeVisible();
  const boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${project.id}`)).json()).boards[0].id;
  const table = (await (await context.request.get(`/api/canvas-boards/${boardId}/work`)).json()).tables[0];
  const path = `/api/canvas-boards/${boardId}/work/${table.id}`;
  for (let i = 0; i < 205; i++) {
    const day = String(1 + i % 20).padStart(2, '0');
    const added = await context.request.post(path, { headers: { Origin: baseURL }, data: { op: 'add', cells: {
      title: `Item ${String(i).padStart(3, '0')}`, status: i % 2 ? 'Done' : 'To do', start: `2026-11-${day}`, end: `2026-11-${day}` } } });
    expect(added.ok()).toBeTruthy();
  }
  const id = async title => (await (await context.request.get(`${path}?q=${encodeURIComponent(title)}`)).json()).records.find(r => r.cells.title === title);
  await records.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(records.getByText('205 records · showing 1-200', { exact: true })).toBeVisible();
  await records.getByRole('combobox', { name: 'Group by', exact: true }).selectOption({ label: 'Status' });
  const workspace = records.getByLabel('Record workspace', { exact: true });
  await expect(workspace.getByRole('heading', { name: 'Done · 102 records', exact: true })).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'To do · 103 records', exact: true })).toBeVisible();
  await expect(workspace.getByRole('region', { name: 'Group To do' }).getByRole('row')).toHaveCount(99);
  await records.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: 'Done · 102 records', exact: true })).toHaveCount(0);
  await expect(workspace.getByRole('region', { name: 'Group To do' }).getByRole('row')).toHaveCount(6);
  await records.getByRole('button', { name: 'Previous', exact: true }).click();

  // Parent and dependency pickers search the whole table, not the loaded page.
  await workspace.getByRole('button', { name: 'Item 000', exact: true }).click();
  const details = records.getByRole('form', { name: 'Record details' });
  await details.getByRole('textbox', { name: 'Search Blocked by records' }).fill('Item 204');
  await details.getByRole('list', { name: 'Blocked by search results' }).getByRole('button', { name: 'Item 204', exact: true }).click();
  await details.getByRole('textbox', { name: 'Search Parent records' }).fill('Item 203');
  await expect(details.getByRole('list', { name: 'Parent search results' })).toContainText('Item 203');
  await details.getByRole('textbox', { name: 'Search Parent records' }).press('Enter');
  await expect(details.getByRole('list', { name: 'Parent records' })).toContainText('Item 203');
  await details.getByRole('button', { name: 'Save record', exact: true }).click();
  const [blocker, parent] = [await id('Item 204'), await id('Item 203')];
  await expect.poll(async () => { const r = await id('Item 000'); return [r.parentId, r.blockedBy]; }).toEqual([parent.id, [blocker.id]]);
  // Relation-field blockers are read-only in the picker; removing the explicit dependency never touches the relation cell.
  const current = (await (await context.request.get(path)).json()).table;
  expect((await context.request.post(path, { headers: { Origin: baseURL }, data: { op: 'settings', version: current.version, fields: [...current.fields, { id: 'needs', name: 'Needs', type: 'relation' }] } })).ok()).toBeTruthy();
  const linked = await id('Item 000');
  expect((await context.request.post(path, { headers: { Origin: baseURL }, data: { op: 'update', id: linked.id, version: linked.version, cells: { ...linked.cells, needs: [parent.id] } } })).ok()).toBeTruthy();
  await details.getByRole('button', { name: 'Close', exact: true }).click();
  await records.getByRole('button', { name: 'Refresh', exact: true }).click();
  await workspace.getByRole('button', { name: '↳ Item 000', exact: true }).click();
  const blockers = details.getByRole('list', { name: 'Blocked by records' });
  await expect(blockers).toContainText('Item 204');
  await expect(blockers.getByRole('listitem').filter({ hasText: 'From Needs field' })).toContainText('Item 203');
  await expect(blockers.getByRole('button', { name: 'Remove Item 203 from Blocked by' })).toHaveCount(0);
  await details.getByRole('button', { name: 'Remove Item 204 from Blocked by' }).click();
  await details.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect.poll(async () => { const r = await id('Item 000'); return [r.blockedBy, r.cells.needs]; }).toEqual([[], [parent.id]]);
  await expect(blockers.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(blockers.getByRole('listitem').filter({ hasText: 'From Needs field' })).toContainText('Item 203');

  // Every non-table view receives the complete query result.
  const view = records.getByRole('combobox', { name: 'Work view', exact: true });
  await view.selectOption('kanban');
  await expect(workspace.getByRole('button', { name: /^Item \d{3}/ })).toHaveCount(205);
  await view.selectOption('timeline');
  await records.getByRole('combobox', { name: 'Group by', exact: true }).selectOption({ label: 'Status' });
  await expect(workspace.getByRole('button', { name: /^Item \d{3}$/ })).toHaveCount(205);
  await expect(workspace.getByLabel('Timeline group Done', { exact: true })).toBeVisible();
  await expect(workspace.getByLabel('Timeline group To do', { exact: true })).toBeVisible();
  await expect(workspace.getByText('↳ Item 000 ◆', { exact: true })).toBeVisible();
  await view.selectOption('chart');
  await expect(workspace.locator('svg title, svg text').filter({ hasText: 'Item 204' }).first()).toBeAttached();

  // The canvas preview shares the panel's query but renders a bounded page and says so; grouped charts use server counts over every record.
  const preview = page.locator('[data-work-kind="chart"]');
  await expect(preview.getByText(/^Showing \d+ of 205 records$/)).toBeVisible();
  await records.getByRole('combobox', { name: 'Group by', exact: true }).selectOption({ label: 'Status' });
  await expect(workspace.getByText('Legend: Done · To do', { exact: true })).toBeVisible();
  await expect(workspace.locator('svg title').filter({ hasText: /^Done: 102$/ })).toBeAttached();
  await expect(preview.getByText('205 records in 2 groups', { exact: true })).toBeVisible();
  await expect(preview.locator('svg title').filter({ hasText: /^To do: 103$/ })).toBeAttached();

  // Story maps place stories by activity, task and release, and keyboard entry keeps that context.
  await records.getByRole('button', { name: 'Close records', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cards and work' }).getByRole('button', { name: 'Add Story map', exact: true }).click();
  await expect(records.getByRole('heading', { name: 'New story' })).toBeVisible();
  await records.getByRole('button', { name: 'Add record', exact: true }).click();
  await records.getByRole('form', { name: 'Record details' }).getByRole('button', { name: 'Close', exact: true }).click();
  await workspace.focus();
  await page.keyboard.press('Tab');
  await expect(workspace.locator('td[aria-label="New activity / New task / Release 1"]').getByRole('button')).toHaveCount(1);
  await workspace.focus();
  await page.keyboard.press('Enter');
  await expect(workspace.locator('td[aria-label="New activity / New task / Release 1"]').getByRole('button')).toHaveCount(2);
  await expect(workspace.getByRole('table', { name: 'Story map' }).getByRole('columnheader', { name: 'New task', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Cards and work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cards and work' }).getByRole('combobox', { name: 'Selected widget', exact: true }).selectOption({ label: 'New story' });
  await expect(workspace.locator('td[aria-label="New activity / New task / Release 1"]').getByRole('button')).toHaveCount(2);
  await context.close();
});
