import test from "node:test";
import assert from "node:assert/strict";
import { highlight, LANGUAGE_LABELS } from "./code-highlight.js";
import { CODE_LANGUAGES } from "./media-nodes.js";

const join = (tokens) => tokens.map((t) => t.text).join("");

test("tokens cover the source exactly in every language", () => {
  const sample = "const a = 'x'; // note\nSELECT 1 /* c */ \"y\" `z` 0x1F <b>\\n";
  for (const language of CODE_LANGUAGES) assert.equal(join(highlight(sample, language)), sample, language);
});

test("keywords, strings, numbers and comments are recognised", () => {
  const kinds = Object.fromEntries(highlight("def f(): return 'a' # c\nx = 42", "python").map((t) => [t.text, t.kind]));
  assert.equal(kinds.def, "keyword");
  assert.equal(kinds["'a'"], "string");
  assert.equal(kinds["# c"], "comment");
  assert.equal(kinds["42"], "number");
});

test("sql keywords match in any case and plain text stays plain", () => {
  assert.equal(highlight("select * From t", "sql").find((t) => t.text === "From").kind, "keyword");
  assert.deepEqual(highlight("if x", "text"), [{ text: "if x", kind: "plain" }]);
});

test("every language has a label", () => {
  for (const language of CODE_LANGUAGES) assert.ok(LANGUAGE_LABELS[language], language);
});
