export const GCS_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export function createResumableWriter(sessionUrl, { fetchImpl = fetch, chunkBytes = GCS_UPLOAD_CHUNK_BYTES } = {}) {
  let buffered = new Uint8Array(0); let uploaded = 0;
  async function send(bytes, final) {
    const end = uploaded + bytes.length - 1;
    const total = final ? uploaded + bytes.length : "*";
    const response = await fetchImpl(sessionUrl, { method: "PUT", headers: { "Content-Length": String(bytes.length), "Content-Range": `bytes ${uploaded}-${end}/${total}` }, body: bytes });
    if ((!final && response.status !== 308) || (final && !response.ok)) throw new Error(`resumable upload failed (${response.status})`);
    uploaded += bytes.length;
  }
  return {
    async write(part) {
      const next = new Uint8Array(buffered.length + part.length); next.set(buffered); next.set(part, buffered.length); buffered = next;
      while (buffered.length > chunkBytes) { await send(buffered.slice(0, chunkBytes), false); buffered = buffered.slice(chunkBytes); }
    },
    async finish() {
      if (!buffered.length) throw new Error("empty archive");
      await send(buffered, true); buffered = new Uint8Array(0); return uploaded;
    },
    get bufferedBytes() { return buffered.length; },
  };
}
