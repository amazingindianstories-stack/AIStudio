import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Two ordinary fixture users who both edit one board: the person who records and one who watches.
const OWNER = { id: 'b0a2d000-0000-4000-8000-000000000031', name: 'Recorder', email: 'recorder@example.test' };
const MATE = { id: 'b0a2d000-0000-4000-8000-000000000032', name: 'Watcher', email: 'watcher@example.test' };

function sessionCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function seedUsers() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([OWNER, MATE].map((user) => db.statement`
    INSERT INTO users (id, email, password_hash, password_salt, created_at, name, role, is_active, auth_version)
    VALUES (${user.id}, ${user.email}, 'unused', 'unused', 1, ${user.name}, 'user', true, 0)
    ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = true, auth_version = 0`));
}

async function signIn(browser, baseURL, user, projectId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(user.id), url: baseURL }]);
  await context.addInitScript((id) => {
    localStorage.setItem('veevee-draft-settings-v1', JSON.stringify({ activeProjectId: id }));
  }, projectId);
  const page = await context.newPage();
  return { context, page };
}

const isBoardGet = (response) => /\/api\/canvas-boards\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname) && response.request().method() === 'GET';

async function openBoard(page) {
  const loaded = page.waitForResponse(isBoardGet);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Talktrack', exact: true })).toBeVisible();
  return new URL((await loaded).url()).pathname;
}

const sticky = (id, text, x, y) => ({ id, type: 'sticky', x, y, w: 200, h: 200, text });

/** Replaces the board's objects the way a client save does (the whole graph at the current version). */
async function putNodes(context, baseURL, boardPath, nodes) {
  const current = await (await context.request.get(boardPath)).json();
  const response = await context.request.put(boardPath, {
    data: { data: { ...current.data, nodes }, baseVersion: current.version, saveId: randomUUID() }, headers: { Origin: baseURL } });
  expect(response.status()).toBe(200);
}


test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('Talktrack: record from the camera, find it in the library, react and comment, watch from another account, rename and delete', async ({ browser, baseURL }, info) => {
  test.setTimeout(240000);
  await seedUsers();
  const setup = await signIn(browser, baseURL, OWNER, null);
  const created = await setup.context.request.post('/api/projects', {
    data: { op: 'createProject', name: `Walkthrough ${randomUUID()}` }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await setup.context.close();

  const owner = await signIn(browser, baseURL, OWNER, project.id);
  // The fake camera is a real device stream; the microphone is a synthetic tone so the spec does not depend on a sound card.
  await owner.context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original({ video: constraints.video || false });
      if (constraints.audio) {
        const audio = new AudioContext();
        const destination = audio.createMediaStreamDestination();
        const tone = audio.createOscillator();
        tone.connect(destination);
        tone.start();
        destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      }
      return stream;
    };
  });
  await owner.context.grantPermissions(['camera', 'microphone'], { origin: baseURL });
  const boardPath = await openBoard(owner.page);
  const shared = await owner.context.request.post(`${boardPath}/access`, {
    data: { op: 'setMember', userId: MATE.id, role: 'edit' }, headers: { Origin: baseURL } });
  expect(shared.ok()).toBeTruthy();

  const page = owner.page;
  await page.getByRole('button', { name: 'Talktrack', exact: true }).click();
  await expect(page.getByText('No recordings yet')).toBeVisible();
  await info.attach('talktrack-empty', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('radio', { name: 'Camera' }).click();
  await page.getByRole('button', { name: 'Record a Talktrack' }).click();
  const bar = page.locator('[data-talktrack-recorder]');
  await expect(bar).toContainText('Recording starts in');
  await expect(bar.getByRole('button', { name: 'Pause recording' })).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await bar.getByRole('button', { name: 'Pause recording' }).click();
  await expect(bar).toContainText('Paused');
  await bar.getByRole('button', { name: 'Resume recording' }).click();
  await page.waitForTimeout(1500);
  await info.attach('talktrack-recording', { body: await page.screenshot(), contentType: 'image/png' });
  await bar.getByRole('button', { name: 'Stop and save recording' }).click();

  // The saved recording opens in the player on the board.
  const player = page.locator('[data-talktrack-player]');
  await expect(player).toBeVisible({ timeout: 60000 });
  await expect(player.getByRole('slider', { name: 'Timeline' })).toBeVisible();
  await player.getByRole('button', { name: 'React \u{1F389}' }).click();
  await expect(player.locator('[data-talktrack-reaction]')).toHaveCount(1);
  await player.getByRole('tab', { name: /Comments/ }).click();
  await player.getByLabel('Comment at this moment').fill('Start here');
  await player.getByRole('button', { name: 'Send comment' }).click();
  await expect(player.getByText('Start here')).toBeVisible();
  await player.getByRole('tab', { name: 'Transcript' }).click();
  await expect(player.getByText('No transcript yet.')).toBeVisible();
  await info.attach('talktrack-player', { body: await page.screenshot(), contentType: 'image/png' });
  await player.getByRole('button', { name: 'Close Talktrack' }).click();
  await expect(player).toHaveCount(0);

  // Another account sees it in this board's list and its own list stays empty.
  const mate = await signIn(browser, baseURL, MATE, project.id);
  await openBoard(mate.page);
  await mate.page.getByRole('button', { name: 'Talktrack', exact: true }).click();
  const row = mate.page.locator('[data-talktrack-row]');
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /^Play / }).click();
  const matePlayer = mate.page.locator('[data-talktrack-player]');
  await expect(matePlayer).toBeVisible();
  await expect(matePlayer.locator('[data-talktrack-reaction]')).toHaveCount(1, { timeout: 15000 });
  await matePlayer.getByRole('button', { name: 'Close Talktrack' }).click();
  await mate.page.getByRole('button', { name: 'Talktrack', exact: true }).click();
  await mate.page.getByRole('tab', { name: 'Your recordings' }).click();
  await expect(mate.page.getByText('You have not recorded anything yet.')).toBeVisible();

  // The recorder sees who watched, then renames and deletes the recording.
  await page.getByRole('button', { name: 'Talktrack', exact: true }).click();
  await page.getByRole('tab', { name: 'Your recordings' }).click();
  await expect(page.locator('[data-talktrack-row]')).toHaveCount(1);
  await page.getByRole('tab', { name: 'This board' }).click();
  const mine = page.locator('[data-talktrack-row]');
  await mine.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Recording name').fill('Board tour');
  await page.getByLabel('Recording name').press('Enter');
  await expect(mine).toContainText('Board tour');
  await mine.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('[data-talktrack-row]')).toHaveCount(0);
  await mate.context.close();
  await owner.context.close();
});
