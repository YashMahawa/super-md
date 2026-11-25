import {useEffect,useMemo,useRef,useState} from "react";
import {checkWriting,type WritingIssue,type WritingOptions} from "../proofreading";
import {PROOFREADING_MAX_CHARS,computeWindowBounds,selectProofreadingWindow} from "../proofreadingCore";
import {addPersonalWord,hasPersonalWord,loadPersonalWords,normalizeDictionaryWord,subscribePersonalDictionary} from "../personalDictionary";

interface CheckedState {
  text:string;
  options:string;
  windowFrom:number;
  windowTo:number;
  issues:WritingIssue[];
}

interface DismissedEntry {
  from:number;
  to:number;
  kind:WritingIssue["kind"];
  message:string;
}

export default function WritingSuggestions({text,caret=0,onChange,onAction,...options}:WritingOptions&{text:string;caret?:number;onChange:(text:string)=>void;onAction?:(edit?:{from:number;to:number;insertLength:number})=>void}) {
  const enabled=Boolean(options.spellCheck||options.grammarCheck);
  const optionKey=`${!!options.spellCheck}:${!!options.grammarCheck}`;
  const [checked,setChecked]=useState<CheckedState>();
  const [dictionaryRevision,setDictionaryRevision]=useState(0);
  const [,setDismissRevision]=useState(0);
  const latest=useRef(text);latest.current=text;
  const latestCaret=useRef(caret);latestCaret.current=caret;
  const accepted=useRef<object|null>(null);
  const dismissed=useRef<{text:string;entries:DismissedEntry[]}>({text,entries:[]});
  if(dismissed.current.text!==text)dismissed.current={text,entries:[]};

  useEffect(()=>subscribePersonalDictionary(()=>setDictionaryRevision(n=>n+1)),[]);
  const savedWords=useMemo(()=>new Set(loadPersonalWords()),[dictionaryRevision]);
  const quickBounds=useMemo(()=>computeWindowBounds(text,caret),[text,caret]);
  const fullQueueAtCap=Boolean(checked&&checked.text===text&&checked.issues.length>=40);

  useEffect(()=>{
    if(!enabled){setChecked(undefined);return;}
    let active=true;
    // Keep ranges remapped by an accepted correction while the next analysis
    // refreshes. An unrelated edit hides them immediately instead.
    setChecked(previous=>previous?.text===text&&previous.options===optionKey?previous:undefined);
    const timer=setTimeout(()=>{
      const win=selectProofreadingWindow(text,latestCaret.current);
      const runOptions:WritingOptions={spellCheck:options.spellCheck,grammarCheck:options.grammarCheck};
      const request=win.blocked.length?checkWriting(win.text,runOptions,win.blocked):checkWriting(win.text,runOptions);
      void request.then(rawIssues=>{
        if(!active||latest.current!==text)return;
        const mapped=win.from?rawIssues.map(issue=>({...issue,from:issue.from+win.from,to:issue.to+win.from})):rawIssues;
        setChecked({text,options:optionKey,windowFrom:win.from,windowTo:win.to,issues:mapped});
      }).catch(()=>{if(active)setChecked(undefined);});
    },600);
    return()=>{active=false;clearTimeout(timer);};
  },[enabled,text,quickBounds.from,quickBounds.to,options.spellCheck,options.grammarCheck,fullQueueAtCap?dictionaryRevision:0]);

  // Never re-anchor stale ranges by searching: repeated words make that
  // ambiguous. Hide results in the same render that changes their source.
  const rawIssues=checked?.text===text&&checked.options===optionKey?checked.issues:[];
  const activeDismissed=dismissed.current.text===text?dismissed.current.entries:[];
  const issues=rawIssues.filter(issue=>{
    if(issue.from<0||issue.to<issue.from||issue.to>text.length)return false;
    if(activeDismissed.some(d=>d.from===issue.from&&d.to===issue.to&&d.kind===issue.kind&&d.message===issue.message))return false;
    if(issue.kind==="spelling"&&hasPersonalWord(issue.word??text.slice(issue.from,issue.to),savedWords))return false;
    return true;
  });
  const truncated=enabled&&text.length>PROOFREADING_MAX_CHARS;
  if(!issues.length&&!truncated)return null;

  const visible=issues.slice(0,6);
  const countText=issues.length>6?`${visible.length} of ${issues.length}`:`${issues.length}`;
  const rangeFrom=checked?.text===text?checked.windowFrom:quickBounds.from;
  const rangeTo=checked?.text===text?checked.windowTo:quickBounds.to;

  return <aside className="writing-suggestions" aria-label="Writing suggestions" onMouseDown={event=>event.preventDefault()}>
    <header>
      <span>Writing suggestions</span>
      <small className="writing-suggestions-meta">
        {truncated&&<span className="proofreading-range-badge">12,000-character range ({(rangeFrom+1).toLocaleString("en-US")}–{rangeTo.toLocaleString("en-US")} of {text.length.toLocaleString("en-US")})</span>}
        <span>English · {countText}</span>
      </small>
    </header>
    {visible.map(issue=>{
      const validReplacements=issue.replacements.filter(r=>typeof r==="string"&&r.trim().length>0);
      const rawWord=issue.kind==="spelling"?(issue.word??text.slice(issue.from,issue.to)):"";
      const canSaveWord=rawWord?Boolean(normalizeDictionaryWord(rawWord)):false;
      return <div key={`${issue.from}-${issue.to}-${issue.kind}-${issue.message}`}>
        <span>{issue.message}</span>
        {validReplacements.map(replacement=><button key={replacement} type="button" onClick={()=>{
          if(!checked||checked.text!==latest.current||accepted.current===checked||issue.from<0||issue.to<issue.from||issue.to>checked.text.length)return;
          accepted.current=checked;
          onAction?.({from:issue.from,to:issue.to,insertLength:replacement.length});
          const next=checked.text.slice(0,issue.from)+replacement+checked.text.slice(issue.to);
          const delta=replacement.length-(issue.to-issue.from);
          if(dismissed.current.text===checked.text){
            dismissed.current={
              text:next,
              entries:dismissed.current.entries
                .filter(d=>d.to<=issue.from||d.from>=issue.to)
                .map(d=>d.from>=issue.to?{...d,from:d.from+delta,to:d.to+delta}:d)
            };
          }
          const remaining=checked.issues.filter(other=>other!==issue&&(other.to<=issue.from||other.from>=issue.to))
            .map(other=>other.from>=issue.to?{...other,from:other.from+delta,to:other.to+delta}:other);
          setChecked({...checked,text:next,windowTo:Math.min(next.length,Math.max(0,checked.windowTo+delta)),issues:remaining});
          onChange(next);
        }}>{replacement}</button>)}
        {canSaveWord&&<button type="button" className="suggestion-secondary" title={`Add “${rawWord}” to personal dictionary`} onClick={()=>{
          onAction?.();
          addPersonalWord(rawWord);
        }}>Add to dictionary</button>}
        <button type="button" className="suggestion-secondary" onClick={()=>{
          onAction?.();
          if(dismissed.current.text!==text)dismissed.current={text,entries:[]};
          dismissed.current.entries.push({from:issue.from,to:issue.to,kind:issue.kind,message:issue.message});
          setChecked(previous=>previous?{...previous,issues:previous.issues.filter(other=>other!==issue)}:previous);
          setDismissRevision(n=>n+1);
        }}>Dismiss</button>
      </div>;
    })}
  </aside>;
}
