import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { AssetLibrary } from "./AssetLibrary.jsx";
import { useStore } from "../lib/store";

test("AssetLibrary renders empty state with active project name without throwing ReferenceError", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };

  try {
    Object.assign(initial, {
      assetLibraryOpen: true,
      assets: [],
      projects: [
        { id: "proj-1", name: "Project Alpha" },
        { id: "proj-2", name: "Project Beta" },
      ],
      activeProjectId: "proj-2",
    });

    const html = renderToString(React.createElement(AssetLibrary));
    assert.match(html, /Project Beta/);
    assert.match(html, /No materials in (&quot;|")Project Beta(&quot;|") yet/);
    assert.match(html, /Add Material/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});
