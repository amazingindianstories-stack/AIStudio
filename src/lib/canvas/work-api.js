import { apiFetch } from '../api';

export async function workRequest(path, data) {
  const response = await apiFetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
export const tablePath = (boardId, tableId = '') => `/api/canvas-boards/${boardId}/work${tableId ? `/${tableId}` : ''}`;
