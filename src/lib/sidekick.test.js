import assert from "node:assert/strict";
import test from "node:test";
import { expandMessage, parseSlash, slashMatches } from "./sidekick.js";

const skills = [{ name: "summarize", description: "Summarize", prompt: "Summarize the selection." }, { name: "ideas", description: "Ideas", prompt: "Give ideas." }];

test("a slash command expands to the skill's instruction plus what follows", () => {
  assert.equal(expandMessage("/summarize", skills), "Summarize the selection.");
  assert.equal(expandMessage("/summarize for kids", skills), "Summarize the selection.\n\nfor kids");
  assert.equal(expandMessage("  plain words ", skills), "plain words");
  assert.equal(expandMessage("/unknown x", skills), "/unknown x");
});

test("slash parsing needs a known skill", () => {
  assert.equal(parseSlash("/nope", skills), null);
  assert.equal(parseSlash("/IDEAS go", skills).rest, "go");
});

test("the slash menu filters by prefix and closes after a space", () => {
  assert.deepEqual(slashMatches("/", skills).map((s) => s.name), ["summarize", "ideas"]);
  assert.deepEqual(slashMatches("/su", skills).map((s) => s.name), ["summarize"]);
  assert.deepEqual(slashMatches("/summarize now", skills), []);
  assert.deepEqual(slashMatches("hello", skills), []);
});

test("sources are sent as board ids or the library, at most three, and toggled in the store", async () => {
  const { MAX_SOURCES, sourcesFor, useSidekick } = await import("./sidekick.js");
  assert.deepEqual(sourcesFor([{ kind: "library", id: undefined, label: "x" }, { kind: "board", id: "b1", label: "Ideas" }]), [{ kind: "library" }, { kind: "board", id: "b1" }]);
  const store = useSidekick.getState();
  for (const id of ["a", "b", "c", "d"]) store.toggleSource({ kind: "board", id });
  assert.deepEqual(useSidekick.getState().sources.map((item) => item.id), ["a", "b", "c"].slice(0, MAX_SOURCES));
  store.toggleSource({ kind: "board", id: "b" });
  store.toggleSource({ kind: "library" });
  assert.deepEqual(useSidekick.getState().sources, [{ kind: "board", id: "a" }, { kind: "board", id: "c" }, { kind: "library" }]);
});

test("the web search choice travels with the quote and the turn it prices", async () => {
  const { useSidekick } = await import("./sidekick.js");
  const previous = useSidekick.getState();
  const fetchBefore = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith("/quote")) return Response.json({ quote: { format: "sidekick-web", costCents: 3 } });
    if (String(url).endsWith("/turns")) return Response.json({ job: { id: "j1", status: "queued" } });
    return Response.json({ credits: null });
  };
  useSidekick.setState({ boardId: "b1", chatId: "c1", sidekickId: "s1", sources: [], catalogue: null, sending: false, pendingKey: null, turns: [], follow: async () => {} });
  try {
    await useSidekick.getState().estimate("Who won?", { webSearch: true, processing: "basic" });
    assert.equal(useSidekick.getState().quote.format, "sidekick-web");
    await useSidekick.getState().send("Who won?", { webSearch: true, processing: "basic" });
    const quote = calls.find((call) => call.url.endsWith("/sidekick-chats/c1/quote"));
    const turn = calls.find((call) => call.url.endsWith("/sidekick-chats/c1/turns"));
    assert.equal(quote.body.webSearch, true);
    assert.deepEqual({ ...turn.body }, { ...quote.body });
  } finally {
    globalThis.fetch = fetchBefore;
    useSidekick.setState(previous, true);
  }
});
