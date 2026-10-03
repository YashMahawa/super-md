import {useEffect,useState} from "react";
import {checkWriting,type WritingIssue,type WritingOptions} from "../proofreading";
export default function WritingSuggestions({text,onChange,...options}:WritingOptions&{text:string;onChange:(text:string)=>void}) {
  const [issues,setIssues]=useState<WritingIssue[]>([]);
  useEffect(()=>{
    let active=true;setIssues([]);
    const timer=setTimeout(()=>{void checkWriting(text,options).then(value=>{if(active)setIssues(value);});},600);
    return()=>{active=false;clearTimeout(timer);};
  },[text,options.spellCheck,options.grammarCheck]);
  if(!issues.length)return null;
  return <aside className="writing-suggestions" aria-label="Writing suggestions" onMouseDown={event=>event.preventDefault()}>
    <header>Writing suggestions <small>English · {issues.length}</small></header>
    {issues.slice(0,6).map(issue=><div key={`${issue.from}-${issue.kind}`}><span>{issue.message}</span>{issue.replacements.map(replacement=><button key={replacement} type="button" onClick={()=>onChange(text.slice(0,issue.from)+replacement+text.slice(issue.to))}>{replacement}</button>)}</div>)}
  </aside>;
}
