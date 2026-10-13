import { cookies } from "next/headers";
import { fetchDjangoSession } from "./backend-routing";

/** Server components forward cookies; they hold no signing key or database. */
export async function currentDjangoUser() {
  const jar = await cookies();
  return fetchDjangoSession(jar.toString(), {
    origin: process.env.DJANGO_API_ORIGIN,
    allowLocal: process.env.DJANGO_API_ALLOW_LOCAL,
  });
}
