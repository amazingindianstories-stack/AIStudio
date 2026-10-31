import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';

export async function workRequest(path, data) {
  const response = await apiFetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
export const tablePath = (boardId, tableId = '') => `/api/canvas-boards/${boardId}/work${tableId ? `/${tableId}` : ''}`;
/** How many records a compact canvas preview can show: kanban-width columns of table-height rows. */
export function previewLimit(node) {
  return Math.min(200, Math.max(10, Math.ceil(node.w / 224) * Math.ceil(node.h / 30)));
}
/** Query string for a widget. The server groups by the saved view; previews ask for a bounded page, the open panel for its page (tables) or the complete result. */
export function workQuery(kind, query, limit) {
  const params = { ...query, view: kind };
  if (limit) Object.assign(params, { offset: '0', limit: String(limit) });
  else if (kind !== 'table') Object.assign(params, { all: '1', offset: '0' });
  return new URLSearchParams(params).toString();
}
const feeds = new Map();
/** Shares one polled query per widget between its canvas preview and its open panel; the panel's query wins while it is open. */
export function watchWork({ path, nodeId, kind }, subscriber) {
  const key = `${path}#${nodeId}#${kind}`;
  let feed = feeds.get(key);
  if (!feed) {
    feed = { subscribers: new Set(), generation: 0, state: null, scheduled: false };
    feed.refresh = async () => {
      const subscribers = [...feed.subscribers];
      if (!subscribers.length) return;
      const panel = subscribers.find(s => s.query);
      const id = ++feed.generation;
      const complete = Boolean(panel);
      try {
        const data = await workRequest(`${path}?${workQuery(kind, panel?.query, complete ? 0 : Math.max(...subscribers.map(s => s.limit)))}`);
        if (id === feed.generation) feed.state = { data, error: '', complete };
      } catch (e) {
        if (id === feed.generation) feed.state = { ...feed.state, error: e.message };
      }
      if (id === feed.generation) for (const s of feed.subscribers) s.update(feed.state);
    };
    feed.schedule = () => {
      if (feed.scheduled) return;
      feed.scheduled = true;
      queueMicrotask(() => { feed.scheduled = false; if (feed.subscribers.size) void feed.refresh(); });
    };
    feed.timer = setInterval(() => { if (!globalThis.document?.hidden) void feed.refresh(); }, 15000);
    feeds.set(key, feed);
  }
  feed.subscribers.add(subscriber);
  if (feed.state && (feed.state.complete || !subscriber.query)) subscriber.update(feed.state);
  feed.schedule();
  return {
    refresh: () => feed.refresh(),
    close() {
      feed.subscribers.delete(subscriber);
      if (feed.subscribers.size) return;
      clearInterval(feed.timer);
      feeds.delete(key);
    },
  };
}
/** Polls one widget's records. The open panel passes its query and receives its complete result; previews pass a record limit. */
export function useWorkRecords(boardId, node, { query = null, limit = 0 } = {}) {
  const [state, setState] = useState(null);
  const subscriber = useRef({ query, limit, update: setState });
  const subscription = useRef(null);
  const path = boardId && node.datasetId ? tablePath(boardId, node.datasetId) : '';
  const { id: nodeId, kind } = node;
  useEffect(() => { subscriber.current.limit = limit; }, [limit]);
  useEffect(() => {
    if (!path) return undefined;
    subscriber.current.query = query;
    const current = watchWork({ path, nodeId, kind }, subscriber.current);
    subscription.current = current;
    return () => current.close();
  }, [path, nodeId, kind, query]);
  const load = useCallback(async () => subscription.current?.refresh(), []);
  return { data: state?.data || null, error: state?.error || '', load };
}
