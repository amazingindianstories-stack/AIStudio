import test from "node:test";
import assert from "node:assert/strict";
import { afterFailedSend } from "./agent-send.js";

const brief = { uploadId: "u-1", name: "brief.pdf", contentType: "application/pdf" };
const notes = { uploadId: "u-2", name: "notes.txt", contentType: "text/plain" };
const earlier = { id: "m-0", role: "assistant", content: "Hi" };
const optimistic = { id: "pending-1", role: "user", content: "Read the brief" };
const saved = { id: "m-1", role: "user", content: "Read the brief", toolTrace: null };

for (const status of [502, 504]) {
  test(`a ${status} that saved the user message keeps it and clears the documents it carried`, () => {
    const kept = afterFailedSend({ status, data: { userMessage: saved, error: "late" }, optimisticId: optimistic.id, sentDocuments: [brief] });
    assert.deepEqual(kept.messages([earlier, optimistic]), [earlier, saved]);
    assert.deepEqual(kept.documents([brief, notes]), [notes]);
  });
}

test("a failure that saved nothing leaves the optimistic message and staged documents for a retry", () => {
  for (const [status, data] of [[504, { error: "Veevee could not read the attachments in time." }], [502, { error: "UPSTREAM_TIMEOUT" }],
    [400, { userMessage: saved, error: "bad" }], [502, {}], [504, { userMessage: null }]]) {
    assert.equal(afterFailedSend({ status, data, optimisticId: optimistic.id, sentDocuments: [brief] }), null, `${status} ${JSON.stringify(data)}`);
  }
});
