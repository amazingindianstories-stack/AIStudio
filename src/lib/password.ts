import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Pure password hashing (scrypt, no dependency, no Next imports) so it can be
 * used both in server routes and in the standalone seed script.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(
  password: string,
  hash: string,
  salt: string
): boolean {
  const candidate = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}
