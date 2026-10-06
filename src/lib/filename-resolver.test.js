import test from "node:test";
import assert from "node:assert/strict";
import {
  slugifyToken,
  resolveExtension,
  formatSerial,
  resolveGenerationFilename,
  getNamespaceDisambiguator,
} from "./filename-resolver.js";

test("slugifyToken: handles Unicode, accents, whitespace, and special characters", () => {
  assert.equal(slugifyToken("Café & Crème"), "cafe_creme");
  assert.equal(slugifyToken("Anime Characters!"), "anime_characters");
  assert.equal(slugifyToken("  Spaces   And---Dashes  "), "spaces_and_dashes");
  assert.equal(slugifyToken("Über cool 100%"), "uber_cool_100");
  assert.equal(slugifyToken("???"), "folder");
  assert.equal(slugifyToken("", "project"), "project");
  assert.equal(slugifyToken(null, "untitled"), "untitled");
});

test("formatSerial: pads to at least 4 digits and expands past 9999", () => {
  assert.equal(formatSerial(1), "0001");
  assert.equal(formatSerial(7), "0007");
  assert.equal(formatSerial(42), "0042");
  assert.equal(formatSerial(999), "0999");
  assert.equal(formatSerial(9999), "9999");
  assert.equal(formatSerial(10000), "10000");
  assert.equal(formatSerial(250000), "250000");
  assert.equal(formatSerial(0), "0001");
  assert.equal(formatSerial(-5), "0001");
});

test("native MOV masters retain their extension in compact download names", () => {
  assert.equal(resolveExtension({ kind: "video", contentType: "video/quicktime" }), "mov");
  assert.equal(resolveGenerationFilename({ ancestry: [{ name: "R01" }, { name: "Sc001" }], namespace: "folder:id", sequence: 1, kind: "video", url: "/api/media/generations/master.mov" }), "R01_SC001_0001.mov");
});

test("resolveExtension: resolves trusted extension across media types", () => {
  assert.equal(resolveExtension({ kind: "image", url: "/api/media/gen.png" }), "png");
  assert.equal(resolveExtension({ kind: "video", url: "https://storage.googleapis.com/b/v.mp4" }), "mp4");
  assert.equal(resolveExtension({ kind: "video", url: "https://storage.googleapis.com/b/v.webm" }), "webm");
  assert.equal(resolveExtension({ kind: "depth", url: "/api/media/depth.png" }), "png");
  assert.equal(resolveExtension({ kind: "image", contentType: "image/jpeg" }), "jpg");
  assert.equal(resolveExtension({ kind: "video", contentType: "video/mp4; charset=binary" }), "mp4");
  assert.equal(resolveExtension({ kind: "image", url: "" }), "png");
  assert.equal(resolveExtension({ kind: "video", url: "" }), "mp4");
  assert.equal(resolveExtension({ kind: "depth", url: "" }), "png");
  assert.equal(resolveExtension({ kind: "audio", url: "" }), "mp3");
});

test("resolveGenerationFilename: derives standard example names", () => {
  // 1. Global folder hierarchy: anime_characters--f2000..._0007.mp4
  const globalFolder = resolveGenerationFilename({
    project: null,
    ancestry: [{ id: "f1", name: "Anime" }, { id: "f2", name: "Characters" }],
    namespace: "folder:f2",
    sequence: 7,
    kind: "video",
    url: "/api/media/v.mp4",
  });
  assert.equal(globalFolder, "anime_characters_0007.mp4");

  // 2. Global Unsorted: library_unsorted--00000000..._0001.png
  const globalUnsorted = resolveGenerationFilename({
    project: null,
    ancestry: [],
    namespace: "global_unsorted",
    sequence: 1,
    kind: "image",
    url: "/api/media/i.png",
  });
  assert.equal(globalUnsorted, "unsorted_0001.png");

  // 3. Project Unsorted: <project>_unsorted--p1000..._0001.mp4
  const projectUnsorted = resolveGenerationFilename({
    project: { id: "p1", name: "Commercial 2026" },
    ancestry: [],
    namespace: "project_unsorted:p1",
    sequence: 1,
    kind: "video",
    url: "/api/media/v.mp4",
  });
  assert.equal(projectUnsorted, "unsorted_0001.mp4");

  // 4. Project Folder: <project>_<folder>_...--f1000..._0042.png
  const projectFolder = resolveGenerationFilename({
    project: { id: "p1", name: "Client A" },
    ancestry: [{ id: "f1", name: "Storyboard" }],
    namespace: "folder:f1",
    sequence: 42,
    kind: "image",
    url: "/api/media/i.png",
  });
  assert.equal(projectFolder, "storyboard_0042.png");
});

test("resolveGenerationFilename: guards Windows reserved device names", () => {
  const nulName = resolveGenerationFilename({
    project: null,
    ancestry: [{ id: "f1", name: "NUL" }],
    namespace: "folder:f1",
    sequence: 1,
    kind: "image",
  });
  // Since "NUL" is Windows-reserved, it is prefixed with "_"
  assert.ok(nulName.startsWith("_nul"), `Expected _nul prefix, got: ${nulName}`);

  const conName = resolveGenerationFilename({
    project: null,
    ancestry: [{ id: "f1", name: "CON" }],
    namespace: "folder:f1",
    sequence: 1,
    kind: "video",
  });
  assert.ok(conName.startsWith("_con"), `Expected _con prefix, got: ${conName}`);
});

test("resolveGenerationFilename: bounds filename to 255 bytes and preserves entropy with hash", () => {
  const longName = "A".repeat(300);
  const result = resolveGenerationFilename({
    project: null,
    ancestry: [{ id: "f1", name: longName }],
    namespace: "folder:f1",
    sequence: 1,
    kind: "image",
  });

  const byteLength = Buffer.byteLength(result, "utf8");
  assert.ok(byteLength <= 255, `Byte length ${byteLength} exceeded 255 bytes`);
  assert.match(result, /_[a-f0-9]{16}_0001\.png$/, "Long paths retain a deterministic truncation hash");
});

test("resolveGenerationFilename: omits project names and internal namespace IDs", () => {
  const withToken = resolveGenerationFilename({
    project: { id: "12345678-abcd-1111-2222-333344445555", name: "A&B" },
    ancestry: [],
    namespace: "project_unsorted:12345678-abcd-1111-2222-333344445555",
    sequence: 1,
    kind: "image",
  });

  assert.equal(withToken, "unsorted_0001.png");
});

test("getNamespaceDisambiguator: extracts short deterministic ID", () => {
  assert.equal(getNamespaceDisambiguator("global_unsorted"), null);
  assert.equal(getNamespaceDisambiguator("folder:9c3f4e12-0000-1111-2222-333344445555"), "9c3f");
  assert.equal(getNamespaceDisambiguator("project_unsorted:a1b2c3d4-e5f6-7777-8888-999900001111"), "a1b2");
});

 test("reel and scene folders produce R01_SC001_0001 without project or ID decorations", () => {
  for (const kind of ["image", "video", "depth"]) {
    assert.equal(resolveGenerationFilename({project:{name:"My Project"},ancestry:[{name:"R01"},{name:"Sc001"}],namespace:"folder:random-internal-id",sequence:1,kind}), `R01_SC001_0001.${kind === "video" ? "mp4" : "png"}`);
  }
  assert.equal(resolveGenerationFilename({ancestry:[{name:"R01"},{name:"SC001"}],namespace:"folder:other-id",sequence:42}), "R01_SC001_0042.png");
});
