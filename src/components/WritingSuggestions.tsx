import {useEffect,useRef,useState} from "react";
import {checkWriting,type WritingIssue,type WritingOptions} from "../proofreading";

function splitsSurrogatePair(text:string,offset:number):boolean {
  if(offset<=0||offset>=text.length)return false;
  const previous=text.charCodeAt(offset-1),current=text.charCodeAt(offset);
  return previous>=0xd800&&previous<=0xdbff&&current>=0xdc00&&current<=0xdfff;
}

export function findAlignedRange(text:string,issue:WritingIssue):{from:number;to:number}|null {
  if(!issue.originalText)return null;
  if(!Number.isInteger(issue.from)||!Number.isInteger(issue.to)||issue.from<0||issue.to>text.length)return null;
  if(issue.to-issue.from!==issue.originalText.length)return null;
  if(splitsSurrogatePair(text,issue.from)||splitsSurrogatePair(text,issue.to))return null;
  return text.slice(issue.from,issue.to)===issue.originalText?{from:issue.from,to:issue.to}:null;
}

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
    const timer=setTimeout(()=>{void checkWriting(text,options).then(issues=>{if(active&&latest.current===text)setChecked({text,options:optionKey,issues:issues.filter(issue=>findAlignedRange(text,issue)!==null)});}).catch(()=>{if(active)setChecked(undefined);});},600);
    return()=>{active=false;clearTimeout(timer);};
  },[text,options.spellCheck,options.grammarCheck]);
  // Never re-anchor stale ranges by searching: repeated words make that
  // ambiguous. Hide results in the same render that changes their source.
  const issues=checked?.text===text&&checked.options===optionKey?checked.issues.filter(issue=>findAlignedRange(text,issue)!==null):[];
  if(!issues.length)return null;
  return <aside className="writing-suggestions" aria-label="Writing suggestions" onMouseDown={event=>event.preventDefault()}>
    <header>Writing suggestions <small>English · {issues.length}</small></header>
    {issues.slice(0,6).map(issue=><div key={`${issue.from}-${issue.to}-${issue.kind}-${issue.originalText}`}><span>{issue.message}</span>{issue.replacements.map(replacement=><button key={replacement} type="button" onClick={()=>{
      if(!checked||checked.text!==latest.current||accepted.current===checked)return;
      const range=findAlignedRange(checked.text,issue);
      if(!range){setChecked({text:checked.text,options:optionKey,issues:checked.issues.filter(other=>other!==issue)});return;}
      accepted.current=checked;
      const next=checked.text.slice(0,range.from)+replacement+checked.text.slice(range.to);
      const delta=replacement.length-(range.to-range.from);
      const remaining=checked.issues.filter(other=>other!==issue&&(other.to<=range.from||other.from>=range.to))
        .map(other=>other.from>=range.to?{...other,from:other.from+delta,to:other.to+delta}:other)
        .filter(other=>findAlignedRange(next,other)!==null);
      setChecked({text:next,options:optionKey,issues:remaining});
      onChange(next);
    }}>{replacement}</button>)}</div>)}
  </aside>;
}
