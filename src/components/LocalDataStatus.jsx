"use client";
import { useEffect, useState } from 'react';

export function LocalDataStatus() {
  const [mode, setMode] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', {signal:controller.signal, cache:'no-store'})
      .then(response => setMode(response.headers.get('X-Veevee-Data-Mode'))).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!mode || (process.env.NODE_ENV === 'production' && mode !== 'read_only_viewer')) return null;
  const labels = {fixtures:'Local fixtures',sanitized_snapshot:'Sanitized snapshot',read_only_viewer:'Read-only data viewer'};
  return <div role="status" className="border-b border-line bg-ink-900 px-3 py-1 text-[11px] text-white/60">{labels[mode] || 'Local data unavailable'}</div>;
}
