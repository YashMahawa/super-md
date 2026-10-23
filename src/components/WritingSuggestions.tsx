import {useEffect,useRef,useState} from "react";
import {checkWriting,type WritingIssue,type WritingOptions} from "../proofreading";
export default function WritingSuggestions({text,onChange,...options}:WritingOptions&{text:string;onChange:(text:string)=>void}) {
  const optionKey=`${!!options.spellCheck}:${!!options.grammarCheck}`;
  const [checked,setChecked]=useState<{text:string;options:string;issues:WritingIssue[]}>();
  const latest=useRef(text);latest.current=text;
  const accepted=useRef<object|null>(null);
  useEffect(()=>{
    let active=true;
    // Keep ranges remapped by an accepted correction while the next analysis
    // refreshes. An unrelated edit hides them immediately instead.
    setChecked(previous=>previous?.text===text&&previous.options===optionKey?previous:undefined);
    const timer=setTimeout(()=>{void checkWriting(text,options).then(issues=>{if(active&&latest.current===text)setChecked({text,options:optionKey,issues});}).catch(()=>{if(active)setChecked(undefined);});},600);
    return()=>{active=false;clearTimeout(timer);};
  },[text,options.spellCheck,options.grammarCheck]);
  // Never re-anchor stale ranges by searching: repeated words make that
  // ambiguous. Hide results in the same render that changes their source.
  const issues=checked?.text===text&&checked.options===optionKey?checked.issues:[];
  if(!issues.length)return null;
  return <aside className="writing-suggestions" aria-label="Writing suggestions" onMouseDown={event=>event.preventDefault()}>
    <header>Writing suggestions <small>English · {issues.length}</small></header>
    {issues.slice(0,6).map(issue=><div key={`${issue.from}-${issue.kind}`}><span>{issue.message}</span>{issue.replacements.map(replacement=><button key={replacement} type="button" onClick={()=>{
      if(!checked||checked.text!==latest.current||accepted.current===checked||issue.from<0||issue.to<issue.from||issue.to>checked.text.length)return;
      accepted.current=checked;
      const next=checked.text.slice(0,issue.from)+replacement+checked.text.slice(issue.to);
      const delta=replacement.length-(issue.to-issue.from);
      const remaining=checked.issues.filter(other=>other!==issue&&(other.to<=issue.from||other.from>=issue.to))
        .map(other=>other.from>=issue.to?{...other,from:other.from+delta,to:other.to+delta}:other);
      setChecked({text:next,options:optionKey,issues:remaining});
      onChange(next);
    }}>{replacement}</button>)}</div>)}
  </aside>;
}
