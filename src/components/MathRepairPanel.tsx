import { useEffect, useMemo, useRef, useState } from "react";
import { applyMathRepairs, suggestMathRepairs } from "../mathRepair";
import { setReaderOverlay } from "../readerOverlays";
export default function MathRepairPanel({ content, apply, close }: { content: string; apply: (value:string)=>void; close: ()=>void }) {
  const repairs = useMemo(()=>suggestMathRepairs(content),[content]);
  const [excluded,setExcluded] = useState(new Set<number>());
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    setReaderOverlay("repair",true);
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,summary") || []);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { setReaderOverlay("repair",false);document.removeEventListener("keydown", key, true); previous?.focus({preventScroll:true}); };
  }, []);
  const count = repairs.length-excluded.size;
  return <div className="repair-scrim" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className="math-repair-panel" data-independent-zoom role="dialog" aria-modal="true" aria-labelledby="repair-title">
      <header><div><h2 id="repair-title">Review LaTeX repairs</h2><small>{count} of {repairs.length} selected</small></div><button className="repair-dismiss" onClick={close} aria-label="Close LaTeX repairs">Close</button></header>
      <p>{repairs.length ? "Review validated formula and delimiter changes before applying. Code, links and currency are protected." : "No safe repairs found. Ambiguous prose or unsupported TeX commands need manual review."}</p>
      {!!repairs.length && <div className="repair-selection"><button onClick={()=>setExcluded(new Set())}>Select all</button><button onClick={()=>setExcluded(new Set(repairs.map((_,i)=>i)))}>Select none</button></div>}
      <div className="math-repair-list">{repairs.map((repair,index)=><div className="repair-item" key={repair.from}><label><input aria-label={`Apply repair ${index+1}`} type="checkbox" checked={!excluded.has(index)} onChange={()=>setExcluded(current=>{ const next=new Set(current); next.has(index)?next.delete(index):next.add(index); return next; })}/><span><strong>{repair.reason}</strong><small>Line {content.slice(0,repair.from).split("\n").length}</small></span></label><pre>{repair.after}</pre><details><summary>Original source</summary><pre>{content.slice(repair.from,repair.to)}</pre></details></div>)}</div>
      <footer><span>No changes until you apply</span><button disabled={!count} onClick={()=>{apply(applyMathRepairs(content,repairs.filter((_,index)=>!excluded.has(index))));close();}}>Apply {count} {count === 1 ? "repair" : "repairs"}</button></footer>
    </section>
  </div>;
}
