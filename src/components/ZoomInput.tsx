"use client";
import { memo, useEffect, useState } from "react";
import { clampPreviewZoom } from "../zoom";

export default memo(function ZoomInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(Math.round(value))); }, [value, editing]);
  const commit = () => {
    const number = Number(draft.replace(/%$/, "").trim());
    if (draft.trim() && Number.isFinite(number) && number > 0) onChange(clampPreviewZoom(number));
    else setDraft(String(Math.round(value)));
    setEditing(false);
  };
  return <span className="zoom-entry"><input aria-label="Zoom percentage" title="Type a zoom percentage. Ctrl+0 resets to 100%." inputMode="decimal" value={draft} onFocus={(event) => { setEditing(true); event.currentTarget.select(); }} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === "Escape") { event.preventDefault(); setDraft(String(Math.round(value))); setEditing(false); }
  }} /><span aria-hidden="true">%</span></span>;
});
