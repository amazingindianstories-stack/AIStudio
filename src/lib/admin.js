import { getSession, } from "./auth";

/** Returns the current user if they're an admin, else null. */
export async function adminOrNull() {
  const u = await getSession();
  return u && u.role === "admin" ? u : null;
}
