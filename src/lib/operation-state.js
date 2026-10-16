/** Independent entities progress concurrently; conflicting operations serialize. */
export function installOperationTracking(store) {
  const inflight = new Map();
  const tails = new Map();
  const retries = new Map();
  const cancelled = new Set();
  const actions = ['createFolder','renameFolder','setFolderColor','deleteFolder','moveFolder','moveGenerationsToDestination'];
  const patch = (logical, value) => {
    const entries = Object.entries(store.getState().operations || {}).filter(([key]) => key !== logical);
    store.setState({ operations: Object.fromEntries([...entries.slice(-39), [logical, value]]) });
  };
  store.setState({cancelFolderOperation: logical => {
    const operation = store.getState().operations?.[logical];
    if (operation?.status !== 'queued') return false;
    cancelled.add(logical);
    retries.delete(logical);
    patch(logical,{...operation,status:'cancelled',error:null});
    return true;
  }});
  for (const name of actions) {
    const original = store.getState()[name];
    store.setState({ [name]: (...args) => {
      const actor = store.getState().currentUser?.id || 'anonymous';
      const logical = JSON.stringify([actor, name, args]);
      if (inflight.has(logical)) return inflight.get(logical);
      const entity = name === 'createFolder' ? JSON.stringify([actor,'create',args[0]?.parentId ?? args[0]]) : JSON.stringify([actor, args[0]?.id ?? args[0]?.folderId ?? (name === 'renameFolder' && typeof args[2] === 'string' || name === 'deleteFolder' && typeof args[1] === 'string' ? args[1] : args[0])]);
      const previous = retries.get(logical);
      const key = previous?.key || globalThis.crypto?.randomUUID?.() || `op-${Date.now()}-${Math.random()}`;
      const attempt = (previous?.attempt || store.getState().operations?.[logical]?.attempt || 0) + 1;
      const state = { key, status:'queued', startedAt:Date.now(), error:null, attempt, operation:name, entity, total:name === 'moveGenerationsToDestination' ? new Set(args[0] || []).size : undefined };
      retries.set(logical, state); patch(logical,state);
      let callArgs = structuredClone(args);
      if (typeof args[0] === 'object' && args[0] !== null && name !== 'moveGenerationsToDestination') callArgs[0] = {...args[0],idempotencyKey:key};
      else {
        const slot = name === 'createFolder' ? 3 : name === 'setFolderColor' ? 2 : name === 'moveFolder' || name === 'moveGenerationsToDestination' ? 3 : name === 'renameFolder' ? (typeof args[2] === 'string' ? 4 : 3) : (typeof args[1] === 'string' ? 2 : 1);
        callArgs[slot] = key;
      }
      const promise = (tails.get(entity) || Promise.resolve()).catch(() => {}).then(async () => {
        try {
          if (cancelled.delete(logical)) throw Object.assign(new Error('Queued operation cancelled.'), {cancelled:true});
          if ((store.getState().currentUser?.id || 'anonymous') !== actor) throw Object.assign(new Error('User changed before queued operation.'), {cancelled:true});
          if (previous?.arguments) callArgs = previous.arguments;
          else {
            const current = store.getState();
            const find = nodes => {
              for (const node of nodes || []) {
                if (String(node.id) === String(JSON.parse(entity)[1])) return node;
                const found = find(node.children || node.folders);
                if (found) return found;
              }
              return null;
            };
            if (name === 'renameFolder' || name === 'moveFolder') {
              const node = find(current.libraryTree?.globalFolders) || find(current.libraryTree?.projects);
              if (node?.version !== undefined) {
                if (typeof callArgs[0] === 'object' && callArgs[0] !== null) callArgs[0] = {...callArgs[0],expectedVersion:callArgs[0].expectedVersion ?? node.version};
                else {
                  const slot = name === 'renameFolder' && typeof args[2] === 'string' ? 3 : 2;
                  if (callArgs[slot] === undefined) callArgs[slot] = node.version;
                }
              }
            }
            if (name === 'moveGenerationsToDestination' && callArgs[2] === undefined) {
              callArgs[2] = {};
              for (const id of callArgs[0] || []) {
                const item = current.items?.find(item => item.id === id);
                if (typeof item?.locationVersion === 'number') callArgs[2][id] = item.locationVersion;
              }
            }
          }
          state.arguments = callArgs;
          patch(logical,{...state,status:'pending'});
          const result = await original(...callArgs);
          retries.delete(logical); patch(logical,{...state,status:'confirmed', completedAt:Date.now(),committedCount:result?.movedCount});
          return result;
        } catch (error) {
          if (error.code === 'VERSION_CONFLICT' || [400,401,403,404,409,422].includes(error.status)) retries.delete(logical);
          if (!error.cancelled) await store.getState().loadLibraryTree().catch(() => {});
          patch(logical,{...state,status:error.cancelled ? 'cancelled' : error.code === 'VERSION_CONFLICT' ? 'conflicted' : 'failed',error:error.cancelled ? null : error.message});
          throw error;
        } finally { inflight.delete(logical); }
      });
      inflight.set(logical,promise); tails.set(entity,promise);
      void promise.finally(() => { if (tails.get(entity) === promise) tails.delete(entity); }).catch(() => {});
      return promise;
    } });
  }
}
