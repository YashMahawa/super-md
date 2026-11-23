import {useEffect,useRef,useState} from 'react';
import MarkdownPreview from './MarkdownPreview';
import {copyText} from '../copyText';
import {setReaderOverlay} from '../readerOverlays';
import './ThemeGuideDialog.css';

export default function ThemeGuideDialog({close}:{close:()=>void}) {
  const [source,setSource]=useState<string|null>(null),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  const dialog=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null),copyTimer=useRef(0),closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    let current=true;
    void import('../../docs/THEMING.md?raw').then(module=>{if(current)setSource(module.default);},()=>{if(current)setError('The bundled theme guide could not be loaded.');});
    setReaderOverlay('theme-guide',true);
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({preventScroll:true});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeRef.current();}
      if(event.key==='Tab'){
        const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]')||[]);
        if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus();}
        else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus();}
      }
      if(['PageDown','PageUp'].includes(event.key)&&dialog.current?.contains(document.activeElement)){
        event.preventDefault();body.current?.scrollBy({top:(event.key==='PageDown'?1:-1)*(body.current.clientHeight*.85)});
      }
    };
    document.addEventListener('keydown',key,true);
    return()=>{current=false;clearTimeout(copyTimer.current);document.removeEventListener('keydown',key,true);setReaderOverlay('theme-guide',false);if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const copy=async()=>{
    if(source===null)return;
    try {
      await copyText(source);
      setError('');setCopied(true);clearTimeout(copyTimer.current);copyTimer.current=window.setTimeout(()=>setCopied(false),1800);
    } catch {setError('Could not copy the guide. Select the text to copy it manually.');}
  };
  return <div className="theme-guide-scrim" onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <section ref={dialog} className="theme-guide-dialog" data-independent-zoom role="dialog" aria-modal="true" aria-labelledby="theme-guide-title">
      <header><div><h2 id="theme-guide-title">Theme styling guide</h2><p>Design a theme yourself, or copy this guide for your AI assistant.</p></div>
        <button type="button" onClick={()=>void copy()} disabled={source===null}>{copied?'Copied':'Copy guide'}</button>
        <button type="button" className="theme-guide-close" aria-label="Close theme guide" onClick={close}>×</button>
      </header>
      {!!error&&<p className="theme-guide-error" role="alert">{error}</p>}
      <div ref={body} className="theme-guide-body" tabIndex={0} aria-label="Theme guide content" onClickCapture={event=>{
        const link=(event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
        if(link){event.preventDefault();event.stopPropagation();try {const id=decodeURIComponent(link.hash.slice(1));body.current?.querySelector<HTMLElement>('#'+CSS.escape(id))?.scrollIntoView({block:'start'});}catch{/* Ignore invalid fragment URLs. */}}
      }}>
        {source===null?<p role="status">Loading theme guide…</p>:<MarkdownPreview markdown={source} documentPath={null} python="" dark={false} fullDocumentAccessibility/>}
      </div>
    </section>
  </div>;
}
