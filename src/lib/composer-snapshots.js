/** Metadata only. Never persist binary data or signed storage/session bearers. */
export function persistentMediaRef(ref) {
  if (typeof ref !== 'string' || /^(data:|blob:)/i.test(ref)) return false;
  if (/^asset:\/\/[a-zA-Z0-9_-]+(?:#bp_asset_id=[a-zA-Z0-9_%_-]+)?$/.test(ref)) return true;
  if (/^\/api\/media\/[^?]+(?:#.*)?$/.test(ref)) return true;
  try {
    const url = new URL(ref);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search;
  } catch { return false; }
}

export function snapshotScope(state) {
  return state.currentUser?.id ? `${state.currentUser.id}:${state.activeProjectId || 'global'}:${state.activeConversationId || 'studio'}` : null;
}

export function composerMetadata(state) {
  // Omit unavailable occurrences with an explicit gap instead of shifting @imgN.
  const refs = state.referenceImages.map((ref, i) => ({ uiId: state.referenceIds[i],
    mediaRef: persistentMediaRef(ref) ? ref : null, kind: state.referenceKinds[i] || 'image',
    label: state.referenceLabels?.[i] || '', tag: state.referenceTags?.[i] || '' }));
  return { version: 1, prompt: state.prompt, refs,
    referenceVideos: state.referenceVideos.filter(persistentMediaRef),
    referenceAudios: state.referenceAudios.filter(persistentMediaRef), savedAt: Date.now(),
    revisionId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    recent: state.recentSubmission ? composerMetadata({...state,...state.recentSubmission,recentSubmission:null}) : null };
}

export function metadataToDraft(metadata, createId) {
  const refs = Array.isArray(metadata.refs) ? metadata.refs.slice(0,50) : [];
  return {prompt:metadata.prompt || '', referenceImages:refs.map(ref => ref.mediaRef || ''),
    referenceIds:refs.map(ref => ref.uiId || createId()), referenceKinds:refs.map(ref => ref.kind || 'image'),
    referenceLabels:refs.map(ref => ref.label || ''), referenceTags:refs.map(ref => ref.tag || ''),
    referenceVideos:metadata.referenceVideos || [], referenceAudios:metadata.referenceAudios || [],
    videoNotes:(metadata.referenceVideos || []).map((ref,i) => ({ref,name:`Clip ${i+1}`})),
    audioNotes:(metadata.referenceAudios || []).map((ref,i) => ({ref,name:`Audio ${i+1}`}))};
}

function openSnapshots() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Draft storage unavailable'));
    const request = indexedDB.open('veevee-composer-metadata', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

export async function saveComposerSnapshot(scope, value) {
  if (!scope) return;
  // A small metadata journal closes the navigation window before IDB commits.
  // It contains no binaries/bearers and only one actor-scoped pending revision.
  try {
    const journal = JSON.stringify({scope,value});
    if (journal.length <= 262144) localStorage.setItem('veevee-composer-pending-metadata',journal);
  } catch { /* IDB remains the primary store when Web Storage is denied. */ }
  const db = await openSnapshots();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      const drafts = tx.objectStore('drafts');
      drafts.put(value, scope);
      const records = [];
      const cursor = drafts.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current) {
          records.push({ key:current.key, savedAt:current.value.savedAt || 0 });
          current.continue();
        } else {
          records.sort((a,b) => b.savedAt-a.savedAt);
          for (const record of records.slice(20)) drafts.delete(record.key);
          for (const record of records) if (record.savedAt < Date.now()-30*86400000) drafts.delete(record.key);
        }
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    try {
      const pending = JSON.parse(localStorage.getItem('veevee-composer-pending-metadata') || 'null');
      if (pending?.scope === scope && pending.value.revisionId === value.revisionId) localStorage.removeItem('veevee-composer-pending-metadata');
    } catch {}
  } finally { db.close(); }
}

export async function loadComposerSnapshot(scope) {
  if (!scope) return null;
  let pending = null;
  try {
    const journal = JSON.parse(localStorage.getItem('veevee-composer-pending-metadata') || 'null');
    if (journal?.scope === scope && journal.value?.version === 1) pending = journal.value;
  } catch {}
  const db = await openSnapshots();
  try {
    const committed = await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(scope);
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
    return pending && pending.savedAt >= (committed?.savedAt || 0) ? pending : committed;
  } finally { db.close(); }
}
