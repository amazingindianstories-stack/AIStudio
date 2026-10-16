import assert from "node:assert/strict";
import test from "node:test";
import { uploadInlineReferences } from "./store.js";

test("identical inline images upload once, order is kept, concurrency is bounded", async () => {
  let active = 0, peak = 0;
  const calls = [];
  const uploadOne = async (value, label) => {
    calls.push(label);
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return `/api/media/uploads/${label}`;
  };
  const frame = "data:image/png;base64,FRAME";
  const result = await uploadInlineReferences([
    { value: "data:image/png;base64,A", label: "a" }, { value: "/api/media/existing", label: "x" },
    { value: "data:image/png;base64,B", label: "b" }, { value: "data:image/png;base64,C", label: "c" },
    { value: "data:image/png;base64,D", label: "d" }, { value: frame, label: "first-frame" },
    { value: null, label: "last" }, { value: frame, label: "continuation-frame" },
  ], uploadOne);
  assert.deepEqual(result, ["/api/media/uploads/a", "/api/media/existing", "/api/media/uploads/b", "/api/media/uploads/c",
    "/api/media/uploads/d", "/api/media/uploads/first-frame", null, "/api/media/uploads/first-frame"]);
  assert.equal(calls.length, 5);
  assert.ok(peak <= 3);
});

test("a failed upload rejects without uploading duplicates", async () => {
  await assert.rejects(uploadInlineReferences([{ value: "data:x", label: "a" }, { value: "data:x", label: "b" }],
    async () => { throw new Error("upload failed"); }), /upload failed/);
});
