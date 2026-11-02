import assert from "node:assert/strict";
import test from "node:test";
import { costLabel, generateCaptions, loadCaptionTrack, quoteCaptions } from "./captions-api.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
const recorder = (...responses) => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return responses.shift(); };
  return { calls, fetchImpl };
};

test("quotes with a GET that carries the encoded src", async () => {
  const { calls, fetchImpl } = recorder(ok({ captions: { exists: false } }));
  assert.deepEqual(await quoteCaptions("b 1", "/api/media/a b.mp4", fetchImpl), { exists: false });
  assert.equal(calls[0][0], "/api/canvas-boards/b%201/captions?src=%2Fapi%2Fmedia%2Fa%20b.mp4");
  assert.equal(calls[0][1].method, undefined);
});

test("generates with a POST body and surfaces the server error and status", async () => {
  const { calls, fetchImpl } = recorder(ok({ captions: { exists: true } }), fail(403, "No edit access."));
  assert.deepEqual(await generateCaptions("b", "/api/media/x", fetchImpl), { exists: true });
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].body, JSON.stringify({ src: "/api/media/x" }));
  await assert.rejects(generateCaptions("b", "/api/media/x", fetchImpl), (e) => e.message === "No edit access." && e.status === 403);
});

test("words a transport 5xx without a server message as still working, not a raw status", async () => {
  const dropped = { ok: false, status: 500, json: async () => { throw new SyntaxError("not JSON"); } };
  const { fetchImpl } = recorder(dropped, fail(502, "The caption run could not be checked."));
  await assert.rejects(generateCaptions("b", "/api/media/x", fetchImpl), (e) => e.message === "Still working on captions. Check back shortly." && e.status === 500);
  await assert.rejects(generateCaptions("b", "/api/media/x", fetchImpl), /could not be checked/);
});

test("turns the VTT text into a same-origin blob URL", async () => {
  const { calls, fetchImpl } = recorder(ok("WEBVTT\n"));
  let blob;
  const urls = { createObjectURL: (b) => { blob = b; return "blob:x"; } };
  assert.equal(await loadCaptionTrack("b", "/api/media/x", fetchImpl, urls), "blob:x");
  assert.match(calls[0][0], /\/captions\/vtt\?src=/);
  assert.equal(blob.type, "text/vtt");
});

test("rejects when the VTT is missing", async () => {
  const { fetchImpl } = recorder(fail(404, "No captions for this video."));
  await assert.rejects(loadCaptionTrack("b", "/api/media/x", fetchImpl, {}), /No captions for this video\./);
});

test("words the cost step without inventing a price and without an em dash", () => {
  const label = costLabel({ model: "Gemini (m)" });
  assert.match(label, /Uses Gemini \(m\)\. No price is metered/);
  assert.ok(!label.includes("—"));
});
