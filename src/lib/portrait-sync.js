import {
  withPortraitReconciliation,
  listPortraitGroups,
  listAllPortraitAssets,
  upsertPortraitGroup,
  upsertPortraitAsset,
  getPortraitGroupByByteplusId,
  getPortraitAssetByByteplusId,
} from "./portrait-db.js";
import { listAllByteplusPages, unlinkedGlobalCandidate, portraitDisplayRef } from "./portrait-reconciliation.js";
import { byteplusAssetClient, getByteplusConfig } from "./byteplus-assets.js";

/** Diagnostic inventory never calls Create/Delete or local upserts. */
export async function inventoryByteplusPortraits() {
  const [groups, assets] = await Promise.all([listPortraitGroups(), listAllPortraitAssets()]);
  const local = {
    groups: groups.map((g) => ({ id: g.id, projectId: g.projectId ?? null, byteplusGroupId: g.byteplusGroupId ?? null })),
    assets: assets.map((a) => ({ id: a.id, groupId: a.groupId, byteplusAssetId: a.byteplusAssetId ?? null })),
  };
  if (getByteplusConfig().isMock) return { local, remote: null, inventoryError: "Live BytePlus asset credentials unavailable." };
  const signal = AbortSignal.timeout(45000);
  const input = { groupType: "AIGC", projectName: "default" };
  const remoteGroups = await listAllByteplusPages(byteplusAssetClient.listAssetGroups, input, { signal });
  const remoteAssets = await listAllByteplusPages(byteplusAssetClient.listAssets, input, { signal });
  const localAssetIds = new Set(assets.map((a) => a.byteplusAssetId).filter(Boolean));
  const remoteAssetIds = new Set(remoteAssets.items.map((a) => a.Id));
  return { local, remote: {
    groups: remoteGroups.items.map((g) => ({ id: g.Id })),
    assets: remoteAssets.items.map((a) => ({ id: a.Id, groupId: a.GroupId })),
    groupPages: remoteGroups.pages, assetPages: remoteAssets.pages,
  }, remoteAssetsMissingLocally: [...remoteAssetIds].filter((id) => !localAssetIds.has(id)),
    localAssetsMissingRemotely: [...localAssetIds].filter((id) => !remoteAssetIds.has(id)) };
}

/**
 * Synchronizes portrait groups and assets between BytePlus ModelArk and the local database.
 * If BytePlus AK/SK is configured, it fetches remote groups and assets from BytePlus
 * and reconciles them into the local store.
 */
export async function syncByteplusPortraits(projectId) {
  if (getByteplusConfig().isMock) return reconcilePortraits(projectId);
  try {
    return await withPortraitReconciliation(() => reconcilePortraits(projectId));
  } catch {
    const [groups, assets] = await Promise.all([listPortraitGroups(projectId), listAllPortraitAssets(projectId)]);
    return { groups, assets, syncedWithByteplus: false, syncError: "Portrait synchronization busy or incomplete; local records preserved." };
  }
}

async function reconcilePortraits(projectId) {
  const config = getByteplusConfig();

  // If mock/no credentials configured, return local DB contents directly
  if (config.isMock) {
    try {
      const [groups, assets] = await Promise.all([
        listPortraitGroups(projectId),
        listAllPortraitAssets(projectId),
      ]);
      return { groups, assets, syncedWithByteplus: false };
    } catch (err) {
      return { groups: [], assets: [], syncedWithByteplus: false, error: err?.message };
    }
  }

  try {
    const signal = AbortSignal.timeout(45000);
    const input = { groupType: "AIGC", projectName: "default" };
    const groupInventory = await listAllByteplusPages(byteplusAssetClient.listAssetGroups, input, { signal });
    const assetInventory = await listAllByteplusPages(byteplusAssetClient.listAssets, input, { signal });
    const bpGroups = groupInventory.items;
    const bpAssets = assetInventory.items;
    const pushErrors = [];

    // 2. Reconcile groups into local DB
    const bpGroupMap = new Map(); // byteplusGroupId -> localGroup
    for (const remoteGroup of bpGroups) {
      let localGroup = await getPortraitGroupByByteplusId(remoteGroup.Id);
      const createdAt = remoteGroup.CreateTime
        ? new Date(remoteGroup.CreateTime).getTime()
        : Date.now();
      const updatedAt = remoteGroup.UpdateTime
        ? new Date(remoteGroup.UpdateTime).getTime()
        : Date.now();

      if (!localGroup) {
        const groupsBefore = await listPortraitGroups();
        const unlinked = unlinkedGlobalCandidate(groupsBefore, remoteGroup, bpGroups);
        if (unlinked) {
          localGroup = await upsertPortraitGroup({
            ...unlinked,
            byteplusGroupId: remoteGroup.Id,
            updatedAt,
          });
        } else {
          const id = crypto.randomUUID();
          localGroup = await upsertPortraitGroup({
            id,
            byteplusGroupId: remoteGroup.Id,
            name: remoteGroup.Name || "Untitled Group",
            description: remoteGroup.Description || "",
            groupType: remoteGroup.GroupType || "AIGC",
            projectName: remoteGroup.ProjectName || "default",
            createdAt,
            updatedAt,
          });
        }
      } else if (localGroup.name !== remoteGroup.Name) {
        localGroup = await upsertPortraitGroup({
          ...localGroup,
          name: remoteGroup.Name || localGroup.name,
          updatedAt,
        });
      }
      bpGroupMap.set(remoteGroup.Id, localGroup);
    }

    // 4. Reconcile assets into local DB
    for (const remoteAsset of bpAssets) {
      let localGroup = bpGroupMap.get(remoteAsset.GroupId);
      if (!localGroup) {
        localGroup = await getPortraitGroupByByteplusId(remoteAsset.GroupId);
      }
      if (!localGroup) {
        // Group not yet registered locally, create placeholder
        const groupId = crypto.randomUUID();
        localGroup = await upsertPortraitGroup({
          id: groupId,
          byteplusGroupId: remoteAsset.GroupId,
          name: remoteAsset.Name || "Portrait Group",
          description: "",
          groupType: "AIGC",
          projectName: "default",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        bpGroupMap.set(remoteAsset.GroupId, localGroup);
      }

      let localAsset = await getPortraitAssetByByteplusId(remoteAsset.Id);
      const createdAt = remoteAsset.CreateTime
        ? new Date(remoteAsset.CreateTime).getTime()
        : Date.now();
      const updatedAt = remoteAsset.UpdateTime
        ? new Date(remoteAsset.UpdateTime).getTime()
        : Date.now();

      if (!localAsset) {
        const assetId = crypto.randomUUID();
        await upsertPortraitAsset({
          id: assetId,
          groupId: localGroup.id,
          byteplusAssetId: remoteAsset.Id,
          name: remoteAsset.Name || localGroup.name || "Portrait",
          assetType: remoteAsset.AssetType || "Image",
          role: "reference",
          imageUrl: remoteAsset.URL,
          status: remoteAsset.Status || "Active",
          createdAt,
          updatedAt,
        });
      } else {
        const imageUrl = portraitDisplayRef(localAsset.imageUrl, remoteAsset.URL);
        if (localAsset.status !== remoteAsset.Status || imageUrl !== localAsset.imageUrl) {
          await upsertPortraitAsset({ ...localAsset, imageUrl,
            status: remoteAsset.Status || localAsset.status, updatedAt });
        }
      }
    }

    const [groups, assets] = await Promise.all([
      listPortraitGroups(),
      listAllPortraitAssets(),
    ]);

    // Ensure in-memory assets returned to the client carry the freshly-signed BytePlus URLs
    const bpUrlMap = new Map(bpAssets.filter((a) => a.URL).map((a) => [a.Id, a.URL]));

    // 5. Auto-sync any local assets missing BytePlus ID to BytePlus ModelArk
    if (!config.isMock) {
      for (const localAsset of assets) {
        if (!localAsset.byteplusAssetId && localAsset.imageUrl) {
          // A timed-out Create may already have succeeded remotely. Never replay it
          // automatically without a stable identity; surface it for reconciliation.
          if (localAsset.statusMessage === "registration_outcome_unknown" ||
              assets.some((a) => a.groupId === localAsset.groupId && a.statusMessage === "group_registration_outcome_unknown")) {
            pushErrors.push({ id: localAsset.id, code: "registration_outcome_unknown" });
            continue;
          }
          try {
            let parentGroup = groups.find((g) => g.id === localAsset.groupId);
            if (!parentGroup?.byteplusGroupId) {
              const targetName = parentGroup?.name || "General Portraits";
              if (!parentGroup) throw new Error("Portrait parent group missing.");
              localAsset.statusMessage = "group_registration_outcome_unknown";
              await upsertPortraitAsset(localAsset);
              // Never borrow a same-name or arbitrary remote group from another scope.
              const bpGroupRes = await byteplusAssetClient.createAssetGroup({
                name: targetName, description: parentGroup.description || "Virtual Portrait Group",
                groupType: "AIGC", projectName: "default",
              }, { signal });
              if (!bpGroupRes?.Id) throw new Error("BytePlus did not return a group identity.");
              parentGroup = await upsertPortraitGroup({ ...parentGroup,
                byteplusGroupId: bpGroupRes.Id, updatedAt: Date.now() });
              Object.assign(groups.find((g) => g.id === parentGroup.id), parentGroup);
              localAsset.statusMessage = null;
              await upsertPortraitAsset(localAsset);
            }

            const targetGroupId = parentGroup?.byteplusGroupId;
            if (targetGroupId) {
              const { signStoredRef } = await import("./storage.js");
              const signedUrl = (await signStoredRef(localAsset.imageUrl)) || localAsset.imageUrl;
              if (signedUrl && !signedUrl.startsWith("data:")) {
                localAsset.statusMessage = "registration_outcome_unknown";
                await upsertPortraitAsset(localAsset);
                const bpRes = await byteplusAssetClient.createAsset({
                  groupId: targetGroupId,
                  url: signedUrl,
                  name: localAsset.name || "Portrait",
                  assetType: "Image",
                }, { signal });
                if (bpRes?.Id) {
                  localAsset.byteplusAssetId = bpRes.Id;
                  localAsset.status = bpRes.Status || "Active";
                  localAsset.statusMessage = null;
                  await upsertPortraitAsset({
                    ...localAsset,
                    byteplusAssetId: bpRes.Id,
                    status: bpRes.Status || "Active",
                    updatedAt: Date.now(),
                  });
                  if (bpRes.URL) {
                    bpUrlMap.set(bpRes.Id, bpRes.URL);
                  }
                } else throw new Error("BytePlus did not return an asset identity.");
              }
            }
          } catch (pushErr) {
            pushErrors.push({ id: localAsset.id, code: pushErr.code || "registration_failed" });
          }
        }
      }
    }

    const [finalGroups, finalAssets] = await Promise.all([
      listPortraitGroups(projectId),
      listAllPortraitAssets(projectId),
    ]);

    const freshAssets = finalAssets.map((a) => {
      const freshUrl = a.byteplusAssetId ? bpUrlMap.get(a.byteplusAssetId) : null;
      if (freshUrl) return { ...a, imageUrl: portraitDisplayRef(a.imageUrl, freshUrl) };
      return a;
    });

    const displayAssets = new Map(freshAssets.map((a) => [a.id, a]));
    return { groups: finalGroups.map((g) => ({ ...g, assets: g.assets.map((a) => displayAssets.get(a.id) || a) })),
      assets: freshAssets, syncedWithByteplus: pushErrors.length === 0,
      ...(pushErrors.length ? { syncError: "Some portraits could not be registered; local records preserved.", registrationErrors: pushErrors } : {}),
      inventory: { groupPages: groupInventory.pages, assetPages: assetInventory.pages,
        remoteGroups: bpGroups.length, remoteAssets: bpAssets.length } };
  } catch (syncErr) {
    console.warn("[portrait-sync] Sync incomplete:", syncErr?.code || syncErr?.name || "sync_failed");
    const [groups, assets] = await Promise.all([
      listPortraitGroups(projectId),
      listAllPortraitAssets(projectId),
    ]);
    return { groups, assets, syncedWithByteplus: false, syncError: "Portrait synchronization incomplete; local records preserved." };
  }
}
