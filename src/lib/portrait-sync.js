import {
  listPortraitGroups,
  listAllPortraitAssets,
  upsertPortraitGroup,
  upsertPortraitAsset,
  getPortraitGroupByByteplusId,
  getPortraitAssetByByteplusId,
  deletePortraitGroup,
} from "./portrait-db.js";
import { getDb } from "./db.js";
import { portraitAssets } from "./schema.js";
import { eq } from "drizzle-orm";
import { byteplusAssetClient, getByteplusConfig } from "./byteplus-assets.js";

/**
 * Synchronizes portrait groups and assets between BytePlus ModelArk and the local database.
 * If BytePlus AK/SK is configured, it fetches remote groups and assets from BytePlus
 * and reconciles them into the local store.
 */
export async function syncByteplusPortraits(projectId) {
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
    // 1. Fetch remote groups from BytePlus ModelArk
    const bpGroupsRes = await byteplusAssetClient.listAssetGroups({
      groupType: "AIGC",
      projectName: "default",
      maxResults: 100,
    });
    const bpGroups = bpGroupsRes?.Items || [];

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
        const unlinked = groupsBefore.find(
          (g) =>
            !g.byteplusGroupId &&
            g.name.trim().toLowerCase() === (remoteGroup.Name || "").trim().toLowerCase()
        );
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

    // 3. Fetch remote assets from BytePlus ModelArk
    const bpAssetsRes = await byteplusAssetClient.listAssets({
      groupType: "AIGC",
      projectName: "default",
      maxResults: 100,
    });
    const bpAssets = bpAssetsRes?.Items || [];

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
        // Update URL or status if changed. Check base URL to avoid thrashing on dynamic query params.
        const remoteClean = (remoteAsset.URL || "").split("?")[0];
        const localClean = (localAsset.imageUrl || "").split("?")[0];
        const urlBaseChanged = Boolean(remoteClean && localClean !== remoteClean);
        const isRemoteTos = (localAsset.imageUrl || "").includes("tos-") || (remoteAsset.URL || "").includes("tos-");
        const olderThanOneHour = Date.now() - (localAsset.updatedAt || 0) > 3600000;
        if (
          localAsset.status !== remoteAsset.Status ||
          urlBaseChanged ||
          (isRemoteTos && remoteAsset.URL && olderThanOneHour)
        ) {
          await upsertPortraitAsset({
            ...localAsset,
            imageUrl: remoteAsset.URL || localAsset.imageUrl,
            status: remoteAsset.Status || localAsset.status,
            updatedAt,
          });
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
          try {
            let parentGroup = groups.find((g) => g.id === localAsset.groupId);
            if (!parentGroup?.byteplusGroupId) {
              const targetName = parentGroup?.name || "General Portraits";
              const existingBpGroup = bpGroups.find((g) => g.Name === targetName) || bpGroups[0];
              if (existingBpGroup?.Id) {
                const existingOwner = await getPortraitGroupByByteplusId(existingBpGroup.Id);
                if (existingOwner) {
                  if (existingOwner.id !== localAsset.groupId) {
                    const db = await getDb();
                    await db
                      .update(portraitAssets)
                      .set({ groupId: existingOwner.id })
                      .where(eq(portraitAssets.id, localAsset.id));
                    localAsset.groupId = existingOwner.id;
                  }
                  parentGroup = existingOwner;
                } else if (parentGroup) {
                  parentGroup = await upsertPortraitGroup({
                    ...parentGroup,
                    byteplusGroupId: existingBpGroup.Id,
                    updatedAt: Date.now(),
                  });
                }
              } else {
                const bpGroupRes = await byteplusAssetClient.createAssetGroup({
                  name: targetName,
                  description: parentGroup?.description || "Virtual Portrait Group",
                  groupType: "AIGC",
                  projectName: "default",
                });
                if (bpGroupRes?.Id && parentGroup) {
                  parentGroup = await upsertPortraitGroup({
                    ...parentGroup,
                    byteplusGroupId: bpGroupRes.Id,
                    updatedAt: Date.now(),
                  });
                }
              }
            }

            const targetGroupId = parentGroup?.byteplusGroupId || bpGroups[0]?.Id;
            if (targetGroupId) {
              const { signStoredRef } = await import("./storage.js");
              const signedUrl = (await signStoredRef(localAsset.imageUrl)) || localAsset.imageUrl;
              if (signedUrl && !signedUrl.startsWith("data:")) {
                const bpRes = await byteplusAssetClient.createAsset({
                  groupId: targetGroupId,
                  url: signedUrl,
                  name: localAsset.name || "Portrait",
                  assetType: "Image",
                });
                if (bpRes?.Id) {
                  localAsset.byteplusAssetId = bpRes.Id;
                  localAsset.status = bpRes.Status || "Active";
                  await upsertPortraitAsset({
                    ...localAsset,
                    byteplusAssetId: bpRes.Id,
                    status: bpRes.Status || "Active",
                    updatedAt: Date.now(),
                  });
                  if (bpRes.URL) {
                    bpUrlMap.set(bpRes.Id, bpRes.URL);
                  }
                }
              }
            }
          } catch (pushErr) {
            console.warn(`[portrait-sync] Auto-sync asset ${localAsset.id} to BytePlus:`, pushErr?.message);
          }
        }
      }
    }

    // Deduplicate any groups that share the same name (e.g. duplicate "General Portraits")
    const refreshedGroups = await listPortraitGroups();
    const seenGroupNames = new Map();
    const db = await getDb();
    for (const g of refreshedGroups) {
      const nameKey = (g.name || "").trim().toLowerCase();
      const existing = seenGroupNames.get(nameKey);
      if (existing) {
        const keep = existing.byteplusGroupId ? existing : (g.byteplusGroupId ? g : (existing.assets.length >= g.assets.length ? existing : g));
        const discard = keep.id === existing.id ? g : existing;

        if (discard.assets.length > 0) {
          await db
            .update(portraitAssets)
            .set({ groupId: keep.id })
            .where(eq(portraitAssets.groupId, discard.id));
        }
        await deletePortraitGroup(discard.id);
        seenGroupNames.set(nameKey, keep);
      } else {
        seenGroupNames.set(nameKey, g);
      }
    }

    const [finalGroups, finalAssets] = await Promise.all([
      listPortraitGroups(projectId),
      listAllPortraitAssets(projectId),
    ]);

    const freshAssets = finalAssets.map((a) => {
      const freshUrl = a.byteplusAssetId ? bpUrlMap.get(a.byteplusAssetId) : null;
      if (freshUrl) return { ...a, imageUrl: freshUrl };
      return a;
    });

    return { groups: finalGroups, assets: freshAssets, syncedWithByteplus: true };
  } catch (syncErr) {
    console.warn("[portrait-sync] Warning during BytePlus sync:", syncErr?.message);
    const [groups, assets] = await Promise.all([
      listPortraitGroups(projectId),
      listAllPortraitAssets(projectId),
    ]);
    return { groups, assets, syncedWithByteplus: false, syncError: syncErr?.message };
  }
}
