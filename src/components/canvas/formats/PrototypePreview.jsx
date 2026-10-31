"use client";

import { useState } from "react";
import { FramePreview } from "./FramePreview";

export function PrototypePreview({ graph, initialId }) {
  const [screenId, setScreenId] = useState(initialId);
  const [trail, setTrail] = useState([]);
  const frame = graph.nodes.find((n) => n.id === screenId && n.type === "frame");
  if (!frame) return <p>Screen unavailable. Choose a screen from the Formats panel.</p>;
  return <div className="space-y-3"><div className="flex items-center gap-3"><button disabled={!trail.length} onClick={() => { setScreenId(trail.at(-1)); setTrail(trail.slice(0, -1)); }}>Back</button><h2>{frame.name}</h2><button onClick={() => { setScreenId(initialId); setTrail([]); }}>Restart flow</button></div><FramePreview frame={frame} graph={graph} onNavigate={(id) => { if (graph.nodes.some((n) => n.id === id && n.type === "frame")) { setTrail([...trail, screenId]); setScreenId(id); } }} /></div>;
}
