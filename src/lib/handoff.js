import { apiUrl } from "./api";

export function handoffManifest(
  items,
  origin,
  exportedAt = new Date().toISOString(),
) {
  return {
    format: "veevee-handoff-v1",
    exportedAt,
    description:
      "Ordered take manifest. Media links require authorized VeeVee access; media files are not embedded.",
    takes: items.map((item, index) => ({
      order: index + 1,
      id: item.id,
      projectId: item.projectId,
      folderId: item.folderId,
      kind: item.kind,
      mediaUrl: item.url ? new URL(apiUrl(item.url), origin).href : null,
      prompt: item.prompt,
      model: item.model,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution,
      duration: item.duration,
      seed: item.seed,
      generateAudio: item.generateAudio,
      referenceImages: item.referenceImages,
      referenceVideos: item.referenceVideos,
      productionMetadata: item.productionMetadata || {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}
