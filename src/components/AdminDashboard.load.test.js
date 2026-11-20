import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { AdminDashboard } from "./AdminDashboard.jsx";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/admin",
  });
  const saved = {
    window: globalThis.window,
    self: globalThis.self,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    React: globalThis.React,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.self = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.React = React;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    dom.window.close();
    for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
  };
}

const ADMIN_DATA_200 = {
  users: [{ id: "u1", email: "admin@example.com", name: "Admin", role: "admin" }],
  stats: {
    totalCostCents: 100,
    reconciledCostCents: 100,
    estimatedCostCents: 0,
    totalGenerations: 1,
    byKind: [],
    overTime: [],
    images: 1,
    videos: 0,
    byModel: [],
    byUser: [],
    models: [],
  },
  byModel: [],
  byUser: [],
  models: [],
  projects: [],
  filters: { models: [] },
  operations: { maintenance: false },
};

test("AdminDashboard shows alert and Retry on 503, then renders Overview on Retry 200", async () => {
  const restore = installDom();
  const prevFetch = globalThis.fetch;
  let adminDataCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/admin/data")) {
      adminDataCalls += 1;
      if (adminDataCalls === 1) {
        return { ok: false, status: 503, json: async () => ({ error: "backend unavailable" }) };
      }
      return { ok: true, status: 200, json: async () => ADMIN_DATA_200 };
    }
    if (u.includes("/api/auth/me")) {
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" } }) };
    }
    if (u.includes("/api/admin/activity")) {
      return { ok: true, status: 200, json: async () => ({ rows: [], total: 0, nextCursor: null, actions: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(AdminDashboard));
    });
    await act(async () => {});
    const alertEl = container.querySelector('[role="alert"]');
    assert.ok(alertEl, "expected role=alert on 503");
    assert.match(alertEl.textContent, /backend unavailable/);
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent.includes("Retry")
    );
    assert.ok(retryBtn, "expected Retry button");

    await act(async () => {
      retryBtn.click();
    });
    await act(async () => {});
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.match(container.textContent, /Total generations|Overview/i);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = prevFetch;
    restore();
  }
});

test("LogsTab clears rows and shows alert when /api/admin/logs returns 500 after initial 200", async () => {
  const restore = installDom();
  const prevFetch = globalThis.fetch;
  let logsCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/admin/data")) {
      return { ok: true, status: 200, json: async () => ADMIN_DATA_200 };
    }
    if (u.includes("/api/auth/me")) {
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" } }) };
    }
    if (u.includes("/api/admin/logs")) {
      logsCalls += 1;
      if (logsCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rows: [
              {
                id: "log-1",
                createdAt: "2026-11-19T12:00:00Z",
                userId: "u1",
                kind: "image",
                model: "gpt-image-1",
                prompt: "first query prompt",
                status: "completed",
                costCents: 10,
              },
            ],
            total: 1,
            totalCostCents: 10,
            reconciledCostCents: 10,
            estimatedCostCents: 0,
            nextCursor: null,
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({ error: "logs query failed" }) };
    }
    if (u.includes("/api/admin/activity")) {
      return { ok: true, status: 200, json: async () => ({ rows: [], total: 0, nextCursor: null, actions: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(AdminDashboard));
    });
    await act(async () => {});

    const logsTabBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent.trim() === "Logs"
    );
    assert.ok(logsTabBtn, "expected Logs tab button");
    await act(async () => {
      logsTabBtn.click();
    });
    await act(async () => {});
    assert.match(container.textContent, /first query prompt/);

    // Trigger a filter change (Flagged only checkbox) to fire the second /api/admin/logs request
    const checkbox = container.querySelector('input[type="checkbox"]');
    assert.ok(checkbox, "expected Flagged only checkbox in LogsTab");
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {});

    assert.doesNotMatch(container.textContent, /first query prompt/);
    const alertEl = container.querySelector('[role="alert"]');
    assert.ok(alertEl, "expected role=alert on 500");
    assert.match(alertEl.textContent, /logs query failed/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = prevFetch;
    restore();
  }
});

function setInputValue(input, value) {
  const win = input.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

test("AdminDashboard keeps the loaded Users tab mounted and shows a banner when a background reload fails", async () => {
  const restore = installDom();
  const prevFetch = globalThis.fetch;
  let adminDataCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/api/admin/data")) {
      adminDataCalls += 1;
      if (adminDataCalls === 1) return { ok: true, status: 200, json: async () => ADMIN_DATA_200 };
      return { ok: false, status: 503, json: async () => ({ error: "backend unavailable" }) };
    }
    if (u.includes("/api/admin/users") && init.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes("/api/auth/me")) {
      return { ok: true, status: 200, json: async () => ({ user: { id: "u1", email: "admin@example.com", name: "Admin", role: "admin" } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const { createRoot } = await import("react-dom/client");
  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(AdminDashboard));
    });
    await act(async () => {});

    const usersTabBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === "Users");
    await act(async () => {
      usersTabBtn.click();
    });
    assert.match(container.textContent, /admin@example\.com/);

    const newUserBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent.includes("New user"));
    await act(async () => {
      newUserBtn.click();
    });
    await act(async () => {
      setInputValue(container.querySelector('input[aria-label="Email"]'), "new@example.com");
    });
    await act(async () => {
      setInputValue(container.querySelector('input[aria-label="Password"]'), "longenoughpassword");
    });
    const createBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent.trim() === "Create");
    assert.ok(createBtn && !createBtn.disabled, "expected enabled Create button");
    await act(async () => {
      createBtn.click();
    });
    await act(async () => {});

    assert.equal(adminDataCalls, 2, "expected a background reload after the create");
    assert.match(container.textContent, /admin@example\.com/, "Users tab must stay mounted");
    assert.ok(Array.from(container.querySelectorAll("button")).some((b) => b.textContent.includes("New user")));
    const alertEl = container.querySelector('[role="alert"]');
    assert.ok(alertEl, "expected non-blocking role=alert banner");
    assert.match(alertEl.textContent, /backend unavailable/);
    assert.doesNotMatch(container.textContent, /Loading…/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = prevFetch;
    restore();
  }
});
