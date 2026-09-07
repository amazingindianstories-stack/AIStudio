"use client";
export async function uploadOriginalReference(file) {
  const response = await fetch("/api/uploads/presign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "image-reference", contentType: file.type }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not prepare reference upload.");
  const uploaded = await fetch(body.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!uploaded.ok) throw new Error("Reference upload failed. Try uploading the file again.");
  return `/api/media/${body.key}`;
}
