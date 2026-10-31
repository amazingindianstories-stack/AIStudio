"use client";

import { useEffect, useState } from 'react';
import { workRequest } from '@/lib/canvas/work-api';

const input = 'rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 disabled:bg-slate-100';
const title = record => String(record.cells.title || record.id);
/** Chooses parent or dependency records by searching the whole table on the server. */
export function WorkRecordPicker({ path, label, value, multiple = false, excludeId, onChange }) {
  const selected = multiple ? value : value ? [value] : [];
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [names, setNames] = useState(() => new Map());
  const [error, setError] = useState('');
  const missing = selected.filter(id => !names.has(id)).join(',');
  useEffect(() => {
    if (!missing) return undefined;
    let live = true;
    workRequest(`${path}?${new URLSearchParams({ ids: missing, all: '1' })}`)
      .then(result => { if (live) setNames(map => new Map([...map, ...missing.split(',').map(id => [id, id.slice(0, 8)]), ...result.records.map(r => [r.id, title(r)])])); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [path, missing]);
  useEffect(() => {
    const search = term.trim();
    if (!search) { setResults([]); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      workRequest(`${path}?${new URLSearchParams({ q: search })}`)
        .then(result => { if (live) { setResults(result.records.filter(r => r.id !== excludeId).slice(0, 20)); setError(''); } })
        .catch(e => { if (live) setError(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [path, term, excludeId]);
  function choose(record) {
    setNames(map => new Map(map).set(record.id, title(record)));
    onChange(multiple ? [...new Set([...selected, record.id])] : record.id);
    setTerm('');
  }
  return <fieldset className="space-y-1 text-xs"><legend>{label}</legend>
    {selected.length > 0 && <ul aria-label={`${label} records`} className="space-y-1">{selected.map(id => <li key={id} className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1"><span className="truncate">{names.get(id) || 'Loading record'}</span><button type="button" aria-label={`Remove ${names.get(id) || 'record'} from ${label}`} onClick={() => onChange(multiple ? selected.filter(v => v !== id) : null)}>Remove</button></li>)}</ul>}
    <input aria-label={`Search ${label} records`} placeholder="Search all records" className={`${input} w-full`} value={term} onChange={e => setTerm(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (results[0]) choose(results[0]); } }} />
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {results.length > 0 && <ul aria-label={`${label} search results`} className="max-h-40 overflow-auto rounded border border-slate-200 bg-white">{results.map(r => <li key={r.id}><button type="button" className="w-full truncate px-2 py-1 text-left hover:bg-blue-50" onClick={() => choose(r)}>{title(r)}</button></li>)}</ul>}
  </fieldset>;
}
