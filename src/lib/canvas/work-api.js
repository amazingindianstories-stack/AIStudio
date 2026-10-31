import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { viewFor } from './work-records';

export async function workRequest(path, data) {
  const response = await apiFetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
export const tablePath = (boardId, tableId = '') => `/api/canvas-boards/${boardId}/work${tableId ? `/${tableId}` : ''}`;
/** Query string for a widget: tables page through records, every other view receives the complete query result. */
export function workQuery(kind, query, groupBy) {
  return new URLSearchParams({ ...query, groupBy, ...(kind === 'table' ? {} : { all: '1', offset: '0' }) }).toString();
}
const NO_QUERY = {};
/** Polls one widget's records, grouped by its saved view on the server. */
export function useWorkRecords(boardId, node, query = NO_QUERY) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const groupBy = useRef('');
  const path = tablePath(boardId, node.datasetId);
  const enabled = Boolean(boardId && node.datasetId);
  const kind = node.kind;
  const load = useCallback(async () => {
    const id = ++generation.current;
    try {
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        const sent = groupBy.current;
        result = await workRequest(`${path}?${workQuery(kind, query, sent)}`);
        if (id !== generation.current) return;
        groupBy.current = viewFor(result.table, kind).groupBy || '';
        if (groupBy.current === sent) break;
      }
      setData(result); setError('');
    } catch (e) { if (id === generation.current) setError(e.message); }
  }, [path, query, kind]);
  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => clearInterval(timer);
  }, [load, enabled]);
  return { data, error, load };
}
