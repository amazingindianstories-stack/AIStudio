import { cookies } from "next/headers";
import { fetchDjangoSession } from "./backend-routing";

/** Server components forward cookies; they hold no signing key or database. */
export async function currentDjangoUser() {
  const jar = await cookies();
  return fetchDjangoSession(jar.toString(), {
    origin: process.env.DJANGO_API_ORIGIN,
    ingressSecret: process.env.GOAL4_PRIVATE_INGRESS_SECRET,
    allowLocal: process.env.DJANGO_API_ALLOW_LOCAL,
  });
}
