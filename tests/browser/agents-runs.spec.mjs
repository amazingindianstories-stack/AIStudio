import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// The Agents tab against Django with no agent worker: the composer starts a real run, then each test writes the
// events and run status the worker would write (through the test-only SQL bridge) and checks what the tab renders.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';

function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function openAgents(page, context, baseURL, label) {
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(), url: baseURL }]);
  const created = await context.request.post('/api/projects', { data: { op: 'createProject', name: `${label} ${randomUUID()}` },
    headers: { Origin: baseURL } });
  expect(created.ok()).toBeTruthy();
  const { project } = await created.json();
  await page.addInitScript((projectId) => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
  }, project.id);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
}

async function agentsTab(page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Loading chat…', { exact: true })).not.toBeVisible();
}

/** Sends `content` from the composer; resolves to the response body (201 starts a run, 202 queues it). */
async function send(page, content, status) {
  const input = page.getByPlaceholder(/Talk through your/);
  await expect(input).toBeEnabled();
  await input.fill(content);
  const answered = page.waitForResponse((response) => response.url().endsWith('/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(status);
  return response.json();
}

/** What the worker writes: events with the next seqs, and the run's status (always a newer updatedAt). */
function worker(runId) {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  let clock = Date.now();
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  const emit = (kind, payload = {}) => db.statement`
    INSERT INTO agent_run_events (run_id, seq, kind, payload, created_at)
    SELECT ${runId}::uuid, COALESCE(MAX(seq), 0) + 1, ${kind}, ${JSON.stringify(payload)}::jsonb, ${tick()}
    FROM agent_run_events WHERE run_id = ${runId}`;
  const status = (value, { pauseReason = null, resumeAfter = null, error = null, cancelJobs = false, steps = 0 } = {}) => {
    const now = tick();
    const finished = ['completed', 'failed', 'cancelled'].includes(value) ? now : null;
    return db.statement`
      UPDATE agent_runs SET status = ${value}, pause_reason = ${pauseReason}, resume_after = ${resumeAfter},
        error = ${error === null ? null : JSON.stringify(error)}::jsonb, cancel_jobs = cancel_jobs OR ${cancelJobs},
        step_count = GREATEST(step_count, ${steps}), started_at = COALESCE(started_at, ${now}), finished_at = ${finished},
        updated_at = ${now}
      WHERE id = ${runId}`;
  };
  /** A tool step parked on a quote, as runner.finish_tool_result journals it, so approve and decline find it. */
  const quoteStep = (stepIndex, tool, args, quote) => db.statement`
    INSERT INTO agent_run_steps (run_id, step_index, kind, tool_name, input_hash, status, outcome, result, started_at, finished_at)
    VALUES (${runId}, ${stepIndex}, 'tool', ${tool}, 'browser-fixture', 'finished', 'quote_required',
      ${JSON.stringify({ call: { name: tool, args }, quote: { token: 'browser-fixture', ...quote } })}::jsonb, ${tick()}, ${tick()})`;
  /** A saved message as the runner writes it: a reply carries its `stepIndex`, a message read from the inbox its `deliveredStep`. */
  const message = (conversationId, role, content, trace) => db.statement`
    INSERT INTO agent_conversation_messages (conversation_id, role, content, tool_trace, created_at)
    VALUES (${conversationId}, ${role}, ${content}, ${JSON.stringify({ runId, ...trace })}::jsonb, ${tick()})`;
  return { db, emit, status, quoteStep, message, write: (statements) => db.transaction(statements), tick };
}

// A run a test leaves active holds one of the fixture user's active-run slots (two by default), and with no worker
// nothing ends it, so the next test's send would be refused with 429. End them as the worker ends a stopped run.
test.afterEach(async () => {
  const now = Date.now();
  await fixtureDatabase(process.env.E2E_DATABASE_URL)`
    UPDATE agent_runs SET status = 'cancelled', finished_at = ${now}, updated_at = ${now}
    WHERE user_id = ${USER_ID} AND status IN ('queued', 'running', 'waiting_approval', 'waiting_jobs', 'paused_limit')`;
});

test('Agents runs: the feed renders model text, tool steps, jobs and a delivered message, and a reload resumes from the last seq', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run feed');
  const { run } = await send(page, 'Make a warm close-up portrait.', 201);
  const feed = page.getByTestId('studio-chat-feed');
  const panel = feed.getByTestId('agent-run');
  await expect(panel.getByTestId('agent-run-status')).toHaveText('Starting…');
  await expect(panel.getByTestId('agent-run-status')).toHaveAttribute('data-icon', 'spin');
  const queued = await send(page, 'Use a warmer palette.', 202);
  await expect(page.getByTestId('agent-queued-message')).toContainText('Use a warmer palette.');

  const fixture = worker(run.id);
  const job = randomUUID();
  await fixture.write([
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 0, kind: 'llm' }),
    fixture.db.statement`UPDATE agent_inbox SET delivered_at = ${fixture.tick()}, delivered_step = 0 WHERE id = ${queued.inbox.id}`,
    fixture.emit('message_delivered', { inboxId: queued.inbox.id, stepIndex: 0 }),
    fixture.emit('assistant_text', { stepIndex: 0, text: 'I will draft a warm close-up first.', final: false }),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('job_queued', { generationId: job, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'running', ok: true, summary: 'Queued one image.' }),
    fixture.emit('step_started', { stepIndex: 2, kind: 'tool', tool: 'generate_video' }),
    fixture.emit('tool_called', { stepIndex: 2, tool: 'generate_video', outcome: 'COST_LIMIT', ok: false, summary: 'That video would pass the run cost limit.' }),
    fixture.emit('waiting_jobs', { generationIds: [job] }),
    fixture.status('waiting_jobs', { steps: 3 }),
  ]);
  const expectLiveRun = async () => {
    await expect(panel.getByTestId('agent-run-status')).toHaveText('Waiting for 1 job to finish');
    await expect(page.getByTestId('agent-queued-message')).toHaveCount(0);
    await expect(panel.getByText('Use a warmer palette.', { exact: true })).toHaveCount(1);
    await expect(panel.getByText('I will draft a warm close-up first.', { exact: true })).toBeVisible();
    const steps = panel.getByTestId('agent-run-step');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toHaveAttribute('data-status', 'done');
    await expect(steps.nth(0)).toContainText('Generate image');
    await expect(steps.nth(0)).toContainText('Queued one image.');
    await expect(steps.nth(1)).toHaveAttribute('data-status', 'error');
    await expect(steps.nth(1)).toContainText('Failed: refused by a limit');
    await expect(steps.nth(1)).toContainText('That video would pass the run cost limit.');
  };
  await expectLiveRun();

  // A reload restores the saved events and polls from the last seq it read: run_queued, message_queued and the 10 above.
  const resumed = page.waitForRequest((request) => request.url().includes(`/runs/${run.id}/events?after=`));
  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  expect(new URL((await resumed).url()).searchParams.get('after')).toBe('12');
  await expectLiveRun();

  await fixture.write([
    fixture.emit('job_finished', { generationId: job, kind: 'image', status: 'succeeded', stepIndex: 3 }),
    fixture.emit('step_started', { stepIndex: 3, kind: 'llm' }),
    fixture.emit('assistant_text', { stepIndex: 3, text: 'Your warm close-up is ready.', final: true }),
    // The worker saves what the run read and its reply in the thread, which the tab re-reads once the run ends.
    fixture.message(run.conversationId, 'user', 'Use a warmer palette.', { deliveredStep: 0 }),
    fixture.message(run.conversationId, 'assistant', 'Your warm close-up is ready.', { stepIndex: 3 }),
    fixture.status('completed', { steps: 4 }),
    fixture.emit('completed', { steps: 4, costCents: 12 }),
  ]);
  await expect(panel.getByTestId('agent-run-status')).toHaveCount(0);
  await expect(panel.getByText('The image is ready. Check your library to view it.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  // The saved thread takes over the reply and the delivered message; neither shows twice.
  await expect(feed.getByText('Your warm close-up is ready.', { exact: true })).toHaveCount(1);
  await expect(feed.getByText('Use a warmer palette.', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('I will draft a warm close-up first.', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('agent-run-step')).toHaveCount(2);
});

/** Asserts that `texts` appear in the chat feed in this order (each at least once). */
async function expectInOrder(feed, texts) {
  await expect.poll(async () => {
    const shown = await feed.innerText();
    let from = 0;
    for (const text of texts) {
      const at = shown.indexOf(text, from);
      if (at < 0) return `missing in order: ${text}`;
      from = at + text.length;
    }
    return 'in order';
  }).toBe('in order');
}

test('Agents runs: every ended run keeps its activity in order after its message, live and after a reload, read once', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run history');
  const other = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Agents history elsewhere ${randomUUID()}` },
    headers: { Origin: baseURL } });
  expect(other.ok()).toBeTruthy();
  const elsewhere = (await other.json()).project.id;
  const feed = page.getByTestId('studio-chat-feed');

  const first = (await send(page, 'Make a moonlit harbour.', 201)).run;
  const failing = worker(first.id);
  const error = { code: 'MODEL_ERROR', message: 'The model could not answer. Try again in a minute.' };
  await failing.write([
    failing.emit('run_started'),
    failing.emit('step_started', { stepIndex: 0, kind: 'tool', tool: 'generate_image' }),
    failing.emit('tool_called', { stepIndex: 0, tool: 'generate_image', outcome: 'error', ok: false, summary: 'The provider refused the prompt.' }),
    failing.status('failed', { error, steps: 1 }),
    failing.emit('failed', error),
  ]);
  await expect(feed.getByRole('region', { name: 'Run failed' })).toHaveText(error.message);

  const second = (await send(page, 'Try a softer harbour.', 201)).run;
  const fixture = worker(second.id);
  const made = randomUUID();
  await fixture.write([
    fixture.db.statement`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, created_at, updated_at)
      SELECT ${made}, 'image', 'succeeded', 'Nano Banana Pro', 'Soft harbour', '1:1', url, ${USER_ID}, ${elsewhere}, 1000, 1000
      FROM generations WHERE id = '10000000-0000-4000-8000-000000000000'`,
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 0, kind: 'llm' }),
    fixture.emit('assistant_text', { stepIndex: 0, text: 'Trying a softer palette.', final: false }),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('job_queued', { generationId: made, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'running', ok: true, summary: 'Queued one image.' }),
    fixture.emit('job_finished', { generationId: made, kind: 'image', status: 'succeeded', stepIndex: 2 }),
    fixture.emit('step_started', { stepIndex: 2, kind: 'llm' }),
    fixture.emit('assistant_text', { stepIndex: 2, text: 'Your softer harbour is ready.', final: true }),
    fixture.message(second.conversationId, 'assistant', 'Your softer harbour is ready.', { stepIndex: 2 }),
    fixture.status('completed', { steps: 3 }),
    fixture.emit('completed', { steps: 3, costCents: 12 }),
  ]);
  const order = ['Make a moonlit harbour.', 'Generate image', 'Failed', 'The provider refused the prompt.', error.message,
    'Try a softer harbour.', 'Trying a softer palette.', 'Generate image', 'Done', 'Queued one image.', 'Your softer harbour is ready.'];
  const expectHistory = async () => {
    await expect(feed.getByTestId('agent-run-status')).toHaveCount(0);
    await expectInOrder(feed, order);
    await expect(feed.getByText('Your softer harbour is ready.', { exact: true })).toHaveCount(1);
    await expect(feed.getByRole('region', { name: 'Run failed' })).toHaveText(error.message);
    await expect(feed.locator(`[data-run-id="${first.id}"]`).getByTestId('agent-run-step')).toHaveAttribute('data-status', 'error');
    const done = feed.locator(`[data-run-id="${second.id}"]`).getByTestId('agent-run-step');
    await expect(done).toHaveAttribute('data-status', 'done');
    await expect(done.getByTestId(`media-card-${made}`).getByRole('img', { name: 'Soft harbour' })).toBeVisible();
  };
  await expectHistory();

  // After a reload each ended run's feed is read once and never polled.
  const reads = [];
  page.on('request', (request) => {
    const match = request.url().match(/\/runs\/([^/]+)\/events/);
    if (match) reads.push(match[1]);
  });
  // A short window makes the history taller than the feed: it opens on the newest reply although the feeds and media
  // arrive after the thread renders.
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  await expectHistory();
  await expect.poll(() => feed.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await expect.poll(() => feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await expect(feed.getByText('Your softer harbour is ready.', { exact: true })).toBeInViewport();
  await page.waitForTimeout(4000);
  expect(reads.sort()).toEqual([first.id, second.id].sort());
});

test('Agents runs: a succeeded job shows its media card even when the library has not loaded it, live and after a reload', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run media');
  // The generation lives in another project with an old timestamp: no loaded scope, page or live update holds it.
  const other = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Agents elsewhere ${randomUUID()}` },
    headers: { Origin: baseURL } });
  expect(other.ok()).toBeTruthy();
  const elsewhere = (await other.json()).project.id;
  const { run } = await send(page, 'Make a lantern still life.', 201);
  const panel = page.getByTestId('studio-chat-feed').getByTestId('agent-run');
  const fixture = worker(run.id);
  const made = randomUUID();
  const lost = randomUUID();
  const reads = [];
  page.on('request', (request) => { if (request.url().includes('/api/history?ids=')) reads.push(new URL(request.url()).searchParams.get('ids')); });
  await fixture.write([
    fixture.db.statement`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, created_at, updated_at)
      SELECT ${made}, 'image', 'succeeded', 'Nano Banana Pro', 'Lantern still life', '1:1', url, ${USER_ID}, ${elsewhere}, 1000, 1000
      FROM generations WHERE id = '10000000-0000-4000-8000-000000000000'`,
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('job_queued', { generationId: made, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('job_queued', { generationId: lost, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'running', ok: true, summary: 'Queued two images.' }),
    fixture.emit('job_finished', { generationId: made, kind: 'image', status: 'succeeded', stepIndex: 2 }),
    fixture.emit('job_finished', { generationId: lost, kind: 'image', status: 'failed', stepIndex: 2 }),
    fixture.emit('step_started', { stepIndex: 2, kind: 'llm' }),
    fixture.status('running', { steps: 3 }),
  ]);
  const card = panel.getByTestId(`media-card-${made}`);
  const expectResults = async () => {
    await expect(card.getByRole('img', { name: 'Lantern still life' })).toBeVisible();
    await expect(panel.getByText('The image failed.', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Check your library/)).toHaveCount(0);
  };
  await expectResults();
  expect(reads).toEqual([made]);

  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  await expectResults();
  // The card opens the viewer on the row it read.
  await card.click({ position: { x: 88, y: 24 } });
  await expect(page.locator('[data-viewer-item-id]').first()).toHaveAttribute('data-viewer-item-id', made);
});

test('Agents runs: a job still running when its run ended follows its generation to the media card, live and after a reload', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run outlived');
  const other = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Agents elsewhere ${randomUUID()}` },
    headers: { Origin: baseURL } });
  expect(other.ok()).toBeTruthy();
  const elsewhere = (await other.json()).project.id;
  const { run } = await send(page, 'Make a lantern video.', 201);
  const panel = page.getByTestId('studio-chat-feed').getByTestId('agent-run');
  const fixture = worker(run.id);
  const job = randomUUID();
  // A follow-up ended the run while the job was still rendering, so the feed never carries its job_finished.
  await fixture.write([
    fixture.db.statement`INSERT INTO generations (id, kind, status, model, prompt, aspect_ratio, url, user_id, project_id, created_at, updated_at)
      SELECT ${job}, 'image', 'running', 'Nano Banana Pro', 'Lantern at dusk', '1:1', url, ${USER_ID}, ${elsewhere}, 1000, ${fixture.tick()}
      FROM generations WHERE id = '10000000-0000-4000-8000-000000000000'`,
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('job_queued', { generationId: job, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'running', ok: true, summary: 'Lantern at dusk is rendering.' }),
    fixture.emit('step_started', { stepIndex: 2, kind: 'llm' }),
    fixture.emit('assistant_text', { stepIndex: 2, text: 'It is still rendering; it will land in your library.', final: true }),
    fixture.status('completed', { steps: 3 }),
    fixture.emit('completed', { steps: 3, costCents: 6 }),
  ]);
  await expect(panel.getByTestId('agent-run-step')).toHaveAttribute('data-status', 'done');
  const card = panel.getByTestId(`media-card-${job}`);
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: 'Lantern at dusk' })).toHaveCount(0);

  // The generation worker finishes it after the run ended: the card follows the row, not the run's feed.
  const finished = fixture.tick();
  await fixture.write([fixture.db.statement`UPDATE generations SET status = 'succeeded', updated_at = ${finished}, completed_at = ${finished} WHERE id = ${job}`]);
  await expect(card.getByRole('img', { name: 'Lantern at dusk' })).toBeVisible({ timeout: 15000 });

  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  await expect(panel.getByTestId(`media-card-${job}`).getByRole('img', { name: 'Lantern at dusk' })).toBeVisible();
});

test('Agents runs: a quote of $1.00 or more needs a second confirmation, and a declined quote says so', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run quotes');
  const { run } = await send(page, 'Make a slow dolly shot.', 201);
  const panel = page.getByTestId('studio-chat-feed').getByTestId('agent-run');
  const fixture = worker(run.id);
  const prompt = 'A slow dolly toward a lantern-lit doorway.';
  await fixture.write([
    fixture.quoteStep(1, 'generate_video', { prompt, duration: 5, aspectRatio: '16:9' },
      { costCents: 150, display: '$1.50', expiresAt: Date.now() + 600000, summary: 'One 5 second video.', requiresUserConfirmation: true }),
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_video' }),
    fixture.emit('quote_required', { stepIndex: 1, tool: 'generate_video', arguments: { prompt, duration: 5, aspectRatio: '16:9' }, prompt,
      quote: { costCents: 150, display: '$1.50', expiresAt: Date.now() + 600000, summary: 'One 5 second video.', requiresUserConfirmation: true } }),
    fixture.status('waiting_approval', { steps: 2 }),
  ]);
  const card = panel.getByRole('region', { name: 'Quote waiting for approval' });
  await expect(card).toContainText('Generate video costs $1.50');
  await expect(card).toContainText('One 5 second video.');
  await expect(card).toContainText(prompt);
  await expect(card.locator('dl')).toHaveText('Duration5sAspect ratio16:9');
  await expect(panel.getByTestId('agent-run-status')).toHaveText('Waiting for your approval');
  await expect(panel.getByTestId('agent-run-status')).toHaveAttribute('data-icon', 'clock');

  const approvals = [];
  page.on('request', (request) => { if (request.url().endsWith('/approve')) approvals.push(request.postDataJSON()); });
  await card.getByRole('button', { name: 'Approve $1.50', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('This costs $1.50. Confirm to spend it.');
  await card.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(card.getByRole('status')).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve $1.50', exact: true }).click();
  expect(approvals).toEqual([]);
  const approved = page.waitForResponse((response) => response.url().endsWith('/approve'));
  await card.getByRole('button', { name: 'Confirm $1.50', exact: true }).click();
  const approval = await approved;
  expect(approval.status()).toBe(200);
  expect(approval.request().postDataJSON()).toEqual({ stepIndex: 1 });
  await expect(card).toHaveCount(0);
  const steps = panel.getByTestId('agent-run-step');
  await expect(steps.nth(0)).toContainText('Approved $1.50.');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'running');

  // A cheaper quote approves in one click; this one is declined, after a first answer the run had already moved past.
  await fixture.write([
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_video', outcome: 'running', ok: true, summary: 'Queued one video.' }),
    fixture.quoteStep(2, 'generate_image', { prompt: 'A lantern still life.' },
      { costCents: 40, display: '$0.40', expiresAt: Date.now() + 600000, summary: 'One image.', requiresUserConfirmation: false }),
    fixture.emit('step_started', { stepIndex: 2, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('quote_required', { stepIndex: 2, tool: 'generate_image', arguments: { prompt: 'A lantern still life.' }, prompt: 'A lantern still life.',
      quote: { costCents: 40, display: '$0.40', expiresAt: Date.now() + 600000, summary: 'One image.', requiresUserConfirmation: false } }),
    fixture.status('running', { steps: 3 }),
  ]);
  await expect(card).toContainText('Generate image costs $0.40');
  await expect(card.getByRole('button', { name: 'Approve $0.40', exact: true })).toBeVisible();
  const refused = page.waitForResponse((response) => response.url().endsWith('/decline'));
  await card.getByRole('button', { name: 'Decline', exact: true }).click();
  expect((await refused).status()).toBe(409);
  await expect(card.getByRole('alert')).toHaveText('This quote is no longer waiting for approval.');

  await fixture.write([fixture.status('waiting_approval', { steps: 3 })]);
  await expect(panel.getByTestId('agent-run-status')).toHaveText('Waiting for your approval');
  const declined = page.waitForResponse((response) => response.url().endsWith('/decline'));
  await card.getByRole('button', { name: 'Decline', exact: true }).click();
  const decline = await declined;
  expect(decline.status()).toBe(200);
  expect(decline.request().postDataJSON()).toEqual({ stepIndex: 2 });
  await expect(card).toHaveCount(0);
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'declined');
  await expect(steps.nth(1)).toContainText('Declined.');
  expect(approvals).toEqual([{ stepIndex: 1 }]);
});

test('Agents runs: a paused run shows why and when it continues, and Stop and cancel jobs ends it', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run pause');
  const { run } = await send(page, 'Make three lantern variations.', 201);
  const panel = page.getByTestId('studio-chat-feed').getByTestId('agent-run');
  const fixture = worker(run.id);
  const job = randomUUID();
  const resumeAfter = Date.now() + 10 * 60000 + 30000;
  await fixture.write([
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 1, kind: 'tool', tool: 'generate_image' }),
    fixture.emit('job_queued', { generationId: job, kind: 'image', tool: 'generate_image', stepIndex: 1 }),
    fixture.emit('tool_called', { stepIndex: 1, tool: 'generate_image', outcome: 'running', ok: true, summary: 'Queued one image.' }),
    fixture.emit('paused', { reason: 'daily_cap', resumeAfter }),
    fixture.status('paused_limit', { pauseReason: 'daily_cap', resumeAfter, steps: 2 }),
  ]);
  const paused = panel.getByRole('region', { name: 'Run paused' });
  await expect(paused).toContainText('You reached your daily agent spending cap.');
  await expect(paused).toContainText(/It tries again in 1[01] minutes\./);
  await expect(panel.getByTestId('agent-run-status')).toHaveText('Paused');
  await expect(panel.getByTestId('agent-run-status')).toHaveAttribute('data-icon', 'pause');
  await expect(panel.getByTestId('agent-run-status').locator('.animate-spin')).toHaveCount(0);

  const stopped = page.waitForResponse((response) => response.url().endsWith('/cancel'));
  await panel.getByRole('button', { name: 'Stop and cancel jobs', exact: true }).click();
  const stop = await stopped;
  expect(stop.status()).toBe(202);
  expect(stop.request().postDataJSON()).toEqual({ cancelJobs: true });
  await expect(panel.getByTestId('agent-run-status')).toHaveText('Stopping…');
  await expect(panel.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

  await fixture.write([
    fixture.status('cancelled', { cancelJobs: true, steps: 2 }),
    fixture.emit('cancelled', { cancelJobs: true, jobs: [{ generationId: job, status: 'cancelled', message: null }] }),
  ]);
  const ended = panel.getByRole('region', { name: 'Run stopped' });
  await expect(ended).toHaveText('Stopped and cancelled 1 job.');
  await expect(panel.getByText('The image was cancelled.', { exact: true })).toBeVisible();
  await expect(paused).toHaveCount(0);
  await expect(panel.getByTestId('agent-run-status')).toHaveCount(0);

  // After a reload the stopped run still shows its steps and which jobs the stop cancelled.
  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  await expect(ended).toHaveText('Stopped and cancelled 1 job.');
  await expect(panel.getByTestId('agent-run-step')).toContainText('Queued one image.');
  await expect(panel.getByText('The image was cancelled.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('studio-chat-feed').getByText('Make three lantern variations.', { exact: true })).toHaveCount(1);
});

test('Agents runs: a failed run shows its error, during the run and after a reload', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run failure');
  const { run } = await send(page, 'Describe the lantern scene.', 201);
  const panel = page.getByTestId('studio-chat-feed').getByTestId('agent-run');
  const fixture = worker(run.id);
  const error = { code: 'MODEL_ERROR', message: 'The model could not answer. Try again in a minute.' };
  await fixture.write([
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 0, kind: 'llm' }),
    fixture.status('failed', { error, steps: 1 }),
    fixture.emit('failed', error),
  ]);
  const failed = panel.getByRole('region', { name: 'Run failed' });
  await expect(failed).toHaveText(error.message);
  await expect(panel.getByTestId('agent-run-status')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
  await agentsTab(page);
  await expect(failed).toHaveText(error.message);
  // The next message starts a new run.
  await send(page, 'Try again.', 201);
});

test('Agents runs: a run replaced before its feed was read keeps its activity, and a send answered after a chat switch stays in its chat', async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await openAgents(page, context, baseURL, 'Agents run handover');
  const feed = page.getByTestId('studio-chat-feed');
  // The first run's feed reads hang until the next message, so the run it ends with was never drained in the tab.
  const held = [];
  let holding = true;
  await page.route(/\/runs\/[^/]+\/events/, (route) => (holding ? held.push(route) : route.continue()));
  const first = (await send(page, 'Make a lighthouse.', 201)).run;
  const fixture = worker(first.id);
  const error = { code: 'MODEL_ERROR', message: 'The model could not answer. Try again in a minute.' };
  await fixture.write([
    fixture.emit('run_started'),
    fixture.emit('step_started', { stepIndex: 0, kind: 'llm' }),
    fixture.status('failed', { error, steps: 1 }),
    fixture.emit('failed', error),
  ]);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  holding = false;
  await send(page, 'Try a calmer lighthouse.', 201);
  for (const route of held) await route.abort().catch(() => {});
  await expect(feed.getByRole('region', { name: 'Run failed' })).toHaveText(error.message);
  await expectInOrder(feed, ['Make a lighthouse.', error.message, 'Try a calmer lighthouse.']);

  // A message whose answer arrives after the artist opened another chat is queued on its own chat's run only.
  await page.unroute(/\/runs\/[^/]+\/events/);
  let release;
  const answered = new Promise((resolve) => { release = resolve; });
  await page.route(/\/runs$/, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await answered;
    return route.continue();
  });
  const input = page.getByPlaceholder(/Talk through your/);
  await expect(input).toBeEnabled();
  await input.fill('Paint the lighthouse at dawn.');
  const started = page.waitForResponse((response) => response.url().endsWith('/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(feed.getByText('Make a lighthouse.', { exact: true })).toHaveCount(0);
  release();
  const response = await started;
  expect(response.status()).toBe(202);
  expect((await response.json()).run.conversationId).toBe(first.conversationId);
  await page.waitForTimeout(1500);
  await expect(feed.getByText('Paint the lighthouse at dawn.', { exact: true })).toHaveCount(0);
  await expect(feed.getByTestId('agent-run')).toHaveCount(0);
});
