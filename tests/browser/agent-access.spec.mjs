import { test, expect } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { fixtureDatabase } from './fixture-db.mjs';

const USER_ID = 'e33e1832-9e29-427f-af61-796b842a4b37';
const CALLBACK = 'http://127.0.0.1:47823/callback';

function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ uid: USER_ID, ver: 0, exp: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')}`;
}

async function resetAgentAccess() {
  const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
  await db.transaction([
    db.statement`DELETE FROM mcp_tokens WHERE user_id = ${USER_ID}`,
    db.statement`DELETE FROM mcp_auth_codes WHERE user_id = ${USER_ID}`,
    db.statement`DELETE FROM mcp_clients`,
    db.statement`DELETE FROM mcp_rate_windows`,
    db.statement`DELETE FROM user_limits WHERE user_id = ${USER_ID} AND key LIKE ${'mcp%'}`,
  ]);
}

async function signIn(page, context, baseURL, width) {
  await context.addCookies([{ name: 'veevee_session', value: sessionCookie(), url: baseURL }]);
  await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
}

/** Nothing spills sideways: the page and every visible element inside `root` stay within the viewport. */
async function pixelClean(page, root) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const overflowing = await root.evaluate((element) => [...element.querySelectorAll('*')].filter((node) => {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(node).visibility === 'hidden') return false;
    return box.left < -0.5 || box.right > innerWidth + 0.5 || node.scrollWidth > node.clientWidth + 1 &&
      !['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowX) && getComputedStyle(node).textOverflow !== 'ellipsis';
  }).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`));
  expect(overflowing).toEqual([]);
}

/** Waits until a framer-motion height animation has finished, so screenshots show the settled layout. */
async function settled(locator) {
  let previous = null;
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    const same = previous && box && Math.abs(box.height - previous.height) < 0.5 && Math.abs(box.y - previous.y) < 0.5;
    previous = box;
    return Boolean(same);
  }, { intervals: [100] }).toBe(true);
}

async function openAgentTab(page) {
  await page.goto('/');
  const phone = page.viewportSize().width < 768;
  await page.getByRole('button', { name: phone ? 'D' : /Desktop fixture/, exact: phone }).click();
  await page.getByRole('menuitem', { name: 'Account settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Account settings' });
  await dialog.getByRole('tab', { name: 'Agent access' }).click();
  return dialog;
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function form(baseURL, path, values) {
  const response = await fetch(new URL(path, baseURL), { method: 'POST', body: new URLSearchParams(values),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return { status: response.status, body: await response.json() };
}

async function bearerMe(baseURL, token) {
  return fetch(new URL('/api/mcp/me', baseURL), { headers: { Authorization: `Bearer ${token}` } });
}

for (const width of [1440, 1024, 390]) {
  test(`Agent access: admin opt-in and personal access tokens at ${width}`, async ({ page, context, baseURL }, info) => {
    await resetAgentAccess();
    await signIn(page, context, baseURL, width);

    let dialog = await openAgentTab(page);
    await expect(dialog.getByText('Agent access is off for your account')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'New token' })).toHaveCount(0);
    await expect(dialog.getByText(`${baseURL}/mcp`)).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent-access-off.png') });
    await pixelClean(page, dialog);

    await page.goto('/admin');
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByRole('button', { name: 'Limits for Desktop fixture' }).filter({ visible: true }).click();
    const limits = page.getByRole('dialog', { name: 'Limits for Desktop fixture' });
    const toggle = limits.getByRole('switch', { name: 'Agent access (MCP)' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(limits.getByText('Agent daily spend limit')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The switch animates its knob and colour; finish that transition so the screenshot shows the settled state.
    await page.screenshot({ path: info.outputPath('admin-agent-access.png'), animations: 'disabled' });
    await pixelClean(page, limits);

    dialog = await openAgentTab(page);
    await dialog.getByRole('button', { name: 'New token' }).click();
    const create = dialog.getByRole('form', { name: 'New personal access token' });
    await create.getByRole('textbox', { name: 'Name', exact: true }).fill('Claude Code on the studio Mac');
    await create.getByRole('textbox', { name: 'Daily limit', exact: true }).fill('7.5');
    await create.getByRole('textbox', { name: 'Auto-approve up to', exact: true }).fill('101');
    await create.getByRole('button', { name: 'Create token' }).click();
    await expect(create.getByText('Auto-approve must be 0 to 100 cents.')).toBeVisible();
    await create.getByRole('textbox', { name: 'Auto-approve up to', exact: true }).fill('15');
    await expect(create.getByText('Auto-approve must be 0 to 100 cents.')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('agent-token-form.png') });
    await pixelClean(page, dialog);
    await create.getByRole('button', { name: 'Create token' }).click();
    await expect(dialog.getByText('Copy your token now')).toBeVisible();
    await settled(dialog.getByRole('button', { name: 'I saved it' }));
    const token = (await dialog.locator('code').filter({ hasText: /^vv_pat_/ }).first().textContent()).trim();
    expect(token).toMatch(/^vv_pat_[A-Za-z0-9_-]{43}$/);
    await expect(dialog.getByText(`claude mcp add --transport http veevee ${baseURL}/mcp --header "Authorization: Bearer ${token}"`)).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent-token-revealed.png') });
    await pixelClean(page, dialog);
    await dialog.getByRole('button', { name: 'I saved it' }).click();
    await expect(dialog.getByText(token)).toHaveCount(0);
    const row = dialog.getByRole('listitem').filter({ hasText: 'Claude Code on the studio Mac' });
    await expect(row).toContainText(`vv_pat_…${token.slice(-4)}`);
    await expect(row).toContainText('$0.00 of $7.50 today · auto-approve 15¢');
    await expect(row).toContainText('Never used');
    await page.screenshot({ path: info.outputPath('agent-token-listed.png') });
    await pixelClean(page, dialog);

    // The token works through the same Next transport an agent uses.
    const me = await bearerMe(baseURL, token);
    expect(me.status).toBe(200);
    expect((await me.json()).caps).toEqual({ tokenDailyCapCents: 750, autoApproveCents: 15, userDailyCapCents: 2000, activeJobs: 4, confirmAtCents: 100 });

    // The token is never readable again, even after a reload.
    await page.reload();
    dialog = await openAgentTab(page);
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Claude Code on the studio Mac' })).toContainText('Used just now');
    expect(await page.content()).not.toContain(token);

    await dialog.getByRole('button', { name: 'Revoke Claude Code on the studio Mac' }).click();
    await dialog.getByRole('button', { name: 'Revoke now' }).click();
    await expect(dialog.getByText('No tokens yet.')).toBeVisible();
    const refused = await bearerMe(baseURL, token);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain(`resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`);
  });

  test(`Agent access: OAuth consent and a scripted PKCE client at ${width}`, async ({ page, context, baseURL, browser }, info) => {
    await resetAgentAccess();
    const db = fixtureDatabase(process.env.E2E_DATABASE_URL);
    await db`INSERT INTO user_limits (user_id, key, value, updated_at) VALUES (${USER_ID}, ${'mcpEnabled'}, ${'true'}, ${1})`;

    // Discovery, exactly as an MCP client does it from the server address.
    const resource = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', baseURL))).json();
    expect(resource).toMatchObject({ resource: `${baseURL}/mcp`, authorization_servers: [baseURL] });
    const server = await (await fetch(new URL('/.well-known/oauth-authorization-server', baseURL))).json();
    expect(server).toMatchObject({ issuer: baseURL, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    const registered = await fetch(server.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Scripted PKCE client', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = await registered.json();

    const { verifier, challenge } = pkce();
    const state = randomBytes(12).toString('hex');
    const authorize = `${server.authorization_endpoint}?${new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: CALLBACK, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'veevee.read veevee.generate',
      resource: resource.resource })}`;

    // Signed out, the consent request survives the sign-in round trip.
    const anonymous = await browser.newContext({ baseURL, viewport: { width, height: width < 768 ? 844 : 1000 } });
    const signedOut = await anonymous.newPage();
    await signedOut.goto(authorize);
    await expect(signedOut).toHaveURL(/\/login\?next=/);
    await signedOut.getByPlaceholder('you@example.com').fill('desktop-browser@example.test');
    await signedOut.locator('input[type=password]').fill('LocalBrowserFixture!42');
    await signedOut.getByRole('button', { name: /Sign in/ }).click();
    await expect(signedOut.getByRole('heading', { name: 'Scripted PKCE client wants to use your Veevee account' })).toBeVisible();
    expect(new URL(signedOut.url()).searchParams.get('code_challenge')).toBe(challenge);
    await anonymous.close();

    await signIn(page, context, baseURL, width);
    const callbacks = [];
    await page.route('http://127.0.0.1:47823/**', (route) => {
      callbacks.push(new URL(route.request().url()));
      return route.fulfill({ status: 200, contentType: 'text/plain', body: 'Signed in. You can close this tab.' });
    });
    // The route sees the callback before the browser commits that navigation; wait for the commit so the
    // next page.goto is not interrupted by it.
    const reachedCallback = async (count) => {
      await expect.poll(() => callbacks.length).toBe(count);
      await page.waitForURL((url) => url.origin === 'http://127.0.0.1:47823');
    };
    await page.goto(authorize);
    const card = page.getByRole('main');
    await expect(card.getByRole('heading', { name: 'Scripted PKCE client wants to use your Veevee account' })).toBeVisible();
    await expect(card.getByText('127.0.0.1:47823', { exact: true })).toBeVisible();
    await expect(card.getByRole('checkbox', { name: /Browse the library/ })).toBeChecked();
    await expect(card.getByRole('checkbox', { name: /Create images and videos/ })).toBeChecked();
    await expect(card.getByRole('checkbox', { name: /Admin reports/ })).not.toBeChecked();
    await expect(card.getByRole('textbox', { name: 'Daily limit for this app', exact: true })).toHaveValue('10');
    await expect(card.getByRole('textbox', { name: 'Auto-approve up to', exact: true })).toHaveValue('25');
    await page.screenshot({ path: info.outputPath('consent.png'), fullPage: true });
    await pixelClean(page, card);
    await card.getByRole('textbox', { name: 'Daily limit for this app', exact: true }).fill('25');
    await card.getByRole('button', { name: 'Allow' }).click();
    await expect(card.getByText('Choose a daily limit up to $20.00.')).toBeVisible();
    await pixelClean(page, card);
    await card.getByRole('textbox', { name: 'Daily limit for this app', exact: true }).fill('5');
    await card.getByRole('textbox', { name: 'Auto-approve up to', exact: true }).fill('10');
    await card.getByRole('button', { name: 'Allow' }).click();
    await reachedCallback(1);
    const callback = callbacks[0];
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.searchParams.get('iss')).toBe(baseURL);
    const code = callback.searchParams.get('code');

    const wrongVerifier = await form(baseURL, server.token_endpoint, { grant_type: 'authorization_code', client_id: clientId, code,
      redirect_uri: CALLBACK, code_verifier: pkce().verifier, resource: resource.resource });
    expect(wrongVerifier).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });

    // The failed attempt consumed that code; consent again for a fresh one.
    await page.goto(authorize);
    await card.getByRole('button', { name: 'Allow' }).click();
    await reachedCallback(2);
    const issued = await form(baseURL, server.token_endpoint, { grant_type: 'authorization_code', client_id: clientId,
      code: callbacks[1].searchParams.get('code'), redirect_uri: CALLBACK, code_verifier: verifier, resource: resource.resource });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'veevee.read veevee.generate' });
    const me = await bearerMe(baseURL, issued.body.access_token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ kind: 'oauth', clientName: 'Scripted PKCE client', caps: { tokenDailyCapCents: 1000, autoApproveCents: 25 } });

    const rotated = await form(baseURL, server.token_endpoint, { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: issued.body.refresh_token });
    expect(rotated.status).toBe(200);
    expect((await bearerMe(baseURL, rotated.body.access_token)).status).toBe(200);

    const dialog = await openAgentTab(page);
    const app = dialog.getByRole('listitem').filter({ hasText: 'Scripted PKCE client' });
    await expect(app).toContainText('Browse the library');
    await expect(app).toContainText('$0.00 of $10.00 today · auto-approve 25¢');
    await page.screenshot({ path: info.outputPath('connected-apps.png') });
    await pixelClean(page, dialog);

    // Reusing the rotated refresh token revokes the whole connection.
    const reused = await form(baseURL, server.token_endpoint, { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: issued.body.refresh_token });
    expect(reused).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await bearerMe(baseURL, rotated.body.access_token)).status).toBe(401);
    await page.reload();
    const reloaded = await openAgentTab(page);
    await expect(reloaded.getByText('No connected apps.')).toBeVisible();

    // A third connection is revoked from Settings, and a denial goes back to the app as access_denied.
    await page.goto(authorize);
    await card.getByRole('button', { name: 'Allow' }).click();
    await reachedCallback(3);
    const third = await form(baseURL, server.token_endpoint, { grant_type: 'authorization_code', client_id: clientId,
      code: callbacks[2].searchParams.get('code'), redirect_uri: CALLBACK, code_verifier: verifier });
    expect(third.status).toBe(200);
    const settings = await openAgentTab(page);
    await settings.getByRole('button', { name: 'Revoke Scripted PKCE client' }).click();
    await settings.getByRole('button', { name: 'Revoke now' }).click();
    await expect(settings.getByText('No connected apps.')).toBeVisible();
    expect((await form(baseURL, server.token_endpoint, { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: third.body.refresh_token })).body.error).toBe('invalid_grant');

    await page.goto(authorize);
    await card.getByRole('button', { name: 'Deny' }).click();
    await reachedCallback(4);
    expect(callbacks[3].searchParams.get('error')).toBe('access_denied');

    // A request that cannot be trusted never redirects anywhere.
    await page.goto(authorize.replace(encodeURIComponent(CALLBACK), encodeURIComponent('http://127.0.0.1:1/evil')));
    await expect(page.getByRole('main').getByRole('alert')).toContainText('The redirect address does not match');
    await expect(page.getByRole('link', { name: 'Return to the app' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('consent-error.png') });
    await pixelClean(page, page.getByRole('main'));
  });
}
