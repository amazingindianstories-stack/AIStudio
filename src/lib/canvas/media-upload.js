import { apiFetch } from '../api';
import { uploadContentType, uploadFileDirect } from '../client-reference-upload';

export const BOARD_FILE_ACCEPT = 'image/*,.psd,.pdf,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm';
export function isBoardFile(file) {
  return /^(image\/|video\/(mp4|quicktime|webm)$|audio\/(mpeg|wav|ogg|mp4|webm)$|application\/pdf$)/.test(uploadContentType(file));
}
const SERVER_RASTERIZED = new Set(['image/svg+xml', 'image/vnd.adobe.photoshop', 'image/x-photoshop']);
export function isBrowserImage(file) {
  const type = uploadContentType(file);
  return type.startsWith('image/') && !SERVER_RASTERIZED.has(type);
}

async function responseJson(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not import file.');
  return value;
}

export async function awaitBoardMedia(value, boardId, { signal, fetchImpl = apiFetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (value.state === 'queued' || value.state === 'running') {
    if (signal?.aborted) throw new Error('Import cancelled.');
    if (Date.now() > deadline) throw new Error('Conversion is still running. Find the completed file in Saved files later.');
    await pause(1500);
    value = await responseJson(await fetchImpl(`/api/canvas-boards/${boardId}/media/${value.id}`, { signal }));
  }
  if (value.state === 'failed') throw new Error(value.error || 'File conversion failed.');
  return value;
}

export async function uploadBoardFile(file, boardId, options = {}) {
  const uploaded = await uploadFileDirect(file, 'canvas', { signal: options.signal });
  const response = await apiFetch(`/api/canvas-boards/${boardId}/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenceId: uploaded.referenceId }), signal: options.signal,
  });
  return awaitBoardMedia(await responseJson(response), boardId, options);
}

export async function importBoardUrl(url, boardId, options = {}) {
  const response = await apiFetch(`/api/canvas-boards/${boardId}/import-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: options.signal,
  });
  return awaitBoardMedia(await responseJson(response), boardId, options);
}

export function mediaNodeFields(file) {
  if (file.node) return file.node;
  const type = file.contentType?.startsWith('video/') ? 'video'
    : file.contentType?.startsWith('audio/') ? 'audio' : file.contentType === 'application/pdf' ? 'pdf' : 'image';
  return { type, src: file.url, ...(type === 'pdf' ? { name: file.name, pages: file.pages, page: 1 }
    : type === 'image' ? { alt: file.name } : { title: file.name }),
    ...(file.naturalW ? { naturalW: file.naturalW, naturalH: file.naturalH } : {}), aspectLocked: true };
}
