"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { patchFormat } from "@/lib/canvas/formats/actions";
import { DRAWIO_PREVIEW_PREFIX, MAX_DRAWIO_PREVIEW } from "@/lib/canvas/formats/model";

const ORIGIN = "https://embed.diagrams.net";

export function DrawioEditor({ node, readOnly }) {
  const frame = useRef(null);
  const current = useRef(node);
  current.current = node;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const exportFor = useRef(null);
  const closing = useRef(null);
  useEffect(() => {
    if (!editing) return;
    return () => {
      clearTimeout(closing.current);
      closing.current = null;
      exportFor.current = null;
    };
  }, [editing]);
  const close = useCallback(() => {
    if (exportFor.current == null) setEditing(false);
    else if (!closing.current) closing.current = setTimeout(() => setEditing(false), 5000);
  }, []);
  useEffect(() => {
    const onMessage = (e) => {
      if (readOnly || e.origin !== ORIGIN || e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let message;
      try { message = JSON.parse(e.data); } catch { return; }
      if (message.event === "init") frame.current.contentWindow.postMessage(JSON.stringify({ action: "load", xml: current.current.xml || "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel>", autosave: 1 }), ORIGIN);
      if (["save", "autosave"].includes(message.event) && typeof message.xml === "string") {
        if (message.xml.length > 300000) { setError("Diagram exceeds 300,000 characters. Reduce its size before saving."); return; }
        if (message.xml !== current.current.xml) patchFormat(current.current.id, () => ({ xml: message.xml, preview: undefined }));
        exportFor.current = message.xml;
        frame.current.contentWindow.postMessage(JSON.stringify({ action: "export", format: "svg" }), ORIGIN);
        setError("");
        if (message.exit) close();
      }
      if (message.event === "export" && exportFor.current != null && message.xml === exportFor.current) {
        exportFor.current = null;
        if (typeof message.data === "string" && message.data.startsWith(DRAWIO_PREVIEW_PREFIX) && message.data.length <= MAX_DRAWIO_PREVIEW && message.xml === current.current.xml) {
          patchFormat(current.current.id, () => ({ preview: message.data }), { coalesce: true });
        }
        if (closing.current) setEditing(false);
      }
      if (message.event === "exit") close();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [readOnly, close]);
  return <div className="space-y-3">
    <p className="text-sm text-slate-600">Opening the editor loads diagrams.net in this panel and sends it this diagram&apos;s XML. The XML and a preview image are saved on this board.</p>
    {!readOnly && <button className="rounded bg-indigo-600 px-4 py-2 text-white" onClick={() => (editing ? close() : setEditing(true))}>{editing ? "Close editor" : "Open Draw.io editor"}</button>}
    <a className="ml-3 text-indigo-700 underline" href={`data:application/xml;charset=utf-8,${encodeURIComponent(node.xml)}`} download={`${node.name}.drawio`}>Export Draw.io XML</a>
    {error && <p role="alert">{error}</p>}
    {editing ? <iframe ref={frame} title="Draw.io editor" className="h-[70vh] w-full border" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-modals" referrerPolicy="no-referrer" src={`${ORIGIN}/?embed=1&proto=json&spin=1&libraries=1&saveAndExit=1`} /> : node.preview ?
      // eslint-disable-next-line @next/next/no-img-element
      <img src={node.preview} alt={`${node.name} preview`} className="max-h-[70vh] w-full rounded border bg-white object-contain" /> : <pre className="max-h-96 overflow-auto rounded bg-slate-100 p-4 text-xs">{node.xml || "Open the editor to create a diagram or import an existing file."}</pre>}
  </div>;
}
