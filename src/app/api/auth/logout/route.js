import { successResponse } from "@/lib/api-response";
import { getSession, SESSION_COOKIE } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST() {
  const user = await getSession();
  if (user) await logActivity(user.id, "logout");
  const res = successResponse(null);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
