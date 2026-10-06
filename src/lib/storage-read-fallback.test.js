import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Storage } from "@google-cloud/storage";
import { deleteByUrls, getSignedDownloadUrl, getSignedReadUrl, getSignedUploadUrl,
  objectExists, openMediaObject, readAsBase64, readStoredBuffer, uploadBuffer } from "./storage.js";

test("all GCS delivery paths resolve historical media, while uploads and deletes stay in primary", async () => {
  const names = ["MEDIA_BACKEND", "GCP_AUTH_MODE", "GCP_MEDIA_BUCKET", "GCP_MEDIA_READ_FALLBACK_BUCKET", "GCP_MEDIA_CDN_URL", "GCS_MIGRATION_READ_FALLBACK", "GCP_SERVICE_ACCOUNT_JSON"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalBucket = Storage.prototype.bucket;
  const calls = [];
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, { MEDIA_BACKEND: "gcs", GCP_MEDIA_BUCKET: "preview", GCP_MEDIA_READ_FALLBACK_BUCKET: "historical" });
    Storage.prototype.bucket = function (bucket) {
      return { file: key => ({
        exists: async () => [bucket === "historical" || key.includes("new")],
        getSignedUrl: async options => { calls.push([options.action, bucket, key]); return [`https://example.invalid/${bucket}/${key}`]; },
        getMetadata: async () => [{ size: "5", contentType: "video/mp4" }],
        download: async () => { calls.push(["download", bucket, key]); return [Buffer.from("media")]; },
        createReadStream: () => { calls.push(["stream", bucket, key]); return Readable.from([Buffer.from("media")]); },
        save: async (_bytes, options) => { calls.push(["save", bucket, key, options.contentType]); },
        delete: async () => { calls.push(["delete", bucket, key]); },
      }) };
    };
    const key = "generations/historical.mp4";
    assert.match(await getSignedReadUrl(key), /historical\/generations/);
    assert.match(await getSignedDownloadUrl(key, { filename: "R01_SC001_0001.mp4" }), /historical\/generations/);
    assert.equal((await readStoredBuffer(key)).toString(), "media");
    assert.equal((await readAsBase64(`/api/media/${key}`)).data, Buffer.from("media").toString("base64"));
    assert.equal(await objectExists(key), true);
    const result = await openMediaObject(key);
    assert.equal(result.contentLength, 5);
    await result.stream.cancel();
    assert.match(await getSignedUploadUrl(key, "video/mp4"), /preview\/generations/);
    await uploadBuffer(Buffer.from("media"), key, "mp4");
    await uploadBuffer(Buffer.from("native MOV"), "generations/new.mov", "mov");
    assert.deepEqual(calls.at(-1), ["save", "preview", "generations/new.mov", "video/quicktime"]);
    await deleteByUrls([`/api/media/${key}`]);
    assert.ok(calls.filter(([action]) => ["read", "download", "stream"].includes(action)).every(([, bucket]) => bucket === "historical"));
    assert.deepEqual(calls.filter(([action]) => ["write", "save", "delete"].includes(action)).map(([action, bucket]) => [action, bucket]), [["write", "preview"], ["save", "preview"], ["save", "preview"], ["delete", "preview"]]);
    await assert.rejects(getSignedReadUrl("thumbs/512/settings/private.json.webp"), /protected/);
    await readStoredBuffer("settings/private.json");
    assert.deepEqual(calls.at(-1), ["download", "preview", "settings/private.json"]);
  } finally {
    Storage.prototype.bucket = originalBucket;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
