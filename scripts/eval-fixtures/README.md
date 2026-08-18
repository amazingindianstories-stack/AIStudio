# Regression eval fixtures

Fixtures for `npm run eval:regression` (`scripts/eval-regression.js`). Each
fixture is a `*.json` file in this directory describing one prompt + one or
more reference images to run through the current image pipeline
(`assemblePrompt` → `generateImageGemini`) and judge with
`middleware/face-judge.js`'s `judgeCandidate` — the same judge the app's own
best-of-N path uses in production, not a separate scoring implementation.

## Why the actual images aren't committed here

This repo is **public**. Face-identity fixtures need real reference photos
to be meaningful, and committing real people's faces to a public git
history is not something this harness does, regardless of consent — git
history is effectively permanent. Every `*.json` fixture file in this
directory (except `example.fixture.json`) is gitignored, along with any
image files placed alongside it. Set your own fixtures up locally:

1. Copy `example.fixture.json` to `<name>.fixture.json`.
2. Put your reference image(s) in this directory (or anywhere on disk) and
   point `referenceImages` at them with paths relative to this file, or
   absolute paths.
3. Run `npm run eval:regression` once with `--update-floors` to establish
   this machine's baseline identity score for the fixture (generation is
   stochastic — the floor should be set from a real run, not guessed).
4. Run `npm run eval:regression` (no flag) on subsequent runs — it fails
   loudly if the average identity score drops meaningfully below the
   recorded floor, which is what "regression harness" means here: catching
   a `prompt-assembler.js`/`gemini.js`/`face-judge.js` change that quietly
   makes identity locking worse.

## Cost

**Every run makes real, billed Nano Banana Pro generations** — `samples`
per fixture (default 3), across however many fixture files exist. This is
never run automatically (see `scripts/eval-regression.js`'s own header for
why it's not wired into CI on this repo) — it's a manual, local tool, same
convention as `probe-seedance-audio.js` and friends.
