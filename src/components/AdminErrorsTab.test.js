import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { AdminErrorsTab } from "./AdminErrorsTab.jsx";
import { dayEnd, dayStart, formatIst, formatUtc, supportBlock } from "../lib/admin-errors.js";

const RECEIVED = Date.UTC(2026, 9, 19, 10, 20, 12);
const seedance = {
  id: "11111111-1111-4111-8111-111111111111", source: "generation", createdAt: RECEIVED - 4000, failedAt: RECEIVED + 50,
  receivedAt: RECEIVED, userId: "u1", userEmail: "artist@example.invalid", kind: "video", model: "Seedance 2.5",
  status: "failed", provider: "seedance", httpStatus: 400, code: "InputAudioSensitiveContentDetected", param: "content[10]",
  requestId: "021760850000000fixture0001", taskId: null, phase: "create", origin: "provider",
  message: "The request failed because the input audio may contain sensitive information. Request id: 021760850000000fixture0001",
  error: "The video provider rejected the input under its content policy.",
  userMessage: "Seedance rejected the input audio (content[10]) under its content policy. Provider code: InputAudioSensitiveContentDetected. Request id: 021760850000000fixture0001.",
  rawBody: '{"error": {"code": "InputAudioSensitiveContentDetected", "param": "content[10]"}}', records: [{}],
};
const older = {
  id: "22222222-2222-4222-8222-222222222222", source: "generation", createdAt: RECEIVED - 90000, failedAt: RECEIVED - 80000,
  userId: "u1", userEmail: "artist@example.invalid", kind: "image", model: "Nano Banana Pro", status: "failed", provider: "gemini",
  httpStatus: null, code: null, message: null, requestId: null, error: "Gemini returned no image (no candidates).",
  userMessage: "The model did not return an image.", rawBody: null, records: [],
};

test("the support block carries the code, request id, both times and the model, nothing empty", () => {
  assert.equal(supportBlock(seedance), [
    "Provider: Seedance (BytePlus ModelArk)",
    "Model: Seedance 2.5",
    "Error code: InputAudioSensitiveContentDetected",
    "Param: content[10]",
    "HTTP status: 400",
    "Request id: 021760850000000fixture0001",
    "Message: The request failed because the input audio may contain sensitive information. Request id: 021760850000000fixture0001",
    "Time (UTC): 2026-10-19 10:20:12 UTC",
    "Time (IST): 2026-10-19 15:50:12 IST",
    "Generation id: 11111111-1111-4111-8111-111111111111",
  ].join("\n"));
  assert.equal(supportBlock(older).split("\n").find((line) => line.startsWith("Message")), "Message: Gemini returned no image (no candidates).");
  assert.equal(formatIst(Date.UTC(2026, 9, 19, 20, 0, 0)), "2026-10-20 01:30:00 IST", "IST crosses midnight");
  assert.equal(formatUtc(Number.NaN), "");
  assert.equal(dayEnd("2026-10-19") - dayStart("2026-10-19"), 24 * 3600 * 1000);
  assert.equal(dayStart("19/10/2026"), null);
});

async function mount(pages, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "fetch", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const requests = [];
  const copied = [];
  const navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
  Object.defineProperty(dom.window, "navigator", { value: navigator, configurable: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url) => {
      requests.push(url);
      const page = pages(url);
      return { ok: true, status: 200, json: async () => page };
    },
  });
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  const root = createRoot(document.querySelector("#root"));
  const data = { users: [{ id: "u1", name: "Artist", email: "artist@example.invalid" }] };
  try {
    await act(async () => root.render(React.createElement(AdminErrorsTab, { data, usersById: { u1: data.users[0] } })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await run({
      requests, copied, dom,
      click: async (element) => act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      }),
      change: async (element, value) => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set;
          setter.call(element, value);
          if (element.tagName === "SELECT") {
            element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
          } else {
            // react-dom was loaded before this DOM existed, so it cannot see native input events here; hand the
            // change to the element's own onChange, exactly as React would.
            const props = element[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];
            props.onChange({ target: element, currentTarget: element });
          }
        });
        // The refetch is debounced while an error code is typed.
        await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const key of keys) Object.defineProperty(globalThis, key, { value: before[key], configurable: true, writable: true });
    dom.window.close();
  }
}

const firstPage = { rows: [seedance, older], total: 3, nextCursor: `${older.createdAt}.${older.id}`, providers: ["gemini", "seedance"], models: ["Nano Banana Pro", "Seedance 2.5"] };
const secondPage = { rows: [{ ...older, id: "33333333-3333-4333-8333-333333333333", model: "Kling Image 3.0" }], total: 3, nextCursor: null };

test("rows show the exact code and request id, expand to the raw body and copy the support block", async () => {
  await mount((url) => (url.includes("cursor=") ? secondPage : firstPage), async ({ requests, copied, click }) => {
    assert.equal(requests[0], "/api/admin/errors?limit=50");
    const rows = Array.from(document.querySelectorAll("tbody > tr"));
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /InputAudioSensitiveContentDetected/);
    assert.match(rows[0].textContent, /021760850000000fixture0001/);
    assert.match(rows[0].textContent, /Seedance 2\.5Seedance/, "the model, with its provider's short name under it");
    assert.match(rows[1].textContent, /Gemini returned no image \(no candidates\)\./, "older rows fall back to the stored error");
    assert.match(document.body.textContent, /Showing 2 of 3 errors/);

    await click(rows[0].querySelector("button[aria-expanded]"));
    assert.equal(rows[0].querySelector("button[aria-expanded]").getAttribute("aria-expanded"), "true");
    const detail = document.querySelector("pre");
    assert.equal(detail.textContent, seedance.rawBody);
    assert.match(document.body.textContent, /What the user saw/);
    assert.match(document.body.textContent, /2026-10-19 15:50:12 IST/);
    assert.match(document.body.textContent, /Seedance \(BytePlus ModelArk\)/, "the details name the provider in full");

    await click(rows[0].querySelector("button[aria-label='Copy support details']"));
    assert.deepEqual(copied, [supportBlock(seedance)]);
    assert.match(rows[0].textContent, /Copied/);
    assert.equal(document.querySelectorAll("pre").length, 1, "copying does not toggle the row");

    const more = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Load 1 more");
    await click(more);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(requests[1], `/api/admin/errors?limit=50&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    assert.match(document.body.textContent, /Kling Image 3\.0/);
  });
});

test("filters become server query parameters", async () => {
  await mount(() => ({ ...firstPage, nextCursor: null }), async ({ requests, change }) => {
    await change(document.querySelector("select[aria-label='Provider']"), "seedance");
    await change(document.querySelector("select[aria-label='User']"), "u1");
    await change(document.querySelector("input[aria-label='From date']"), "2026-10-19");
    await change(document.querySelector("input[aria-label='Error code']"), "InputAudio");
    const last = new URL(requests.at(-1), "http://localhost").searchParams;
    assert.equal(last.get("provider"), "seedance");
    assert.equal(last.get("userId"), "u1");
    assert.equal(last.get("from"), String(dayStart("2026-10-19")));
    assert.equal(last.get("code"), "InputAudio");
  });
});

test("the Errors tab sits with the other admin tabs and never uses an em dash", () => {
  const dashboard = readFileSync("src/components/AdminDashboard.jsx", "utf8");
  assert.match(dashboard, /\["logs", "Logs", ScrollText\],\n\s+\["errors", "Errors", AlertTriangle\],/);
  assert.match(dashboard, /tab === "errors" \? \(\n\s+<AdminErrorsTab data=\{data\} usersById=\{usersById\} \/>/);
  for (const file of ["src/components/AdminErrorsTab.jsx", "src/lib/admin-errors.js"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\u2014/, file);
  }
});

test('wrapped error rows retain support copying and details with long unbroken values', async () => {
  const row = { ...seedance, code: 'ProviderCode'.repeat(20), requestId: 'request'.repeat(40) };
  await mount(() => ({ ...firstPage, rows: [row], total: 1, nextCursor: null }), async ({ click, copied }) => {
    const errorRow = document.querySelector('tbody > tr');
    assert.ok(errorRow.textContent.includes(row.code));
    assert.ok(errorRow.textContent.includes(row.requestId));
    await click(errorRow.querySelector('[aria-label="Copy support details"]'));
    assert.deepEqual(copied, [supportBlock(row)]);
    await click(errorRow.querySelector('[aria-label="Show error details"]'));
    assert.equal(document.querySelector('pre').textContent, row.rawBody);
    assert.equal(errorRow.querySelector('[aria-expanded]').getAttribute('aria-expanded'), 'true');
  });
});
