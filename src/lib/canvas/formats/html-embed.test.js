import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EMBED_CSP, staticEmbedHtml } from "./html-embed.js";

const { DOMParser } = new JSDOM("").window;
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

test("an embed keeps its static content and loses scripts, refreshes and outside links", () => {
  const out = parse(staticEmbedHtml(`
    <meta http-equiv="refresh" content="0;url=https://attacker.example/">
    <base href="https://attacker.example/">
    <script>location = "https://attacker.example/"</script>
    <h1 onclick="location='https://attacker.example/'">Title</h1>
    <a id="out" href="https://attacker.example/" target="_top">Out</a>
    <a id="in" href="#part">In</a>
    <a id="js" href="javascript:location='https://attacker.example/'">Js</a>
    <svg><a id="svg" href="https://attacker.example/"><set attributeName="href" to="https://attacker.example/"/></a></svg>
    <form action="https://attacker.example/"><button formaction="https://attacker.example/">Go</button></form>
    <iframe src="https://attacker.example/"></iframe>
  `, new DOMParser()));
  assert.equal(out.querySelectorAll("script, base, iframe, set").length, 0);
  assert.deepEqual([...out.querySelectorAll("meta")].map((m) => [m.getAttribute("http-equiv"), m.getAttribute("content")]), [["Content-Security-Policy", EMBED_CSP]]);
  assert.equal(out.querySelector("h1").textContent, "Title");
  assert.equal(out.querySelector("h1").hasAttribute("onclick"), false);
  assert.equal(out.querySelector("#out").hasAttribute("href"), false);
  assert.equal(out.querySelector("#out").hasAttribute("target"), false);
  assert.equal(out.querySelector("#js").hasAttribute("href"), false);
  assert.equal(out.querySelector("#svg").hasAttribute("href"), false);
  assert.equal(out.querySelector("#in").getAttribute("href"), "#part");
  assert.equal(out.querySelector("form").hasAttribute("action"), false);
  assert.equal(out.querySelector("button").hasAttribute("formaction"), false);
  assert.doesNotMatch(EMBED_CSP, /script-src/);
});
