import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';
import { portraitPng } from './portrait-image.mjs';

// The Agents tab is one chat: the composer's Image, Video and Upscale tabs switch the model and settings below the
// input, every message carries them as its `composer` context, and a header says where the chat is and where new work
// lands. Runs are written by hand, as in agents-runs.spec.mjs, since the harness runs no agent worker.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';

function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function openAgents(page, context, baseURL, label) {
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(), url: baseURL }]);
  const name = `${label} ${randomUUID()}`;
  const created = await context.request.post('/api/projects', { data: { op: 'createProject', name }, headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await page.addInitScript((projectId) => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, project.id);
  await page.goto('/');
  // Below 768px the account button shows the initial only.
  const phone = page.viewportSize().width < 768;
  await expect(page.getByRole('button', { name: phone ? 'D' : /Desktop fixture/, exact: phone })).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Loading chat…', { exact: true })).not.toBeVisible();
  return { project, name };
}

/** Sends `content`; resolves to the request body and the response body (201 starts a run, 202 queues on it). */
async function send(page, content, status) {
  const input = page.getByPlaceholder(/Talk through your/);
  await expect(input).toBeEnabled();
  await input.fill(content);
  const answered = page.waitForResponse((response) => response.url().endsWith('/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(status);
  return { body: response.request().postDataJSON(), result: await response.json() };
}

function modelOf(page) {
  return page.getByRole('button', { name: /^Model: / }).last();
}

async function selectMode(page, id) {
  const tab = page.getByRole('tablist', { name: 'Mode' }).getByTestId(`chat-mode-${id}`);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

test.afterEach(async () => {
  const now = Date.now();
  await fixtureDatabase(process.env.E2E_DATABASE_URL)`
    UPDATE agent_runs SET status = 'cancelled', finished_at = ${now}, updated_at = ${now}
    WHERE user_id = ${USER_ID} AND status IN ('queued', 'running', 'waiting_approval', 'waiting_jobs', 'paused_limit')`;
});

test('Agents chat: one thread works in Image, Video and Upscale, each tab with its own model and settings, under a header that says where you are', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  const { project, name } = await openAgents(page, context, baseURL, 'Agents chat modes');

  // The header names the project, the open chat and the folder new work saves to; there are no separate agent tabs.
  const header = page.getByTestId('agents-header');
  await expect(header.getByRole('navigation', { name: 'Location' })).toContainText(name);
  // A chat nobody has written in yet reads by when it started, never like the New chat button above it.
  await expect(header.getByTestId('agents-chat-name')).toHaveText(/^Untitled chat · /);
  const sidebarRows = page.getByRole('button', { name: /^Untitled chat · / });
  await expect(sidebarRows).toHaveCount(1);
  await expect(header.getByTestId('agents-destination')).toHaveText(/Saving to\s*Unsorted/);
  await expect(page.getByRole('button', { name: /^(Image|Video) agent$/ })).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Mode' }).getByRole('tab')).toHaveText(['Image', 'Video', 'Upscale']);
  await expect(page.getByTestId('studio-chat-empty')).toBeVisible();

  await selectMode(page, 'image');
  await expect(page.getByPlaceholder(/Talk through your idea/)).toBeVisible();
  const imageModel = (await modelOf(page).getAttribute('aria-label')).replace(/^Model: /, '');
  await selectMode(page, 'video');
  await expect(page.getByPlaceholder(/Talk through your shot/)).toBeVisible();
  await expect(modelOf(page)).not.toHaveAttribute('aria-label', `Model: ${imageModel}`);
  const videoModel = (await modelOf(page).getAttribute('aria-label')).replace(/^Model: /, '');

  // A message carries the tab it was sent from, its model and settings, and the project new work lands in.
  const video = await send(page, 'A slow dolly toward a lantern-lit doorway.', 201);
  expect(video.body.composer).toMatchObject({ mode: 'video', model: videoModel, projectId: project.id });
  // Without a choice the agent runs on Flash at medium thinking.
  expect(video.body).toMatchObject({ model: 'gemini-3.8-flash', thinkingLevel: 'MEDIUM' });
  expect(video.result.run).toMatchObject({ model: 'gemini-3.8-flash', thinkingLevel: 'MEDIUM' });
  expect(video.body.composer.options).toMatchObject({ aspectRatio: expect.any(String) });
  expect(video.body.composer.folderId).toBeUndefined();
  await expect(page.getByPlaceholder(/Talk through your/)).toHaveValue('');
  const feed = page.getByTestId('studio-chat-feed');
  await expect(feed.getByTestId('message-composer-tag')).toHaveText(`Video · ${videoModel}`);
  // The first message names the chat, in the header and the chat list.
  expect(video.result.conversation.name).toBe('A slow dolly toward a lantern-lit doorway.');
  await expect(header.getByTestId('agents-chat-name')).toHaveText('A slow dolly toward a lantern-lit doorway.');
  await expect(page.getByRole('button', { name: 'A slow dolly toward a lantern-lit doorway.', exact: true })).toBeVisible();

  // Switching tabs keeps the thread: the next message, sent as an image, queues on the same chat's run.
  await selectMode(page, 'image');
  await expect(feed.getByText('A slow dolly toward a lantern-lit doorway.', { exact: true })).toBeVisible();
  const image = await send(page, 'Also a still of the doorway.', 202);
  expect(image.result.run.conversationId).toBe(video.result.run.conversationId);
  expect(image.body.composer).toMatchObject({ mode: 'image', model: imageModel, projectId: project.id, options: { count: expect.any(Number) } });

  // Upscale swaps the reference picker for the source square, and the model and settings for the upscaler's. The
  // only Image and Video choices in the composer are the mode tabs: the upscaler menu groups image and video
  // upscalers, and the source square takes either.
  await selectMode(page, 'upscale');
  await expect(page.getByPlaceholder(/Talk through your upscale/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose the image or video to upscale', exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Upscale media' })).toHaveCount(0);
  await expect(modelOf(page)).toHaveAttribute('aria-label', /^Model: Magnific /);
  await modelOf(page).click();
  await expect(page.getByRole('group', { name: 'Image upscalers' }).getByRole('menuitem')).not.toHaveCount(0);
  await page.getByRole('group', { name: 'Video upscalers' }).getByRole('menuitem', { name: /^Magnific Video Precision/ }).click();
  await expect(modelOf(page)).toHaveAttribute('aria-label', 'Model: Magnific Video Precision');
  // Attaching an image while a video upscaler is chosen switches back to the image upscalers.
  await page.getByTestId('upscale-source-input').setInputFiles({ name: 'doorway.png', mimeType: 'image/png', buffer: portraitPng(7) });
  await expect(page.getByRole('button', { name: /^Upscale source: doorway\.png/ })).toBeVisible({ timeout: 20000 });
  await expect(modelOf(page)).toHaveAttribute('aria-label', /^Model: Magnific (Creative|Precision)/);
  const settings = page.getByRole('button', { name: 'Upscale settings', exact: true });
  await settings.click();
  const panel = page.getByTestId('upscale-settings');
  await expect(panel).toBeVisible();
  // A choice inside the settings opens its own menu without closing the settings.
  await panel.getByRole('button', { name: 'Automatic', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sparkle' }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sparkle', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sparkle' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  const upscale = await send(page, 'Upscale it, keep the grain.', 202);
  expect(upscale.body.composer).toMatchObject({ mode: 'upscale', model: expect.stringMatching(/^Magnific /), projectId: project.id,
    upscale: { media: 'image', params: { engine: 'magnific_sparkle' }, source: expect.stringMatching(/^\/api\/media\/uploads\//) } });
  await page.getByRole('button', { name: 'Remove the source image', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose the image or video to upscale', exact: true })).toBeVisible();
});

test('Agents chat: a turn\'s work is one collapsed line that opens to its notes, the arguments it chose, timings and the agent model', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents chat trace');
  // The agent model control picks the run's model and thinking level, and a refresh keeps the choice.
  const picker = page.getByRole('button', { name: /^Agent model: / });
  await expect(picker).toHaveAttribute('aria-label', 'Agent model: Gemini 3.8 Flash, Medium thinking');
  await picker.click();
  await page.getByRole('menuitemradio', { name: /^Gemini 3\.1 Pro/ }).click();
  await expect(page.getByRole('group', { name: 'Thinking level' }).getByRole('menuitemradio')).toHaveText(['Low', 'Medium', 'High']);
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
  await expect(picker).toHaveAttribute('aria-label', 'Agent model: Gemini 3.1 Pro, High thinking');
  await page.reload();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Loading chat…', { exact: true })).not.toBeVisible();
  await expect(picker).toHaveAttribute('aria-label', 'Agent model: Gemini 3.1 Pro, High thinking');
  const { body, result: { run } } = await send(page, 'Make a moonlit harbour.', 201);
  expect(body).toMatchObject({ model: 'gemini-3.1-pro-preview', thinkingLevel: 'HIGH' });
  expect(run).toMatchObject({ model: 'gemini-3.1-pro-preview', thinkingLevel: 'HIGH' });
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  let clock = Date.now();
  const emit = (kind, payload, at) => db.statement`
    INSERT INTO agent_run_events (run_id, seq, kind, payload, created_at)
    SELECT ${run.id}::uuid, COALESCE(MAX(seq), 0) + 1, ${kind}, ${JSON.stringify(payload)}::jsonb, ${at}
    FROM agent_run_events WHERE run_id = ${run.id}`;
  const prompt = 'A moonlit harbour, long exposure, boats as soft silhouettes.';
  const args = { prompt, aspectRatio: '16:9', count: 2 };
  const started = clock += 1;
  await db.transaction([
    emit('run_started', {}, started),
    emit('step_started', { stepIndex: 0, kind: 'llm' }, clock += 1),
    emit('assistant_text', { stepIndex: 0, text: 'Two wide frames first, then pick one.', final: false }, clock += 1),
    emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image', arguments: args }, clock += 1000),
    emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'ok', ok: true, summary: 'Queued two images.' }, clock += 4000),
    emit('step_started', { stepIndex: 2, kind: 'llm' }, clock += 1),
    emit('assistant_text', { stepIndex: 2, text: 'Two harbour frames are on the way.', final: true }, clock += 2000),
    db.statement`INSERT INTO agent_conversation_messages (conversation_id, role, content, tool_trace, created_at)
      VALUES (${run.conversationId}, 'assistant', 'Two harbour frames are on the way.', ${JSON.stringify({ runId: run.id, stepIndex: 2 })}::jsonb, ${clock += 1})`,
    db.statement`UPDATE agent_runs SET status = 'completed', step_count = 3, started_at = ${started},
      finished_at = ${clock}, updated_at = ${clock += 1} WHERE id = ${run.id}`,
    emit('completed', { steps: 3, costCents: 8 }, clock += 1),
  ]);

  const feed = page.getByTestId('studio-chat-feed');
  await expect(feed.getByText('Two harbour frames are on the way.', { exact: true })).toHaveCount(1);
  const trace = feed.getByTestId('agent-run-trace');
  const toggle = trace.locator(':scope > button');
  await expect(toggle).toHaveText('Worked for 7s · 1 step');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(trace.getByTestId('agent-run-trace-steps')).toHaveCount(0);
  await expect(feed.getByText('Two wide frames first, then pick one.', { exact: true })).toHaveCount(0);
  await expect(feed.getByText(prompt, { exact: true })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const steps = trace.getByTestId('agent-run-trace-steps');
  await expect(steps).toBeVisible();
  await expect(steps.getByText('Two wide frames first, then pick one.', { exact: true })).toBeVisible();
  const step = steps.getByTestId('agent-run-step');
  await expect(step).toHaveAttribute('data-status', 'done');
  await expect(step).toContainText('Generate image');
  await expect(step).toContainText('4s');
  await expect(step).toContainText('Queued two images.');
  await expect(step.getByText(prompt, { exact: true })).toBeVisible();
  // jsonb keeps its own key order, so each row is checked on its own.
  await expect(step.locator('dl > div')).toHaveCount(2);
  await expect(step.locator('dl')).toHaveText('Aspect ratio16:9Count2');
  await expect(steps).toContainText('Agent model Gemini 3.1 Pro, high thinking');

  await toggle.click();
  await expect(trace.getByTestId('agent-run-trace-steps')).toHaveCount(0);
});

test('Agents chat: at phone width the header, mode tabs and composer fit without sideways scrolling', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAgents(page, context, baseURL, 'Agents chat phone');
  const header = page.getByTestId('agents-header');
  await expect(header.getByTestId('agents-chat-name')).toBeInViewport();
  await expect(header.getByTestId('agents-destination')).toBeInViewport({ ratio: 1 });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of ['image', 'video', 'upscale']) {
      await selectMode(page, id);
      await expect(page.getByRole('tablist', { name: 'Mode' })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: /^Agent model: / })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      // The model and its settings share one row with Send.
      const settings = page.getByRole('button', { name: id === 'upscale' ? 'Upscale settings' : 'Generation settings', exact: true });
      const [model, gear, sendBox] = await Promise.all([modelOf(page).boundingBox(), settings.boundingBox(),
        page.getByRole('button', { name: 'Send', exact: true }).boundingBox()]);
      for (const box of [gear, sendBox]) expect(Math.abs((box.y + box.height / 2) - (model.y + model.height / 2))).toBeLessThanOrEqual(4);
    }
  }
  // Open, the composer also shows its draft buttons, on the agent model's line.
  await page.getByPlaceholder(/Talk through your/).click();
  for (const name of ['New / Clear', 'Recent submission']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
