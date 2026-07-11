import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/** Returns a user-facing validation error, or null when the password is valid. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be no more than ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

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
  try {
    const candidate = scryptSync(password, salt, 64);
    const known = Buffer.from(hash, "hex");
    return candidate.length === known.length && timingSafeEqual(candidate, known);
  } catch {
    return false;
  }
}
