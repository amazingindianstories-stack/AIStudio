import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";
import { portraitLibraryFull } from "./portrait-readiness";

test("a quota rejection on upload marks the library full; a confirmed remote delete frees it", async () => {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  try {
    useStore.setState({ portraitQuotaFullAt: 0, portraitQuotaFreedAt: 0, activeProjectId: null,
      portraitAssets: [{ id: "a1", groupId: "g1", status: "Active", byteplusAssetId: "bp1", updatedAt: 1 }],
      portraitGroups: [{ id: "g1" }] });
    globalThis.fetch = async () => new Response(JSON.stringify({ asset: { id: "n1" }, registrationErrorCode: "QuotaSharedPoolExceeded", registrationError: "QuotaSharedPoolExceeded" }), { status: 200 });
    const uploaded = await useStore.getState().uploadPortraitImageDirect({ referenceId: "r1", name: "Sati" });
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.libraryFull, true);
    let state = useStore.getState();
    assert.equal(portraitLibraryFull(state.portraitAssets, { fullAt: state.portraitQuotaFullAt, freedAt: state.portraitQuotaFreedAt }).full, true);

    // The upload reloads the gallery through the same stub; restore the listing for the delete step.
    useStore.setState({ portraitAssets: [{ id: "a1", groupId: "g1", status: "Active", byteplusAssetId: "bp1", updatedAt: 1 }], portraitGroups: [{ id: "g1" }] });
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, assetId: "a1", groupId: "g1", remoteDeletion: "confirmed" }), { status: 200 });
    const removed = await useStore.getState().deletePortraitAssetDirect("a1");
    assert.deepEqual(removed, { ok: true, freedSpace: true });
    state = useStore.getState();
    const capacity = portraitLibraryFull(state.portraitAssets, { fullAt: state.portraitQuotaFullAt, freedAt: state.portraitQuotaFreedAt });
    assert.equal(capacity.full, false);
    assert.equal(capacity.freedSince, true);
  } finally {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  }
});
