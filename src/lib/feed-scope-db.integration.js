import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { UNSORTED, compareInScope, matchesScope, scopeToQuery } from "@/lib/feed-scope";
import { historyFilterToParams, parseHistoryFilter } from "@/lib/history-query";
import { decodeCursor, deleteItem, queryHistory, upsertItem } from "@/lib/store-db";

const marker = `scope-parity-${randomUUID()}`;
const projectA = randomUUID();
const projectB = randomUUID();
const folderA = randomUUID();
const folderB = randomUUID();
const t = 1_800_000_000_000;

function row(patch) {
  return {
    id: randomUUID(),
    kind: "image",
    status: "complete",
    prompt: `${marker} ordinary`,
    model: "parity-fixture",
    aspectRatio: "1:1",
    isFavorite: false,
    flagged: false,
    createdAt: t,
    updatedAt: t,
    ...patch,
  };
}

const rows = [
  row({ projectId: projectA, folderId: folderA, createdAt: t + 4 }),
  row({ kind: "video", projectId: projectA, folderId: folderA, createdAt: t + 3 }),
  row({ projectId: projectA, createdAt: t + 2, isFavorite: true, favoritedAt: t + 20 }),
  row({ kind: "video", projectId: projectA, createdAt: t + 2, isFavorite: true, favoritedAt: t + 20 }),
  row({ projectId: projectA, folderId: folderB, createdAt: t + 1 }),
  row({ kind: "video", projectId: projectB, folderId: folderA, createdAt: t }),
  row({ prompt: `${marker} 100%_done\\path`, createdAt: t - 1 }),
  row({ prompt: `${marker} 100XXdone/path`, createdAt: t - 2 }),
];

function scope(patch = {}) {
  return { tab: "history", projectId: null, folderId: null, kind: "all", q: marker, ...patch };
}

const scopes = [
  scope(),
  scope({ kind: "image" }),
  scope({ tab: "project", projectId: projectA }),
  scope({ tab: "project", projectId: projectA, folderId: folderA, kind: "video" }),
  scope({ tab: "project", projectId: projectA, folderId: UNSORTED }),
  scope({ tab: "favorites" }),
  scope({ tab: "favorites", kind: "video" }),
  scope({ q: `${marker} 100%_done\\path` }),
];

function sqlFilterFor(viewScope) {
  return parseHistoryFilter(historyFilterToParams(scopeToQuery(viewScope)));
}

async function readAllPages(viewScope) {
  const ids = [];
  let cursor;
  do {
    const page = await queryHistory(sqlFilterFor(viewScope), cursor, 2);
    ids.push(...page.items.map((item) => item.id));
    cursor = decodeCursor(page.nextCursor);
  } while (cursor);
  return ids;
}

test("PostgreSQL history queries match client scope membership, ordering, and keyset pagination", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL for a disposable PostgreSQL database");
  try {
    for (const item of rows) await upsertItem(item);

    for (const viewScope of scopes) {
      const expected = rows
        .filter((item) => matchesScope(item, viewScope))
        .sort((a, b) => compareInScope(a, b, viewScope))
        .map((item) => item.id);
      const actual = await readAllPages(viewScope);
      assert.deepEqual(actual, expected, `SQL drifted for ${JSON.stringify(viewScope)}`);
      assert.equal(new Set(actual).size, actual.length, "keyset pagination returned a duplicate row");
    }
  } finally {
    await Promise.all(rows.map((item) => deleteItem(item.id)));
  }
});
