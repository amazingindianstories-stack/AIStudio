import test from "node:test";
import assert from "node:assert/strict";
import { ATTACH_ACCEPT, documentType, DOCX, uploadAgentDocument } from "./agent-attachments.js";

test("the attach picker offers media plus pdf, txt, md and docx", () => {
  assert.equal(ATTACH_ACCEPT, `image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.docx,application/pdf,text/plain,text/markdown,${DOCX}`);
});

test("documents get the canonical type the document-reference purpose accepts", () => {
  assert.equal(documentType({ name: "brief.pdf", type: "application/pdf" }), "application/pdf");
  assert.equal(documentType({ name: "notes.txt", type: "text/plain" }), "text/plain");
  assert.equal(documentType({ name: "shot-list.md", type: "" }), "text/markdown");
  assert.equal(documentType({ name: "shot-list.md", type: "text/x-markdown" }), "text/markdown");
  assert.equal(documentType({ name: "shot-list.MARKDOWN", type: "text/plain" }), "text/markdown");
  assert.equal(documentType({ name: "script.docx", type: DOCX }), DOCX);
  assert.equal(documentType({ name: "script.docx", type: "application/octet-stream" }), DOCX);
  assert.equal(documentType({ name: "notes", type: "text/plain; charset=utf-8" }), "text/plain");
});

test("media and other files are not documents", () => {
  for (const file of [{ name: "a.png", type: "image/png" }, { name: "a.mp4", type: "video/mp4" }, { name: "a.mp3", type: "audio/mpeg" },
    { name: "a.doc", type: "application/msword" }, { name: "a.html", type: "text/html" }, { name: "a.bin", type: "application/octet-stream" },
    { name: "a.zip", type: "" }]) {
    assert.equal(documentType(file), null, file.name);
  }
});

test("uploads as document-reference with the canonical type and stages the upload id", async () => {
  const calls = [];
  const upload = async (file, purpose) => { calls.push([file.name, file.type, purpose, await file.text()]); return { referenceId: "u-1", ref: "/api/media/uploads/x" }; };
  const md = new File(["# Shots"], "shots.md", { type: "" });
  assert.deepEqual(await uploadAgentDocument(md, { upload }), { uploadId: "u-1", name: "shots.md", contentType: "text/markdown" });
  const pdf = new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" });
  assert.deepEqual(await uploadAgentDocument(pdf, { upload }), { uploadId: "u-1", name: "brief.pdf", contentType: "application/pdf" });
  assert.deepEqual(calls, [["shots.md", "text/markdown", "document-reference", "# Shots"], ["brief.pdf", "application/pdf", "document-reference", "%PDF-1.7"]]);
  await assert.rejects(uploadAgentDocument(new File(["x"], "a.doc", { type: "application/msword" }), { upload }), /Unsupported attachment: a\.doc/);
  assert.equal(calls.length, 2);
});
