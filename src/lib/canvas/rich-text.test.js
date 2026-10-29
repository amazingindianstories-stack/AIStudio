import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import {
  cssColorToHex,
  isSafeHref,
  marksFromRuns,
  readRichDom,
  richSegments,
  validateMarks,
  writeRichDom,
} from "./rich-text";
import { normalizeHref } from "./rich-text-commands";
import { RichTextContent } from "../../components/canvas/nodes/RichText";

const { document } = new JSDOM("<!doctype html><body></body>").window;
// The node components compile to classic-runtime React.createElement calls.
globalThis.React = React;

function editor(html) {
  const root = document.createElement("div");
  // Test fixtures only: this is how browser-made editor DOM arrives.
  root.innerHTML = html;
  return root;
}

test("links are limited to http, https and mailto", () => {
  for (const href of ["https://example.com", "http://x.y/z?q=1#f", "HTTPS://EXAMPLE.COM", "mailto:a@b.c", "MailTo:a@b.c"]) {
    assert.equal(isSafeHref(href), true, href);
  }
  for (const href of [
    "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x",
    "vbscript:x", "file:///etc/passwd", "ftp://x", "//x.com", "/relative", "https://", "https://a b", "https://a\nb",
    " https://a", "httpſ://a", "https://a\u0000", null, undefined, 5, "https://" + "a".repeat(2041),
  ]) {
    assert.equal(isSafeHref(href), false, String(href));
  }
  assert.equal(isSafeHref("https://" + "a".repeat(2040)), true, "2048 characters is the limit");
});

test("validateMarks clamps ranges to the UTF-16 text and drops anything unknown", () => {
  assert.equal(validateMarks(undefined, "abc"), null);
  assert.equal(validateMarks([], "abc"), null);
  assert.equal(validateMarks([[0, 1, "b"]], ""), null);
  assert.deepEqual(validateMarks([[0, 9, "b"], [-3, 1, "i"], [2, 2, "u"], [0, 1, "h", "#ABCDEF"], [0, 1, "a", "javascript:x"]], "😀c"), [
    [0, 3, "b"],
    [0, 1, "i"],
    [0, 1, "h", "#ABCDEF"],
  ]);
});

test("richSegments splits at every boundary and stacks formats", () => {
  assert.deepEqual(richSegments("", [[0, 1, "b"]]), []);
  assert.deepEqual(richSegments("plain", null), [{ text: "plain", start: 0 }]);
  assert.deepEqual(richSegments("abcdef", [[0, 4, "b"], [2, 6, "a", "https://x.y"]]), [
    { text: "ab", start: 0, b: true },
    { text: "cd", start: 2, b: true, a: "https://x.y" },
    { text: "ef", start: 4, a: "https://x.y" },
  ]);
});

test("marksFromRuns merges adjacent runs into canonical ranges", () => {
  assert.deepEqual(
    marksFromRuns([
      { start: 0, end: 2, format: { b: true } },
      { start: 2, end: 4, format: { b: true, h: "#fde047" } },
      { start: 4, end: 6, format: { h: "#86efac" } },
    ]),
    [[0, 4, "b"], [2, 4, "h", "#fde047"], [4, 6, "h", "#86efac"]]
  );
});

test("writeRichDom and readRichDom round-trip every format", () => {
  const text = "Bold italic under strike mark link\nsecond line";
  const marks = [[0, 11, "b"], [5, 11, "i"], [12, 17, "u"], [12, 24, "s"], [25, 29, "h", "#fde047"], [30, 34, "a", "https://example.com"]];
  const root = document.createElement("div");
  writeRichDom(root, text, marks);
  assert.equal(root.querySelector("script"), null);
  assert.deepEqual(readRichDom(root), { text, marks });
});

test("readRichDom reads browser editing markup and sanitizes it", () => {
  assert.deepEqual(readRichDom(editor("plain")), { text: "plain", marks: [] });
  assert.deepEqual(readRichDom(editor("<strong>a</strong><em>b</em><ins>c</ins><del>d</del><strike>e</strike><mark>f</mark>")), {
    text: "abcdef",
    marks: [[0, 1, "b"], [1, 2, "i"], [2, 3, "u"], [3, 5, "s"], [5, 6, "h", "#fde047"]],
  });
  assert.deepEqual(
    readRichDom(editor('<span style="font-weight: 700">a</span><b><span style="font-weight: normal">b</span></b><span style="text-decoration: underline line-through">c</span><span style="font-style: italic">d</span>')),
    { text: "abcd", marks: [[0, 1, "b"], [2, 3, "u"], [2, 3, "s"], [3, 4, "i"]] }
  );
  // Chrome's hiliteColor writes rgba(); transparent removes a highlight.
  assert.deepEqual(
    readRichDom(editor('<span style="background-color: rgba(253, 224, 71, 0.55)">a<span style="background-color: transparent">b</span></span>')),
    { text: "ab", marks: [[0, 1, "h", "#fde047"]] }
  );
  // Line structure: <br>, block wrappers and the empty-line placeholder.
  assert.deepEqual(readRichDom(editor("a<br>b")).text, "a\nb");
  assert.deepEqual(readRichDom(editor("a<div>b</div><div><br></div><div>c</div>")).text, "a\nb\n\nc");
  assert.deepEqual(readRichDom(editor("<div>a</div><div>b<br></div>")).text, "a\nb");
  assert.deepEqual(readRichDom(editor("<div><br></div><div>a</div>")).text, "\na");
  assert.deepEqual(readRichDom(editor("abc<div><br></div>")).text, "abc\n");
});

test("readRichDom drops scripts, unsafe links, attributes and embedded content", () => {
  const value = readRichDom(editor(
    '<a href="javascript:alert(1)">x</a><a href="https://ok.example">y</a><img src="x" onerror="alert(1)">' +
    '<script>alert(1)</script><style>*{}</style><span onclick="alert(1)" class="evil">z</span><a href="data:text/html,1"><b>w</b></a>'
  ));
  assert.deepEqual(value, { text: "xyzw", marks: [[1, 2, "a", "https://ok.example"], [3, 4, "b"]] });
});

test("cssColorToHex normalizes opaque colors and refuses transparent ones", () => {
  assert.equal(cssColorToHex("#FDE047"), "#fde047");
  assert.equal(cssColorToHex("#abc"), "#aabbcc");
  assert.equal(cssColorToHex("#fde0478c"), "#fde047");
  assert.equal(cssColorToHex("#fde04700"), null);
  assert.equal(cssColorToHex("rgb(1, 2, 3)"), "#010203");
  assert.equal(cssColorToHex("rgba(1, 2, 3, 0)"), null);
  assert.equal(cssColorToHex("transparent"), null);
  assert.equal(cssColorToHex("red"), null);
});

test("normalizeHref adds https or mailto to what people type", () => {
  assert.equal(normalizeHref("  example.com/a "), "https://example.com/a");
  assert.equal(normalizeHref("a@b.co"), "mailto:a@b.co");
  assert.equal(normalizeHref("http://x.y"), "http://x.y");
  assert.equal(normalizeHref("javascript:alert(1)"), "javascript:alert(1)", "kept so the safety check refuses it");
  assert.equal(normalizeHref("   "), "");
});

test("RichTextContent renders formats as elements and never raw HTML", () => {
  const html = renderToStaticMarkup(React.createElement(RichTextContent, {
    text: "<script>alert(1)</script> bold link",
    marks: [[26, 30, "b"], [31, 35, "a", "https://example.com"], [0, 8, "a", "javascript:alert(1)"], [0, 2, "h", "#fde047"], [2, 3, "h", "red;x"]],
  }));
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /<b class="font-bold">bold<\/b>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer nofollow"[^>]*>link<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /background-color:#fde0478c/);
  assert.doesNotMatch(html, /red;x/);
});
