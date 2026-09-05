import { useEffect, useState } from "react";
import { AdminDashboard } from "@/components/AdminDashboard";
import { apiFetch, parseApiResponse } from "@/lib/api";

export default function AdminPage() {
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch("/api/auth/me", { cache: "no-store" })
      .then(parseApiResponse)
      .then((result) => {
        const user = result.ok ? result.data?.user : null;
        if (!user) window.location.replace("/login?next=%2Fadmin");
        else if (user.role !== "admin") window.location.replace("/");
        else if (active) setAuthorized(true);
      })
      .catch(() => window.location.replace("/login?next=%2Fadmin"));
    return () => { active = false; };
  }, []);

  return authorized ? <AdminDashboard /> : <div className="min-h-[100dvh] bg-ink-900" />;
}
