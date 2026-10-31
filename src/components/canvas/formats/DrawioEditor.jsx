"use client";

import { useEffect, useRef, useState } from "react";
import { patchFormat } from "@/lib/canvas/formats/actions";

const ORIGIN = "https://embed.diagrams.net";

export function DrawioEditor({ node, readOnly }) {
  const frame = useRef(null);
  const current = useRef(node);
  current.current = node;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const onMessage = (e) => {
      if (readOnly || e.origin !== ORIGIN || e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let message;
      try { message = JSON.parse(e.data); } catch { return; }
      if (message.event === "init") frame.current.contentWindow.postMessage(JSON.stringify({ action: "load", xml: current.current.xml || "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel>", autosave: 1 }), ORIGIN);
      if (["save", "autosave"].includes(message.event) && typeof message.xml === "string") {
        if (message.xml.length > 300000) { setError("Diagram exceeds 300,000 characters. Reduce its size before saving."); return; }
        patchFormat(current.current.id, () => ({ xml: message.xml }));
        setError("");
        if (message.exit) setEditing(false);
      }
      if (message.event === "exit") setEditing(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [readOnly]);
  return <div className="space-y-3">
    <p className="text-sm text-slate-600">Draw.io opens diagrams.net in this panel. Diagram XML is saved on this board.</p>
    {!readOnly && <button className="rounded bg-indigo-600 px-4 py-2 text-white" onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Open Draw.io editor"}</button>}
    <a className="ml-3 text-indigo-700 underline" href={`data:application/xml;charset=utf-8,${encodeURIComponent(node.xml)}`} download={`${node.name}.drawio`}>Export Draw.io XML</a>
    {error && <p role="alert">{error}</p>}
    {editing ? <iframe ref={frame} title="Draw.io editor" className="h-[70vh] w-full border" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals" referrerPolicy="no-referrer" src={`${ORIGIN}/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1`} /> : <pre className="max-h-96 overflow-auto rounded bg-slate-100 p-4 text-xs">{node.xml || "Open the editor to create a diagram or import an existing file."}</pre>}
  </div>;
}
