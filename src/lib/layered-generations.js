import { generationDownloadUrl, inlineMediaUrl, referenceDisplayUrl } from "./utils";

/** A decomposition's url remains its background master, never a composite. */
export function generationPieces(item, portraitAssets = []) {
  if (item?.kind !== "image" || !item.url || !Array.isArray(item.layers)) return [];
  const layers = item.layers
    .filter((layer) => typeof layer?.url === "string" && layer.url)
    .map((layer, index) => ({ ...layer, originalIndex: index }))
    .sort((a, b) => (a.zIndex ?? a.originalIndex) - (b.zIndex ?? b.originalIndex));
  if (!layers.length) return [];
  const pieces = [
    { key: "background", label: "Background", url: item.url },
    ...layers.map((layer, index) => ({
      ...layer,
      key: `layer-${layer.originalIndex}`,
      label: `Layer ${index + 1}`,
    })),
  ];
  const source = referenceDisplayUrl(item.referenceImages?.[0], portraitAssets);
  if (source) pieces.push({ key: "source", label: "Source", url: source });
  return pieces;
}

export function layeredResultLabel(pieces) {
  const count = pieces.filter((piece) => piece.key.startsWith("layer-")).length;
  return count ? `Background + ${count} ${count === 1 ? "layer" : "layers"}` : "";
}

/** Same-origin media streaming keeps download attributes effective and bytes original. */
export function pieceDownload(item, piece) {
  if (!piece || piece.key === "background") {
    return { url: generationDownloadUrl(item.id), filename: item.filename || true };
  }
  const stem = (item.filename || item.id).replace(/\.[^.]+$/, "");
  const extension = piece.url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1]
    || piece.url.match(/^data:image\/([a-z0-9]+)/i)?.[1];
  return {
    url: inlineMediaUrl(piece.url),
    filename: `${stem}_${piece.label.toLowerCase().replaceAll(" ", "_")}${extension ? `.${extension}` : ""}`,
  };
}
