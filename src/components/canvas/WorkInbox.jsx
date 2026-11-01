"use client";

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { workRequest } from '@/lib/canvas/work-api';

const LABELS = { table_assignment: 'Assignments', table_due: 'Due-date reminders', table_change: 'Record changes' };
export function WorkInbox({ triggerSlot }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ notifications: [], preferences: {} });
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setData(await workRequest('/api/board-notifications')); setError(''); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function change(operation) {
    try { setData(await workRequest('/api/board-notifications', operation)); setError(''); }
    catch (e) { setError(e.message); }
  }
  return <>
    {triggerSlot && createPortal(<button type="button" className={cn('flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand', open && 'bg-ink-600 text-white')} onClick={() => setOpen(v => !v)} aria-expanded={open}>Inbox ({data.notifications.filter(n => !n.readAt).length})</button>, triggerSlot)}
    {open && <section role="dialog" aria-label="Board notifications" className="absolute bottom-20 right-4 top-28 z-50 w-[min(400px,calc(100%-32px))] overflow-auto rounded-xl border bg-white p-4 text-slate-800 shadow-xl" onKeyDown={e => e.stopPropagation()}>
      <div className="flex justify-between"><h2 className="font-semibold">Notifications</h2><button onClick={() => setOpen(false)}>Close inbox</button></div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <fieldset className="my-4 space-y-2 border-b pb-4"><legend className="mb-2 text-sm font-medium">Notify me about</legend>{Object.entries(LABELS).map(([kind, label]) => <label key={kind} className="block text-sm"><input type="checkbox" checked={data.preferences[kind] ?? true} onChange={e => void change({ op: 'preferences', preferences: { [kind]: e.target.checked } })} /> {label}</label>)}</fieldset>
      {!data.notifications.length && <p className="text-sm text-slate-500">No notifications yet.</p>}
      {data.notifications.map(n => <article key={n.id} className={`mb-2 rounded-lg border p-3 ${n.readAt ? 'bg-white' : 'bg-blue-50'}`}><strong className="text-sm">{LABELS[n.kind] || n.kind}</strong><p className="text-sm">{n.payload.title}</p><p className="text-xs text-slate-500">{n.payload.tableName} · {new Date(n.createdAt).toLocaleString()}</p>{!n.readAt && <button className="mt-2 text-xs text-blue-700" onClick={() => void change({ op: 'read', id: n.id })}>Mark read</button>}</article>)}
    </section>}
  </>;
}
