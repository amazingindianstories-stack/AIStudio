/** Keep the post-login destination on the frontend that authenticated the user. */
export function loginNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return '/';
  const target = new URL(value, 'https://frontend.invalid');
  if (target.origin !== 'https://frontend.invalid') return '/';
  return target.pathname + target.search + target.hash;
}

/** `/login` that returns to the current page after sign-in; the root view needs no `next`. */
export function loginUrlFor(location) {
  const next = `${location.pathname}${location.search ?? ''}`;
  return next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
