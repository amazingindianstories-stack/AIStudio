import { redirect } from "next/navigation";
import { currentDjangoUser } from "@/lib/server-session";
import { AdminDashboard } from "@/components/AdminDashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const me = await currentDjangoUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  return <AdminDashboard />;
}
