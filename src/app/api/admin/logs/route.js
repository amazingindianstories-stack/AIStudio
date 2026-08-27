import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import {
  MAX_CSV_ROWS,
  decodeCursor,
  parseAdminLogFilter,
  queryAdminLogs,
  readAdminLogsForExport,
} from "@/lib/admin-logs";

export const runtime = "nodejs";

/**
 * The admin generation log, paged and filtered server-side.
 *
 * Split out of /api/admin/data because the two have different shapes and
 * lifetimes: the dashboard's users/pricing/stats/activity load once on open and
 * are small, while the log is large, browsed, and only wanted on the Logs tab.
 * Bundling them is what made opening the dashboard cost 2.2 MB.
 */
export async function GET(req) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const params = req.nextUrl.searchParams;
  const filter = parseAdminLogFilter(params);

  if (params.get("format") === "csv") {
    return csvResponse(filter);
  }

  const limit = Number(params.get("limit")) || 100;
  const page = await queryAdminLogs(filter, decodeCursor(params.get("cursor")), limit);
  return NextResponse.json(page);
}

/** Minimal RFC 4180 quoting: only fields containing a comma, quote or newline
 *  need wrapping, and an embedded quote doubles. Prompts contain all three, so
 *  this is applied to every cell rather than just the prompt — the previous
 *  client-side export quoted only the prompt column. */
function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function csvResponse(filter) {
  const db = await getDb();
  const [rows, userRows] = await Promise.all([
    readAdminLogsForExport(filter),
    db.select({ id: users.id, email: users.email }).from(users),
  ]);
  const emailById = new Map(userRows.map((u) => [u.id, u.email]));

  const header = ["time", "user", "kind", "model", "status", "cost_cents", "cost_basis", "prompt"];
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        new Date(r.createdAt).toISOString(),
        emailById.get(r.userId ?? "") ?? "",
        r.kind,
        r.model,
        r.status,
        r.costCents,
        r.costBasis,
        r.prompt,
      ]
        .map(csvCell)
        .join(",")
    ),
  ];
  // Truncation used to be signalled with an appended `# truncated at...`
  // comment line. RFC 4180 has no comment syntax, so every real parser
  // (Excel, pandas, Sheets) either errors or reads it as a malformed final
  // row with the wrong column count — the file itself must stay pure CSV.
  // A response header carries the same information losslessly instead.
  const truncated = rows.length === MAX_CSV_ROWS;

  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="veevee-logs-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
      "X-Logs-Truncated": String(truncated),
      ...(truncated ? { "X-Logs-Truncated-At": String(MAX_CSV_ROWS) } : {}),
    },
  });
}
