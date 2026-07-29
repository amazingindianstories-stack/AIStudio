import { NextRequest, NextResponse } from "next/server";
import { countHistory, countScope } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { parseHistoryFilter } from "@/lib/history-query";

export const runtime = "nodejs";

/**
 * True counts for the scope bar and the folder rail.
 *
 * The folder rail used to count `items.filter(...)` over whatever slice of
 * global history the client had paged in, which is why a project holding
 * hundreds of assets displayed every folder as "0" until you had scrolled far
 * enough back. These are `count(*)` against the same predicates the feed uses,
 * so the number beside a folder always describes what clicking it will show.
 *
 * Deliberately a separate endpoint from the feed rather than a field on it:
 * counts change on scope/filter changes, the feed changes on every scroll, and
 * folding them together would recount the table on every page of an infinite
 * scroll for a number that did not move.
 */
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  // The folder dimension is what `countHistory` groups by, and the favourite
  // flag is its own scope — strip both so the shared parser's output describes
  // the surrounding scope rather than one row of the rail.
  const { folderId: _folder, favorite: _favorite, ...filter } = parseHistoryFilter(params);

  const [project, allAssets, favorites] = await Promise.all([
    // Per-folder breakdown, only meaningful inside a project.
    filter.projectId
      ? countHistory(filter)
      : Promise.resolve({ total: 0, unsorted: 0, byFolder: {} }),
    // The two global scopes carry the kind/search filters but no project, so
    // their tab counts describe the same thing their grids will show.
    countScope({ kind: filter.kind, q: filter.q }),
    countScope({ kind: filter.kind, q: filter.q, favorite: true }),
  ]);

  return NextResponse.json({ project, allAssets, favorites });
}
