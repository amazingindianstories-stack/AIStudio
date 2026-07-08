import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AdminDashboard } from "@/components/AdminDashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const me = await getSession();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  return <AdminDashboard />;
}
