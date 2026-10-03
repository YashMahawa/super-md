import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode,type HTMLAttributes} from "react";
import {registerWindowedText,preserveWindowedScroll} from "../windowedSearch";
const subscribe=()=>()=>{};
export function useWindowing():boolean {
  // Server rendering (PDF preparation/tests) always receives the complete tree,
  // even if invoked from a browser that has IntersectionObserver.
  return useSyncExternalStore(subscribe,()=>typeof IntersectionObserver!=="undefined",()=>false);
}
export interface WindowHeading {id:string;key:string}
export default function WindowedBlock({enabled,estimate=120,text="",headings=[],children,...props}:{enabled:boolean;estimate?:number;text?:string;headings?:WindowHeading[];children:ReactNode}&HTMLAttributes<HTMLElement>) {
  const supported=useWindowing(),active=enabled&&supported;
  const [shown,setShown]=useState(!active),height=useRef(estimate),element=useRef<HTMLElement>(null);
  useEffect(()=>{
    const node=element.current;if(!node||!active)return;
    const unregister=registerWindowedText(node,text);
    const reveal=()=>setShown(true);node.addEventListener('supermd-reveal-window',reveal);
    let near=false;
    const release=()=>{if(!near&&!node.contains(document.activeElement)&&!window.getSelection()?.containsNode(node,true)&&!node.querySelector('[data-output-pinned="true"]')){preserveWindowedScroll(node);setShown(false);}};
    node.addEventListener('supermd-output-stored',release);
    const observer=new IntersectionObserver(entries=>{
      const entry=entries[0];
      near=entry.isIntersecting;
      if(entry.isIntersecting){preserveWindowedScroll(node);setShown(true);}
      else release();
    },{root:node.closest('.android-reading'),rootMargin:'900px 0px'});
    observer.observe(node);
    return()=>{observer.disconnect();unregister();node.removeEventListener('supermd-reveal-window',reveal);node.removeEventListener('supermd-output-stored',release);};
  },[active,text]);
  useLayoutEffect(()=>{
    const node=element.current;if(!node||!active||!shown)return;
    const observer=new ResizeObserver(entries=>{const measured=entries[0].borderBoxSize?.[0]?.blockSize??entries[0].contentRect.height;if(measured>0)height.current=measured;});observer.observe(node);
    const headingsInBlock=node.querySelectorAll<HTMLElement>('[data-heading-key]');
    headings.forEach((heading,i)=>{if(headingsInBlock[i])headingsInBlock[i].id=heading.id;});
    node.closest('.android-reading')?.dispatchEvent(new Event('supermd-window-change'));
    return()=>observer.disconnect();
  },[active,shown,headings]);
  if(!active)return <section {...props}>{children}</section>;
  return <section {...props} ref={element} className={`windowed-md-block ${props.className||""}`} data-windowed-block data-windowed-mounted={shown} style={{...props.style,...(!shown?{height:height.current}:{} )}}>
    {shown?children:headings.map(heading=><span key={heading.id} id={heading.id} data-heading-key={heading.key} aria-hidden="true"/>)}
  </section>;
}
