import assert from "node:assert/strict";
import test from "node:test";
import { askConfirm, askText, settleTextRequest, useTextRequest } from "./ask-text.js";

test("dialog requests resolve with the submitted value or null on cancel", async () => {
  useTextRequest.setState({ request: null, hostMounted: true });
  const named = askText({ title: "New project" });
  assert.equal(useTextRequest.getState().request.title, "New project");
  settleTextRequest("Launch film");
  assert.equal(await named, "Launch film");
  const cancelled = askText({ title: "Rename project", defaultValue: "Old" });
  settleTextRequest(null);
  assert.equal(await cancelled, null);
  assert.equal(useTextRequest.getState().request, null);
});

test("a newer request cancels the older one instead of leaving it pending", async () => {
  useTextRequest.setState({ request: null, hostMounted: true });
  const first = askText({ title: "First" });
  const second = askText({ title: "Second" });
  assert.equal(await first, null);
  settleTextRequest("ok");
  assert.equal(await second, "ok");
});

test("without a mounted host it falls back to the browser prompt", async () => {
  useTextRequest.setState({ request: null, hostMounted: false });
  const before = globalThis.window;
  globalThis.window = { prompt: (title, value) => `${title}:${value}` };
  try {
    assert.equal(await askText({ title: "Rename", defaultValue: "A" }), "Rename:A");
  } finally {
    globalThis.window = before;
  }
});

test("confirmations resolve true only on explicit confirm", async () => {
  useTextRequest.setState({ request: null, hostMounted: true });
  const yes = askConfirm({ title: "Delete folder?", destructive: true });
  assert.equal(useTextRequest.getState().request.kind, "confirm");
  settleTextRequest(true);
  assert.equal(await yes, true);
  const dismissed = askConfirm({ title: "Delete folder?" });
  settleTextRequest(null);
  assert.equal(await dismissed, false);
  const superseded = askConfirm({ title: "Delete 3 items?" });
  const next = askText({ title: "Rename" });
  assert.equal(await superseded, false);
  settleTextRequest(null);
  assert.equal(await next, null);
});
