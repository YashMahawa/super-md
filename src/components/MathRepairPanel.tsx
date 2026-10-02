import { useMemo, useState } from "react";
import { applyMathRepairs, suggestMathRepairs } from "../mathRepair";
export default function MathRepairPanel({ content, apply, close }: { content: string; apply: (value:string)=>void; close: ()=>void }) {
  const repairs = useMemo(()=>suggestMathRepairs(content),[content]);
  const [excluded,setExcluded] = useState(new Set<number>());
  return <section className="math-repair-panel" data-independent-zoom role="dialog" aria-modal="true" aria-label="Review LaTeX repairs">
    <header><h2>Review LaTeX repairs</h2><button onClick={close}>Cancel</button></header>
    <p>{repairs.length ? "Review the suggested delimiters. Code, links and existing math are left untouched." : "No unambiguous delimiter repairs found. Missing inline formulas mixed with prose need manual review."}</p>
    <div className="math-repair-list">{repairs.map((repair,index)=><label key={repair.from}><input type="checkbox" checked={!excluded.has(index)} onChange={()=>setExcluded(current=>{ const next=new Set(current); next.has(index)?next.delete(index):next.add(index); return next; })}/><span><strong>{repair.reason}</strong><pre>{repair.after}</pre></span></label>)}</div>
    <footer><button disabled={!repairs.length || repairs.length === excluded.size} onClick={()=>{apply(applyMathRepairs(content,repairs.filter((_,index)=>!excluded.has(index))));close();}}>Apply {repairs.length-excluded.size} repairs</button></footer>
  </section>;
}
