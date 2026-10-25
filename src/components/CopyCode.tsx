import { useEffect, useRef, useState } from "react";
import {copyText} from '../copyText';
export default function CopyCode({source}:{source:string}) {
  const [copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
  const timeout=useRef(0);useEffect(()=>()=>clearTimeout(timeout.current),[]);
  return <button type="button" className="code-copy" aria-label="Copy code" onClick={async event=>{event.stopPropagation();try{await copyText(source);setCopied(true);setFailed(false);clearTimeout(timeout.current);timeout.current=window.setTimeout(()=>setCopied(false),1600);}catch{setFailed(true);}}}>{copied?"Copied":failed?"Select code to copy":"Copy code"}</button>;
}
