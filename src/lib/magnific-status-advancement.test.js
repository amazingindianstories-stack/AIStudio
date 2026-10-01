import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { advanceMagnificStatus, assertMagnificItem } from "./magnific-status-advancement";

const item = { id: "1", kind: "image", model: "Magnific Precision V1", taskId: "task", status: "running", updatedAt: 1, aspectRatio: "1:1", costCents: 10, costBasis: "estimated" };

test("Magnific advancement rejects unrelated generations", () => {
  assert.throws(() => assertMagnificItem({ ...item, model: "Seedream 4.5" }), /not a Magnific/);
});

test("Magnific finalization preserves format and estimated cost", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).webp().toBuffer();
  let extension;
  let updates;
  const result = await advanceMagnificStatus(item, {
    getStatus: async () => ({ status: "succeeded", generatedUrl: "https://cdn.example.com/result" }),
    fetchImpl: async () => new Response(image, { headers: { "content-type": "image/webp" } }),
    save: async (_buffer, ext) => { extension = ext; return { url: "/api/media/generations/1.webp", aspectRatio: "1:1" }; },
    update: async (_item, values) => { updates = values; return { ...item, ...values }; },
    publish: async () => {}, now: () => 10,
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(extension, "webp");
  assert.equal(updates.costBasis, undefined);
});

test("concurrent finalization losing CAS is idempotent", async () => {
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  const result = await advanceMagnificStatus(item, {
    getStatus: async () => ({ status: "succeeded", generatedUrl: "https://cdn.example.com/result" }),
    fetchImpl: async () => new Response(image), save: async () => ({ url: "/x" }),
    update: async () => undefined, publish: async () => { throw new Error("must not publish"); },
  });
  assert.equal(result.kind, "raced");
});
