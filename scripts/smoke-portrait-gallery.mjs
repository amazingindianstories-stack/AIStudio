#!/usr/bin/env node
/**
 * Smoke Test: BytePlus ModelArk Asset Library (Portrait Gallery)
 *
 * Verifies:
 * 1. Image validation per BytePlus Doc 2333565 (dimensions, aspect ratio, mime types)
 * 2. Signature V4 OpenAPI HMAC-SHA256 request signer
 * 3. BytePlus Asset Client lifecycle (createGroup -> createAsset -> getAsset -> deleteAsset -> deleteGroup)
 * 4. Seedance video payload construction with asset:// URI preservation
 */

import assert from "node:assert/strict";
import sharp from "sharp";
import {
  signByteplusRequest,
  validatePortraitImage,
  byteplusAssetClient,
  resetMockStore,
  MIN_ASPECT_RATIO,
  MAX_ASPECT_RATIO,
} from "../src/lib/byteplus-assets.js";
import { createVideoTask } from "../src/lib/providers/seedance.js";
import { resolveReferences } from "../src/lib/mentions.js";

console.log("=================================================");
console.log("  SMOKE TEST: Portrait Gallery & BytePlus Assets  ");
console.log("=================================================\n");

let passedSteps = 0;
let totalSteps = 0;

async function step(name, fn) {
  totalSteps++;
  process.stdout.write(`[${totalSteps}] ${name}... `);
  try {
    await fn();
    console.log("PASSED");
    passedSteps++;
  } catch (err) {
    console.log("FAILED");
    console.error("   Error:", err.message || err);
    throw err;
  }
}

try {
  // Step 1: Validate compliant reference image
  await step("Image Validator: compliant portrait (500x750 PNG)", async () => {
    const validBuffer = await sharp({
      create: {
        width: 500,
        height: 750, // Aspect ratio ~0.67 (valid 0.4 - 2.5)
        channels: 3,
        background: { r: 120, g: 140, b: 180 },
      },
    })
      .png()
      .toBuffer();

    const result = await validatePortraitImage(validBuffer);
    assert.equal(result.width, 500);
    assert.equal(result.height, 750);
    assert.equal(result.format, "png");
    assert.ok(result.ratio >= MIN_ASPECT_RATIO && result.ratio <= MAX_ASPECT_RATIO);
  });

  // Step 2: Validate image rejection on out-of-bounds dimension
  await step("Image Validator: reject small image (<300px)", async () => {
    const tooSmall = await sharp({
      create: {
        width: 250,
        height: 250,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    let threw = false;
    try {
      await validatePortraitImage(tooSmall);
    } catch (err) {
      threw = true;
      assert.match(err.message, /between 300px and 6000px/i);
    }
    assert.ok(threw, "Should have thrown for dimensions < 300px");
  });

  // Step 3: Validate image rejection on extreme aspect ratio
  await step("Image Validator: reject extreme panorama (aspect ratio > 2.5)", async () => {
    const wideBanner = await sharp({
      create: {
        width: 1500,
        height: 400, // 3.75:1 aspect ratio
        channels: 3,
        background: { r: 50, g: 50, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();

    let threw = false;
    try {
      await validatePortraitImage(wideBanner);
    } catch (err) {
      threw = true;
      assert.match(err.message, /aspect ratio/i);
    }
    assert.ok(threw, "Should have thrown for aspect ratio > 2.5");
  });

  // Step 4: Verify Signature V4 formatting
  await step("BytePlus Signature V4: HMAC-SHA256 authorization headers", () => {
    const signed = signByteplusRequest({
      method: "POST",
      pathname: "/",
      query: { Version: "2024-01-01", Action: "CreateAssetGroup" },
      headers: { "content-type": "application/json", host: "ark.ap-southeast-1.byteplusapi.com" },
      body: JSON.stringify({ Name: "SmokeTestGroup", GroupType: "AIGC" }),
      ak: "MOCK_AK_FOR_SMOKE",
      sk: "MOCK_SK_FOR_SMOKE",
      region: "ap-southeast-1",
      service: "ark",
      date: new Date("2026-09-16T12:00:00Z"),
    });

    assert.equal(signed.xDate, "20260916T120000Z");
    assert.match(signed.headers.Authorization, /^HMAC-SHA256 Credential=MOCK_AK_FOR_SMOKE\/20260916\/ap-southeast-1\/ark\/request/);
    assert.match(signed.headers.Authorization, /Signature=[a-f0-9]{64}$/);
    assert.equal(signed.headers["x-date"], "20260916T120000Z");
    assert.equal(signed.headers["x-content-sha256"].length, 64);
  });

  // Step 5: BytePlus Asset Client lifecycle (mock / sandbox)
  await step("BytePlus Asset Client: full lifecycle in mock mode", async () => {
    resetMockStore();

    // 1. Create group
    const grp = await byteplusAssetClient.createAssetGroup({
      name: "Aria Sterling",
      description: "Cyberpunk protagonist persona",
      groupType: "AIGC",
    });
    assert.ok(grp.Id, "Expected group Id");

    // 2. Register asset
    const asset = await byteplusAssetClient.createAsset({
      groupId: grp.Id,
      url: "https://example.com/portraits/aria-front.jpg",
      name: "Front Portrait",
      assetType: "Image",
    });
    assert.ok(asset.Id, "Expected asset Id");

    // 3. Query asset status
    const fetchedAsset = await byteplusAssetClient.getAsset(asset.Id);
    assert.equal(fetchedAsset.Id, asset.Id);
    assert.equal(fetchedAsset.Status, "Active");

    // 4. Delete asset
    const delAsset = await byteplusAssetClient.deleteAsset(asset.Id);
    assert.equal(delAsset.Id, asset.Id);

    // 5. Delete group
    const delGrp = await byteplusAssetClient.deleteAssetGroup(grp.Id);
    assert.equal(delGrp.Id, grp.Id);
  });

  // Step 6: Verify Seedance video provider accepts asset:// URIs
  await step("Seedance 2.0: accepts asset:// URIs as reference images", async () => {
    let sentBody = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          id: "task-seedance-smoke-123",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    try {
      process.env.ARK_API_KEY = "mock_key";
      process.env.BYTEPLUS_API_KEY = "mock_key";
      const prompt = "Cinematic medium close-up of @img1 speaking in neon-lit room";
      const resolvedRefs = resolveReferences(prompt, ["asset://asset_smoke_aria_001"]);
      const result = await createVideoTask({
        prompt,
        modelDisplay: "Seedance 2.0",
        ratio: "16:9",
        duration: 5,
        resolution: "1080p",
        references: resolvedRefs,
      });

      assert.equal(result, "task-seedance-smoke-123");
      assert.ok(sentBody);
      assert.equal(sentBody.content[0].type, "text");
      assert.equal(sentBody.content[1].type, "image_url");
      assert.equal(sentBody.content[1].image_url.url, "asset://asset_smoke_aria_001");
      assert.equal(sentBody.content[1].role, "reference_image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\nAll ${passedSteps}/${totalSteps} smoke test checks passed cleanly!`);
  process.exit(0);
} catch (_err) {
  console.error(`\nSmoke test halted after ${passedSteps}/${totalSteps} checks.`);
  process.exit(1);
}
