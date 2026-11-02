import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

// Board "Create with AI" quality: a colour the artist names for sticky notes is the colour the notes get (black,
// other named colours, hex), for a new batch and for a refinement, and an image asked for on the board reaches the
// provider as the same request the normal generator sends (same words, model, references and aspect ratio). Run with `scripts/dev/browser-harness.py --fake-providers`;
// the fake provider answers a colour request the way a model does, with the colour the response schema lets it say.

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const FAKE = process.env.E2E_FAKE_PROVIDER_URL;

async function authenticate(context, baseURL) {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  await context.addCookies([{ name: 'veevee_session', value: `${payload}.${signature}`, url: baseURL }]);
}

async function freshProject(context, page) {
  const response = await context.request.post('/api/projects', { data: { op: 'createProject', name: `Board AI quality ${randomUUID()}` },
    headers: { Origin: process.env.E2E_BASE_URL } });
  expect(response.ok()).toBeTruthy();
  const { project } = await response.json();
  await page.addInitScript(projectId => {
    const key = 'veevee-draft-settings-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ activeProjectId: projectId }));
    localStorage.setItem('veevee.board.viewPrefs', JSON.stringify({ navigationMode: 'trackpad' }));
  }, project.id);
  return project.id;
}

const fakeState = async () => (await fetch(`${FAKE}/state`)).json();

test('Create with AI honours the colour asked for: black, a named colour and a hex, new and refined; its image request matches the generator\'s', async ({ page, context, baseURL }) => {
  test.skip(!FAKE, 'needs --fake-providers');
  test.setTimeout(240000);
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await authenticate(context, baseURL);
  const projectId = await freshProject(context, page);
  let boardId;
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
    await expect.poll(async () => {
      boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${projectId}`)).json()).boards[0]?.id;
      return Boolean(boardId);
    }).toBeTruthy();
    const nodes = async () => (await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data.nodes;
    const stickies = async () => (await nodes()).filter(node => node.type === 'sticky');

    await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Create with AI' });
    await expect(panel).toBeVisible();
    const generate = panel.getByRole('button', { name: 'Generate', exact: true });

    // A new batch in black.
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('Three black sticky notes with shot ideas');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await generate.click();
    await expect(panel.getByText(/Refining \d+ sticky notes?:/)).toBeVisible({ timeout: 60000 });
    await expect.poll(async () => (await stickies()).length, { timeout: 30000 }).toBe(3);
    const black = await stickies();
    expect(black.map(node => node.fill)).toEqual(['#1a1a1a', '#1a1a1a', '#1a1a1a']);
    // Dark notes get light text, so the words stay readable.
    expect(black.map(node => node.color)).toEqual(['#f5f5f5', '#f5f5f5', '#f5f5f5']);

    // Refining: the same notes, recoloured.
    const refinement = panel.getByRole('textbox', { name: 'Refinement' });
    await refinement.fill('change the colour of the notes to teal');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await refinement.press('Enter');
    await expect.poll(async () => (await stickies()).every(node => node.fill === '#5fb3a8') && (await stickies()).length === 3, { timeout: 60000 }).toBeTruthy();
    expect((await stickies()).map(node => node.color)).toEqual(['#1c1a12', '#1c1a12', '#1c1a12']);

    await refinement.fill('change the colour of the notes to black');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await refinement.press('Enter');
    await expect.poll(async () => (await stickies()).length === 3 && (await stickies()).every(node => node.fill === '#1a1a1a'), { timeout: 60000 }).toBeTruthy();

    // A colour the palette has no name for, as a hex.
    await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('Three sticky notes in #ff00aa');
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await generate.click();
    await expect(panel.getByText(/Refining \d+ sticky notes?:/)).toBeVisible({ timeout: 60000 });
    await expect.poll(async () => (await stickies()).filter(node => node.fill === '#ff00aa').length, { timeout: 30000 }).toBe(3);

    // An image: the request the provider gets for the board panel is the one the normal generator sends for the same words.
    const prompt = 'A lighthouse at dusk in heavy fog, painted in thick oil';
    await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
    await panel.getByRole('radio', { name: 'Image' }).click();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill(prompt);
    await panel.getByRole('radio', { name: '16:9' }).click();
    await expect(panel.getByText(/Estimated cost ≈\$\d+\.\d\d/)).toBeVisible();
    await generate.click();
    await expect.poll(async () => (await nodes()).filter(node => node.type === 'image').length, { timeout: 90000 }).toBe(1);
    const generated = await context.request.post('/api/generate/image', {
      data: { prompt, model: 'Nano Banana Pro', aspectRatio: '16:9', resolution: '2K', projectId },
      headers: { Origin: process.env.E2E_BASE_URL, 'Idempotency-Key': randomUUID() } });
    expect(generated.ok()).toBeTruthy();
    const { id: libraryId } = await generated.json();
    await expect.poll(async () => (await fakeState()).image_requests.filter(request => request.texts.includes(prompt)).length, { timeout: 90000 }).toBe(2);
    const [board, library] = (await fakeState()).image_requests.filter(request => request.texts.includes(prompt));
    console.log('IMAGE_REQUESTS ' + JSON.stringify({ board, library }));
    expect(board.texts).toEqual(library.texts);
    expect(board.model).toBe(library.model);
    expect(board.images).toBe(library.images);
    // Basic processing asks for the model's default resolution (1K); the library's default is 2K, which Advanced matches. The
    // aspect ratio, and everything the model reads, are the same.
    expect(board.imageConfig).toEqual({ ...library.imageConfig, imageSize: '1K' });
    await db`DELETE FROM generations WHERE id = ${libraryId}`;
  } finally {
    if (boardId) {
      const generations = await db`SELECT generation_id FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      await db`DELETE FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      for (const row of generations) await db`DELETE FROM generations WHERE id = ${row.generation_id}`;
    }
  }
});

test('Create with AI recolours the notes already selected on the board: black from the menu, a hex from the prompt, a typed request in any format, one undo step each', async ({ page, context, baseURL }) => {
  test.skip(!FAKE, 'needs --fake-providers');
  test.setTimeout(240000);
  await authenticate(context, baseURL);
  const projectId = await freshProject(context, page);
  let boardId;
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
    await expect.poll(async () => {
      boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${projectId}`)).json()).boards[0]?.id;
      return Boolean(boardId);
    }).toBeTruthy();
    const stickies = async () => (await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data.nodes.filter(node => node.type === 'sticky');

    await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Create with AI' });
    await panel.getByRole('button', { name: 'Questions to ask before a location scout' }).click();
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await stickies()).length, { timeout: 60000 }).toBe(3);
    const originalText = (await stickies()).map(node => node.text);

    // Select the notes and pick Change colour > Black: the prompt says so; the person presses Generate.
    await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ControlOrMeta+a');
    await expect(panel.getByLabel('Selection', { exact: true })).toContainText('3 selected');
    await panel.getByRole('button', { name: 'Change colour', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Black', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'Prompt' })).toHaveValue(/colour .* to black/);
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await stickies()).map(node => node.fill), { timeout: 60000 }).toEqual(['#1a1a1a', '#1a1a1a', '#1a1a1a']);
    expect((await stickies()).map(node => node.color)).toEqual(['#f5f5f5', '#f5f5f5', '#f5f5f5']);
    expect((await stickies()).map(node => node.text)).toEqual(originalText);

    // One undo step puts the colours back.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await stickies()).every(node => node.fill !== '#1a1a1a'), { timeout: 30000 }).toBeTruthy();

    // A colour typed in the prompt, a hex the palette has no name for.
    await page.keyboard.press('ControlOrMeta+a');
    await panel.getByRole('button', { name: 'Change colour', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Teal', exact: true }).click();
    const prompt = panel.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Make these notes #ff00aa');
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await stickies()).map(node => node.fill), { timeout: 60000 }).toEqual(['#ff00aa', '#ff00aa', '#ff00aa']);

    // Typed with the default Sticky notes format and no menu: the selected notes are recoloured, and no new notes are made.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ControlOrMeta+a');
    await expect(panel.getByLabel('Selection', { exact: true })).toContainText('3 selected');
    const stickiesFormat = panel.getByRole('radio', { name: 'Sticky notes' });
    await expect(stickiesFormat).toHaveAttribute('aria-checked', 'true');
    await prompt.fill('make these notes black');
    await expect(stickiesFormat).toHaveAttribute('aria-checked', 'false');
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await panel.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect.poll(async () => (await stickies()).map(node => node.fill), { timeout: 60000 }).toEqual(['#1a1a1a', '#1a1a1a', '#1a1a1a']);
    expect((await stickies()).map(node => node.color)).toEqual(['#f5f5f5', '#f5f5f5', '#f5f5f5']);
    expect((await stickies()).map(node => node.text)).toEqual(originalText);

    // The routing can be dismissed: the picked format is used again for the same words.
    await prompt.fill('make these notes black');
    await expect(stickiesFormat).toHaveAttribute('aria-checked', 'false');
    await panel.getByRole('button', { name: 'Change colour: keep the picked format instead' }).click();
    await expect(stickiesFormat).toHaveAttribute('aria-checked', 'true');
    await expect(prompt).toHaveValue('make these notes black');
    // The dismissal holds only for the words it was given for: a new recolour request is routed again.
    await prompt.fill('change the colour of these notes to red');
    await expect(stickiesFormat).toHaveAttribute('aria-checked', 'false');
    await expect(panel.getByRole('button', { name: 'Change colour: keep the picked format instead' })).toBeVisible();
  } finally {
    if (boardId) {
      const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
      const generations = await db`SELECT generation_id FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      await db`DELETE FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      for (const row of generations) await db`DELETE FROM generations WHERE id = ${row.generation_id}`;
    }
  }
});

test('a bare "a cat" from the panel makes a cat: a selected or refined picture without a person is context for the request, not a face to reproduce', async ({ page, context, baseURL }) => {
  test.skip(!FAKE, 'needs --fake-providers');
  test.setTimeout(300000);
  await authenticate(context, baseURL);
  const projectId = await freshProject(context, page);
  let boardId;
  try {
    // Every reference is reported as showing no person (a landscape, say); the library keeps its own behaviour for the same picture.
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ person_reference: false }) });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Desktop fixture/ })).toBeVisible();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByRole('application', { name: 'Board canvas' })).toBeVisible();
    await expect.poll(async () => {
      boardId = (await (await context.request.get(`/api/canvas-boards?projectId=${projectId}`)).json()).boards[0]?.id;
      return Boolean(boardId);
    }).toBeTruthy();
    const nodes = async () => (await (await context.request.get(`/api/canvas-boards/${boardId}`)).json()).data.nodes;
    const cats = async () => (await fakeState()).image_requests.filter(request => request.texts.some(text => text.includes('a cat')));
    const person = request => request.texts.some(text => /exact same individual|FINAL CHECK/.test(text));
    await page.getByRole('button', { name: 'Create with AI', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Create with AI' });
    const generate = panel.getByRole('button', { name: 'Generate', exact: true });

    // Nothing selected: the prompt alone.
    await panel.getByRole('radio', { name: 'Image' }).click();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('a cat');
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await generate.click();
    await expect.poll(async () => (await cats()).length, { timeout: 90000 }).toBe(1);
    expect((await cats())[0].images).toBe(0);
    await expect.poll(async () => (await nodes()).filter(node => node.type === 'image').length, { timeout: 90000 }).toBe(1);

    // The panel now refines the picture it placed: the picture is the reference, and "a cat" is what to add.
    await panel.getByRole('textbox', { name: 'Refinement' }).fill('a cat');
    await panel.getByRole('button', { name: 'Refine', exact: true }).click();
    await expect.poll(async () => (await cats()).length, { timeout: 90000 }).toBe(2);
    const refined = (await cats())[1];
    expect(refined.images).toBe(1);
    expect(person(refined)).toBe(false);
    expect(refined.texts[0]).toMatch(/^REFERENCE IMAGE \(1 image from the board\)/);
    expect(refined.texts).toContain('SCENE: a cat');

    // A new prompt with that picture still selected: it is attached as a reference by default, and still not a face to copy.
    await panel.getByRole('button', { name: 'New prompt', exact: true }).click();
    await panel.getByRole('radio', { name: 'Image' }).click();
    await panel.getByRole('textbox', { name: 'Prompt' }).fill('a cat');
    await expect(panel.getByLabel('Selection', { exact: true })).toContainText('Use selection as context');
    await expect(panel.getByText(/Estimated cost/)).toBeVisible();
    await generate.click();
    await expect.poll(async () => (await cats()).length, { timeout: 90000 }).toBe(3);
    const selected = (await cats())[2];
    expect(selected.images).toBe(1);
    expect(person(selected)).toBe(false);
    expect(selected.texts).toContain('SCENE: a cat');

    // The same words with the same picture through the library keep the library's identity framing.
    const reference = (await nodes()).find(node => node.type === 'image').src;
    const generated = await context.request.post('/api/generate/image', {
      data: { prompt: 'a cat', model: 'Nano Banana Pro', aspectRatio: '1:1', resolution: '2K', projectId, referenceImages: [reference] },
      headers: { Origin: process.env.E2E_BASE_URL, 'Idempotency-Key': randomUUID() } });
    expect(generated.ok()).toBeTruthy();
    await expect.poll(async () => (await cats()).length, { timeout: 90000 }).toBe(4);
    expect(person((await cats())[3])).toBe(true);
  } finally {
    await fetch(`${FAKE}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ person_reference: null }) });
    if (boardId) {
      const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
      const generations = await db`SELECT generation_id FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      await db`DELETE FROM canvas_board_ai_jobs WHERE board_id = ${boardId}`;
      for (const row of generations) await db`DELETE FROM generations WHERE id = ${row.generation_id}`;
    }
  }
});
