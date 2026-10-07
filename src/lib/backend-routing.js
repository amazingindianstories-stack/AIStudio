// Server-only method routing. Browser API URLs remain same-origin /api.
const IMPLEMENTED_METHODS = new Set(['GET /api/settings']);

export function djangoDestination(requestUrl, method, configuration = {}) {
  const selected = new Set((configuration.methods || '').split(',').map(value => value.trim()).filter(Boolean));
  const request = new URL(requestUrl);
  const key = `${method.toUpperCase()} ${request.pathname}`;
  if (!selected.has(key)) return null;
  if (!IMPLEMENTED_METHODS.has(key)) throw new Error('Unqualified Django route selection');
  const origin = new URL(configuration.origin);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Django API origin must be a bare origin');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(configuration.allowLocal === '1' && local && origin.protocol === 'http:')) throw new Error('Django API requires HTTPS');
  if (origin.origin === request.origin) throw new Error('Django routing would loop');
  return new URL(request.pathname + request.search, origin.origin);
}
