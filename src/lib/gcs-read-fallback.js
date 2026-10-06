/** Resolve legacy media without migrating keys or allowing fallback writes.
 * Only a primary miss triggers fallback; authorization/network failures remain
 * failures. An unset fallback performs no extra storage lookup. */
export async function resolveGcsReadFile(key, {
  primaryBucket,
  fallbackBucket,
  fileFor,
  isProtected = () => false,
}) {
  const primary = fileFor(primaryBucket, key);
  if (!fallbackBucket || fallbackBucket === primaryBucket || isProtected(key)) return primary;
  const [exists] = await primary.exists();
  return exists ? primary : fileFor(fallbackBucket, key);
}
