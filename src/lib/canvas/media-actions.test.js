import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "../canvas-store.js";
import { useStore } from "../store.js";
import { emptyCanvasState } from "./serialization.js";
import {
  addCodeBlock, addEmoji, addFromLink, addIcon, addMedia, extractPdfPages, looksLikeLink, objectLinkHref,
  renameMedia, replaceImage, setObjectLink, setPdfPage, toggleAgreement,
} from "./media-actions.js";
import { isBoardFile, isBrowserImage, mediaNodeFields } from "./media-upload.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const nodes = () => useCanvasStore.getState().history.present.nodes;

async function openBoard(t, role, initial = []) {
  t.mock.method(globalThis, "fetch", async () => json(200, { id: "board-1", name: "B", data: { ...emptyCanvasState(), nodes: initial }, updatedAt: 1, role }));
  useStore.setState({ currentUser: { id: "u1" } });
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  t.after(() => { useCanvasStore.getState().reset(); useStore.setState({ currentUser: null }); });
}

const base = { x: 0, y: 0, w: 200, h: 200, parentId: null, groupId: null };
const pdf = { ...base, id: "p", type: "pdf", src: "/api/media/k", name: "Doc", pages: 3, page: 1 };
const img = { ...base, id: "i", type: "image", src: "/api/media/a", alt: "" };

test("media nodes of each kind are added with sizes and selected", async (t) => {
  await openBoard(t, "edit");
  addCodeBlock({ code: "x = 1", language: "python" }, { x: 0, y: 0 });
  addEmoji("👍", { interactive: true }, { x: 500, y: 0 });
  addIcon("star", "#fff", { x: 900, y: 0 });
  assert.deepEqual(nodes().map((n) => n.type), ["code", "emoji", "icon"]);
  assert.equal(nodes()[0].w, 480);
});

test("embed codes and links become embeds locally and unknown hosts are refused", async (t) => {
  await openBoard(t, "edit");
  const id = await addFromLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "board-1", { x: 0, y: 0 });
  assert.equal(nodes().find((n) => n.id === id).type, "embed");
  const fetched = t.mock.method(globalThis, "fetch", async () => json(400, { error: "Use a public HTTPS link." }));
  const iframe = await addFromLink('<iframe src="https://evil.example/x"></iframe>', "board-1", { x: 0, y: 0 }).catch((e) => e);
  assert.equal(iframe.message, "This embed is not supported. Paste a YouTube, Vimeo, Loom, Dailymotion, Spotify, SoundCloud, Figma or Google Drive embed.");
  const wrapped = await addFromLink('<div class="embed"><iframe src="https://evil.example/x"></iframe></div>', "board-1", { x: 0, y: 0 }).catch((e) => e);
  assert.equal(wrapped.message, iframe.message);
  assert.equal(fetched.mock.callCount(), 0);
  assert.equal(nodes().length, 1);
});

test("replace image keeps the node and changes the stored reference", async (t) => {
  await openBoard(t, "edit", [img]);
  assert.equal(replaceImage("i", { url: "https://example.com/x.png" }), false);
  assert.equal(replaceImage("i", { url: "/api/media/b", name: "New", naturalW: 10, naturalH: 5 }), true);
  assert.deepEqual([nodes()[0].id, nodes()[0].src, nodes()[0].alt], ["i", "/api/media/b", "New"]);
});

test("pdf pages: flip within range, rename, extract into images", async (t) => {
  await openBoard(t, "edit", [pdf]);
  assert.equal(setPdfPage("p", 4), false);
  assert.equal(setPdfPage("p", 2), true);
  assert.equal(nodes()[0].page, 2);
  renameMedia("p", "Brief");
  assert.equal(nodes()[0].name, "Brief");
  const ids = extractPdfPages("p");
  assert.equal(ids.length, 3);
  assert.equal(nodes().find((n) => n.id === ids[2]).src, "/api/media/k.pages/3.png");
});

test("interactive stickers toggle the viewer's agreement only when interactive", async (t) => {
  await openBoard(t, "edit", [{ ...base, id: "e", type: "emoji", emoji: "👍", interactive: true }, { ...base, id: "f", type: "emoji", emoji: "👍" }]);
  assert.equal(toggleAgreement("f"), false);
  assert.equal(toggleAgreement("e"), true);
  assert.deepEqual(nodes()[0].agreedBy, ["u1"]);
  toggleAgreement("e");
  assert.deepEqual(nodes()[0].agreedBy, []);
});

test("object links accept web, board and object targets and build hrefs", async (t) => {
  await openBoard(t, "edit", [img]);
  assert.equal(setObjectLink("i", { url: "javascript:alert(1)" }), false);
  assert.equal(setObjectLink("i", { url: "https://example.com" }), true);
  assert.equal(objectLinkHref(nodes()[0].link), "https://example.com");
  assert.equal(setObjectLink("i", { nodeId: "x" }), true);
  assert.equal(objectLinkHref(nodes()[0].link), "/?board=board-1&object=x");
  setObjectLink("i", null);
  assert.equal(nodes()[0].link, undefined);
});

test("viewers and commenters cannot change media", async (t) => {
  for (const role of ["view", "comment"]) {
    await openBoard(t, role, [pdf, img, { ...base, id: "e", type: "emoji", emoji: "👍", interactive: true }]);
    assert.equal(addMedia({ type: "icon", icon: "star", color: "#fff" }), null);
    assert.equal(setPdfPage("p", 2), false);
    assert.equal(replaceImage("i", { url: "/api/media/b" }), false);
    assert.equal(setObjectLink("i", { url: "https://example.com" }), false);
    assert.equal(toggleAgreement("e"), false);
    assert.equal(renameMedia("p", "x"), false);
    assert.deepEqual(extractPdfPages("p"), []);
    assert.equal(nodes().length, 3);
  }
});

test("helpers: link detection, file kinds and node fields from uploaded files", () => {
  assert.equal(looksLikeLink("https://a.com/x"), true);
  assert.equal(looksLikeLink("http://a.com"), false);
  assert.equal(looksLikeLink("see https://a.com"), false);
  assert.equal(looksLikeLink('<iframe src="x">'), true);
  assert.equal(isBoardFile({ type: "video/mp4", name: "a.mp4" }), true);
  assert.equal(isBoardFile({ type: "application/zip", name: "a.zip" }), false);
  assert.equal(isBrowserImage({ type: "image/png", name: "a.png" }), true);
  for (const file of [{ type: "image/vnd.adobe.photoshop", name: "a.psd" }, { type: "image/x-photoshop", name: "a.psd" },
    { type: "", name: "a.psd" }, { type: "image/svg+xml", name: "a.svg" }, { type: "", name: "a.svg" }]) {
    assert.equal(isBrowserImage(file), false, `${file.type || file.name} is converted by the server`);
    assert.equal(isBoardFile(file), true);
  }
  assert.deepEqual(mediaNodeFields({ contentType: "application/pdf", url: "/api/media/k", name: "D", pages: 2 }),
    { type: "pdf", src: "/api/media/k", name: "D", pages: 2, page: 1, aspectLocked: true });
  assert.equal(mediaNodeFields({ contentType: "video/mp4", url: "/api/media/v", name: "V" }).type, "video");
});
