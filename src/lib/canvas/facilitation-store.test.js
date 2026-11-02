import assert from "node:assert/strict";
import test from "node:test";
import { useFacilitationStore } from "./facilitation-store.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const BOARD = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

function snapshot(myVotes) {
  const votesUsed = Object.values(myVotes).reduce((sum, count) => sum + count, 0);
  return {
    serverNow: Date.now(),
    timer: null,
    privateMode: { active: false },
    voting: { active: { id: SESSION, votesPerPerson: 5, myVotes, votesUsed }, shown: null, savedCount: 0 },
  };
}

test("a poll read before a vote reply lands cannot put the older ballot back", async () => {
  const prior = globalThis.fetch;
  const ballots = [];
  let releasePoll;
  let pollRequests = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/facilitation")) {
      pollRequests += 1;
      if (pollRequests === 1) return json(snapshot({ A: 0 }));
      return new Promise((resolve) => { releasePoll = () => resolve(json(snapshot({ A: 0 }))); });
    }
    const { nodeId, votes } = JSON.parse(options.body);
    ballots.push(votes);
    return json({ myVotes: { [nodeId]: votes } });
  };
  try {
    const store = useFacilitationStore.getState();
    store.open(BOARD);
    await store.refresh();
    const poll = useFacilitationStore.getState().refresh();
    await useFacilitationStore.getState().adjustVote(SESSION, "A", 1);
    releasePoll();
    await poll;
    assert.equal(useFacilitationStore.getState().voting.active.myVotes.A, 1);
    await useFacilitationStore.getState().adjustVote(SESSION, "A", 1);
    assert.deepEqual(ballots, [1, 2]);
  } finally {
    useFacilitationStore.getState().close();
    globalThis.fetch = prior;
  }
});
