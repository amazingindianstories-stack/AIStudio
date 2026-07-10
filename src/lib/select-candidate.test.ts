/**
 * Unit tests for selectBestCandidate in src/lib/middleware/face-judge.ts — the
 * pure, composite-score selector used by JUDGE_COMPOSITE best-of-N picking.
 *
 * Derived from the "Interfaces" and "Test plan" sections of
 * .council/higgsfield-nbp-parity/design.md against the contract, not the
 * implementation. `selectBestCandidate` must be importable and callable
 * without GOOGLE_API_KEY or network access (it is documented as a pure
 * function; judgeCandidate/judgeIdentity in the same module are the only
 * network-touching exports, and they are not exercised here). Run:
 *   npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectBestCandidate, type CandidateScore } from "./middleware/face-judge";

test("selectBestCandidate: identity floor honored — lower-identity-but-within-slack candidate wins on composite", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 },
    { identity: 85, prominence: 99, sharpness: 99 },
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});

test("selectBestCandidate: floor excludes a high-composite candidate whose identity regresses beyond slack", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 }, // low composite, but the only one inside the floor
    { identity: 70, prominence: 99, sharpness: 99 }, // high composite, but 90-70=20 > slack 8
  ];
  assert.equal(selectBestCandidate(scores, 8), 0);
});

test("selectBestCandidate: all-null scores returns index 0", () => {
  const scores: Array<CandidateScore | null> = [null, null, null];
  assert.equal(selectBestCandidate(scores), 0);
});

test("selectBestCandidate: single all-null candidate array of length 1 returns index 0", () => {
  assert.equal(selectBestCandidate([null]), 0);
});

test("selectBestCandidate: mixed null + scored ignores nulls and picks the best eligible candidate", () => {
  const scores: Array<CandidateScore | null> = [
    null,
    { identity: 80, prominence: 50, sharpness: 50 }, // maxIdentity = 80, composite 100
    { identity: 60, prominence: 99, sharpness: 99 }, // 80-60=20 > slack 8, excluded despite high composite
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});

test("selectBestCandidate: a null candidate is never chosen over a real one, even at index 0", () => {
  const scores: Array<CandidateScore | null> = [
    null,
    { identity: 40, prominence: 5, sharpness: 5 },
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});

test("selectBestCandidate: composite tie breaks toward higher identity", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 80, prominence: 50, sharpness: 40 }, // composite 90
    { identity: 85, prominence: 40, sharpness: 50 }, // composite 90, higher identity
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});

test("selectBestCandidate: full tie (identical scores) breaks toward the lower index", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 80, prominence: 50, sharpness: 40 },
    { identity: 80, prominence: 50, sharpness: 40 },
  ];
  assert.equal(selectBestCandidate(scores, 8), 0);
});

test("selectBestCandidate: identity exactly at the floor boundary (max - slack) is included, not excluded", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 },
    { identity: 82, prominence: 99, sharpness: 99 }, // 90 - 8 = 82, exactly at the boundary
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});

test("selectBestCandidate: identity one point beyond the floor boundary is excluded", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 },
    { identity: 81, prominence: 99, sharpness: 99 }, // 81 < 82, just outside the floor
  ];
  assert.equal(selectBestCandidate(scores, 8), 0);
});

test("selectBestCandidate: default slack (no second argument) behaves as slack=8", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 },
    { identity: 85, prominence: 99, sharpness: 99 },
  ];
  assert.equal(selectBestCandidate(scores), 1);
});

test("selectBestCandidate: slack=0 requires exact identity match with the max to be eligible", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 90, prominence: 10, sharpness: 10 },
    { identity: 89, prominence: 99, sharpness: 99 },
  ];
  assert.equal(selectBestCandidate(scores, 0), 0);
});

test("selectBestCandidate: three-way field — highest identity dominates, then composite among eligible", () => {
  const scores: Array<CandidateScore | null> = [
    { identity: 95, prominence: 20, sharpness: 20 }, // max identity, composite 40
    { identity: 90, prominence: 60, sharpness: 60 }, // within slack 8 of 95, composite 120 (best eligible)
    { identity: 50, prominence: 100, sharpness: 100 }, // far outside floor, excluded
  ];
  assert.equal(selectBestCandidate(scores, 8), 1);
});
