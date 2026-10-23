import {useEffect,useState} from "react";
import {checkWriting,type WritingIssue,type WritingOptions} from "../proofreading";

export function findAlignedRange(text:string,issue:WritingIssue):{from:number;to:number}|null {
  const target=issue.originalText??text.slice(issue.from,issue.to);
  if(!target)return null;
  if(issue.from>=0&&issue.to<=text.length&&text.slice(issue.from,issue.to)===target){
    return {from:issue.from,to:issue.to};
  }
  let bestFrom=-1,minDiff=Infinity,pos=text.indexOf(target);
  while(pos!==-1){
    const diff=Math.abs(pos-issue.from);
    if(diff<minDiff){minDiff=diff;bestFrom=pos;}
    pos=text.indexOf(target,pos+1);
  }
  if(bestFrom===-1)return null;
  return {from:bestFrom,to:bestFrom+target.length};
}

export default function WritingSuggestions({text,onChange,...options}:WritingOptions&{text:string;onChange:(text:string)=>void}) {
  const [issues,setIssues]=useState<WritingIssue[]>([]);

  useEffect(()=>{
    let active=true;
    const timer=setTimeout(()=>{
      void checkWriting(text,options).then(value=>{
        if(active)setIssues(value);
      });
    },600);
    return()=>{active=false;clearTimeout(timer);};
  },[text,options.spellCheck,options.grammarCheck]);

  const validIssues=issues.map(issue=>{
    const range=findAlignedRange(text,issue);
    if(!range)return null;
    return {issue,range};
  }).filter((item):item is {issue:WritingIssue;range:{from:number;to:number}}=>item!==null);

  if(!validIssues.length)return null;

  const handleApply=(targetIssue:WritingIssue,replacement:string)=>{
    const currentRange=findAlignedRange(text,targetIssue);
    if(!currentRange){
      setIssues(prev=>prev.filter(i=>i!==targetIssue));
      return;
    }
    const {from:actualFrom,to:actualTo}=currentRange;
    const newText=text.slice(0,actualFrom)+replacement+text.slice(actualTo);
    const delta=replacement.length-(actualTo-actualFrom);

    const updatedIssues:WritingIssue[]=[];
    for(const other of issues){
      if(other===targetIssue)continue;
      const otherRange=findAlignedRange(text,other);
      if(!otherRange)continue;

      const {from:oFrom,to:oTo}=otherRange;
      if(Math.max(oFrom,actualFrom)<Math.min(oTo,actualTo)){
        continue;
      }

      if(oTo<=actualFrom){
        updatedIssues.push({...other,from:oFrom,to:oTo});
      }else{
        updatedIssues.push({...other,from:oFrom+delta,to:oTo+delta});
      }
    }

    setIssues(updatedIssues);
    onChange(newText);
  };

  return <aside className="writing-suggestions" aria-label="Writing suggestions" onMouseDown={event=>event.preventDefault()}>
    <header>Writing suggestions <small>English · {validIssues.length}</small></header>
    {validIssues.slice(0,6).map(({issue,range})=><div key={`${range.from}-${issue.kind}-${issue.originalText}`}><span>{issue.message}</span>{issue.replacements.map(replacement=><button key={replacement} type="button" onClick={()=>handleApply(issue,replacement)}>{replacement}</button>)}</div>)}
  </aside>;
}
