import assert from "node:assert/strict";
import test from "node:test";
import { depthStatusDelay, exportPollDelay } from "./poll-schedule.js";

test("export polling slows down for long jobs and backs off on errors", () => {
  assert.equal(exportPollDelay(0), 2000);
  assert.equal(exportPollDelay(20), 5000);
  assert.equal(exportPollDelay(100), 15000);
  assert.equal(exportPollDelay(3, 1), 5000);
  assert.equal(exportPollDelay(3, 3), 20000);
  assert.equal(exportPollDelay(3, 10), 60000);
});

test("depth worker status is checked rarely outside depth mode", () => {
  assert.equal(depthStatusDelay(true), 12000);
  assert.equal(depthStatusDelay(false), 60000);
});
