import assert from "node:assert/strict";
import test from "node:test";
import { addKnowledge, estimateTokens, knowledgeFileProblem } from "./sidekick-knowledge.js";

test("only small text files are accepted and PDF says why not", () => {
  assert.equal(knowledgeFileProblem({ name: "notes.MD", size: 10 }), null);
  assert.equal(knowledgeFileProblem({ name: "data.csv", size: 10 * 1024 * 1024 }), null);
  assert.match(knowledgeFileProblem({ name: "big.txt", size: 10 * 1024 * 1024 + 1 }), /over 10 MB/);
  assert.match(knowledgeFileProblem({ name: "a.pdf", size: 5 }), /PDF/);
  assert.match(knowledgeFileProblem({ name: "a.docx", size: 5 }), /\.txt, \.md or \.csv/);
});

test("the total stays within about 50k tokens", () => {
  assert.equal(estimateTokens(200_000), 50_000);
  const ok = addKnowledge([{ name: "a.txt", text: "x".repeat(150_000) }], [{ name: "b.txt", text: "y".repeat(50_000) }]);
  assert.equal(ok.files.length, 2);
  const over = addKnowledge(ok.files, [{ name: "c.txt", text: "z" }]);
  assert.match(over.error, /50,000 tokens/);
});
