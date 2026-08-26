import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildVideoDirective } from "@/lib/video-directive";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const backend = join(root, "backend");
const python = ["python3", "python"].find(
  (bin) => spawnSync(bin, ["-c", "import sys; sys.path.insert(0, 'backend'); import apps.generation.video_directive"], {
    cwd: root,
    encoding: "utf8",
  }).status === 0
);

const fixtures = [
  { prompt: "  Rain on a window, slow push in.  ", refCount: 0, tagSyntax: "angle" },
  { prompt: "She laughs and looks away.", refCount: 1, tagSyntax: "bracket" },
  { prompt: "Photorealistic 35mm film, wide shot of her turning.", refCount: 2, tagSyntax: "bracket" },
  {
    prompt: "Use [image 1] for her face and [image 2] for the exact style. She walks forward.",
    refCount: 2,
    tagSyntax: "bracket",
    refRoles: [[1, "person"], [2, "style"]],
  },
  {
    prompt: "<<<image_1>>> and <<<image_3>>> define the people; <<<image_2>>> is the location.",
    refCount: 3,
    tagSyntax: "angle",
    refRoles: [[3, "person"], [1, "person"], [2, "location"]],
  },
  {
    prompt: "Two views of the same person wave.",
    refCount: 2,
    tagSyntax: "angle",
    refRoles: [[1, "person"], [2, "person"]],
  },
];

test("JavaScript and Python video directives are byte-identical", { skip: !python }, () => {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(backend)})
from apps.generation.video_directive import build_video_directive
fixtures = json.load(sys.stdin)
print(json.dumps([
    build_video_directive(
        item["prompt"], item["refCount"], item["tagSyntax"],
        {int(index): role for index, role in item.get("refRoles", [])} or None,
    )
    for item in fixtures
]))
`;
  const result = spawnSync(python, ["-c", script], {
    cwd: root,
    input: JSON.stringify(fixtures),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pythonOutputs = JSON.parse(result.stdout);
  const jsOutputs = fixtures.map((fixture) =>
    buildVideoDirective({
      ...fixture,
      refRoles: fixture.refRoles ? new Map(fixture.refRoles) : undefined,
    })
  );
  assert.deepEqual(pythonOutputs, jsOutputs);
});
