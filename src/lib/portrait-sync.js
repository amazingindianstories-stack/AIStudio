import {
  listPortraitGroups,
  listAllPortraitAssets,
  upsertPortraitGroup,
  upsertPortraitAsset,
  getPortraitGroupByByteplusId,
  getPortraitAssetByByteplusId,
} from "./portrait-db.js";
import { byteplusAssetClient, getByteplusConfig } from "./byteplus-assets.js";

/**
 * Synchronizes portrait groups and assets between BytePlus ModelArk and the local database.
 * If BytePlus AK/SK is configured, it fetches remote groups and assets from BytePlus
 * and reconciles them into the local store.
 */
export async function syncByteplusPortraits() {
  const config = getByteplusConfig();

  // If mock/no credentials configured, return local DB contents directly
  if (config.isMock) {
    try {
      const [groups, assets] = await Promise.all([
        listPortraitGroups(),
        listAllPortraitAssets(),
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
    const freshAssets = assets.map((a) => {
      const freshUrl = a.byteplusAssetId ? bpUrlMap.get(a.byteplusAssetId) : null;
      if (freshUrl) return { ...a, imageUrl: freshUrl };
      return a;
    });

    return { groups, assets: freshAssets, syncedWithByteplus: true };
  } catch (syncErr) {
    console.warn("[portrait-sync] Warning during BytePlus sync:", syncErr?.message);
    const [groups, assets] = await Promise.all([
      listPortraitGroups(),
      listAllPortraitAssets(),
    ]);
    return { groups, assets, syncedWithByteplus: false, syncError: syncErr?.message };
  }
}
