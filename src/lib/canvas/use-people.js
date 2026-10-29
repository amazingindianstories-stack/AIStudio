"use client";

import { useEffect, useState } from "react";
import { fetchTeammates } from "../board-access";

/** Everyone on the workspace, fetched once per page and refreshed on request. */
let people = null;
let pending = null;
const listeners = new Set();

function load() {
  if (!pending) {
    pending = fetchTeammates()
      .then((users) => {
        people = new Map(users.map((user) => [user.id, user]));
        for (const listener of listeners) listener(people);
      })
      .catch(() => {})
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/**
 * The workspace's people by id, for showing who did what. Names load in the
 * background; until then (or if they cannot load) callers fall back to a short id.
 * `refresh` refetches, so a teammate added since the page loaded shows by name.
 */
export function usePeople({ refresh = false } = {}) {
  const [map, setMap] = useState(people ?? new Map());
  useEffect(() => {
    listeners.add(setMap);
    if (!people || refresh) void load();
    return () => {
      listeners.delete(setMap);
    };
  }, [refresh]);
  return map;
}
