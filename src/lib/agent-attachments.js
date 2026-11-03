/** Agents tab documents: PDF, plain text, markdown and docx go up as 'document-reference' uploads the agent reads by id. */

import { uploadContentType, uploadFileDirect } from "./client-reference-upload";

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** One message carries at most this many documents. */
export const MAX_DOCUMENTS = 10;
export const ATTACH_ACCEPT = ["image/*", "video/*", "audio/*", ".pdf", ".txt", ".md", ".markdown", ".docx",
  "application/pdf", "text/plain", "text/markdown", DOCX].join(",");

const ALIASES = { "text/x-markdown": "text/markdown" };
const BY_EXTENSION = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown", docx: DOCX };
const DOCUMENT_TYPES = new Set(Object.values(BY_EXTENSION));

/** The canonical document type the upload purpose accepts, or null when `file` is not a document. */
export function documentType(file) {
  const supplied = uploadContentType(file).split(";")[0].trim();
  const type = ALIASES[supplied] || supplied;
  const named = BY_EXTENSION[String(file?.name || "").split(".").pop()?.toLowerCase()];
  // Browsers leave .md (and sometimes .docx) untyped, or call markdown plain text or a download.
  if (!type || type === "application/octet-stream" || (type === "text/plain" && named === "text/markdown")) return named || null;
  return DOCUMENT_TYPES.has(type) ? type : null;
}

/** Uploads one document and returns the chip the composer stages: `{ uploadId, name, contentType }`. */
export async function uploadAgentDocument(file, { upload = uploadFileDirect } = {}) {
  const contentType = documentType(file);
  if (!contentType) throw new Error(`Unsupported attachment: ${file?.name || "this file"}`);
  const typed = uploadContentType(file) === contentType ? file : new File([file], file.name, { type: contentType });
  const ready = await upload(typed, "document-reference");
  return { uploadId: ready.referenceId, name: file.name, contentType };
}
