import {createContext,useContext,useEffect,useLayoutEffect,useRef,useState,type ClipboardEvent,type KeyboardEvent as ReactKeyboardEvent,type ReactNode,type RefObject} from 'react';
import {PencilSimpleIcon} from '@phosphor-icons/react';
import WindowedBlock,{type WindowHeading} from './WindowedBlock';
import WritingSuggestions from './WritingSuggestions';

export const CARET_KEYS=new Set(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End']);
export const fullscreenInteractiveSelector='a,button,input,select,textarea,summary,details,img,.note-image,.interactive-chart,.inline-diagram,.svg-figure,.mermaid,.step-cards,.remote-image-card,.image-error,.code-container';

export interface ActiveDraftContextValue {
  session:number;
  editorRef:RefObject<HTMLTextAreaElement|null>;
  sourceStart:number;
  text:string;
  caret:number;
  spellCheck:boolean;
  grammarCheck:boolean;
  onChange:(value:string,target:HTMLTextAreaElement)=>void;
  onSuggestionChange:(value:string)=>void;
  onSuggestionAction:(edit?:{from:number;to:number;insertLength:number})=>void;
  onSyncCaret:(area:HTMLTextAreaElement)=>void;
  onPaste:(event:ClipboardEvent<HTMLTextAreaElement>)=>void;
  onKeyDown:(event:ReactKeyboardEvent<HTMLTextAreaElement>)=>void;
  onCaretMove:()=>void;
  onRememberSelection:(area:HTMLTextAreaElement)=>void;
  onBlurSession:(session:number,area:HTMLTextAreaElement,shouldClose:boolean,relatedTarget:Element|null)=>void;
}

export const ActiveDraftContext=createContext<ActiveDraftContextValue|null>(null);

export function ActiveBlockEditor(){
  const draft=useContext(ActiveDraftContext);
  if(!draft)return null;
  const {session,editorRef,sourceStart,text,caret,spellCheck,grammarCheck,onChange,onSuggestionChange,onSuggestionAction,onSyncCaret,onPaste,onKeyDown,onCaretMove,onRememberSelection,onBlurSession}=draft;
  return (
    <div className="live-active-block">
      <textarea
        ref={editorRef}
        data-source-start={sourceStart}
        spellCheck={false}
        value={text}
        style={{height:Math.max(120,text.split('\n').length*27+32)}}
        onPaste={onPaste}
        onFocus={event=>onRememberSelection(event.currentTarget)}
        onSelect={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onPointerUp={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onClick={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);}}
        onChange={event=>{onSyncCaret(event.target);onChange(event.target.value,event.currentTarget);}}
        onKeyUp={event=>{onSyncCaret(event.currentTarget);onRememberSelection(event.currentTarget);if(CARET_KEYS.has(event.key))onCaretMove();}}
        onKeyDown={onKeyDown}
        onBlur={event=>{
          if(!event.currentTarget.isConnected)return;
          const related=event.relatedTarget;
          const shouldClose=!(related instanceof Node&&event.currentTarget.parentElement?.contains(related));
          onBlurSession(session,event.currentTarget,shouldClose,related instanceof Element?related:null);
        }}
        aria-label="Edit Markdown block"
      />
      <WritingSuggestions text={text} caret={caret} spellCheck={spellCheck} grammarCheck={grammarCheck} onChange={onSuggestionChange} onAction={onSuggestionAction}/>
    </div>
  );
}

export interface LiveBlockShellProps {
  windowed:boolean;estimate:number;text:string;headings:WindowHeading[];
  start:number;end:number;blockIndex:number;active:boolean;protectedHint:boolean;
  onOpen:(element:HTMLElement,start:number,end:number,protectedHint:boolean)=>void;
  children:ReactNode;
}

export function LiveBlockShell({windowed,estimate,text,headings,start,end,blockIndex,active,protectedHint,onOpen,children}:LiveBlockShellProps){
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const [tapped,setTapped]=useState(false);
  const blockElRef=useRef<HTMLElement|null>(null);
  const pressingRef=useRef(false);
  const tapStartRef=useRef<{id:number;x:number;y:number;moved:boolean}|null>(null);
  useLayoutEffect(()=>{
    let f2=0;
    const f1=requestAnimationFrame(()=>{f2=requestAnimationFrame(()=>{if(blockElRef.current&&!pressingRef.current)blockElRef.current.dataset.liveMeasured='true';});});
    return()=>{cancelAnimationFrame(f1);cancelAnimationFrame(f2);};
  },[]);
  useEffect(()=>{
    if(active){setTapped(false);return;}
    if(!blockElRef.current?.contains(document.activeElement))setFocused(false);
  },[active]);
  useEffect(()=>{
    if(!tapped)return;
    const clearOutside=(event:PointerEvent)=>{
      const target=event.target instanceof Node?event.target:null;
      if(target&&!blockElRef.current?.contains(target))setTapped(false);
    };
    document.addEventListener('pointerdown',clearOutside,true);
    return()=>document.removeEventListener('pointerdown',clearOutside,true);
  },[tapped]);
  const revealed=!active&&(hovered||focused||tapped);
  return <WindowedBlock blockRef={blockElRef} enabled={windowed&&!active} estimate={estimate} text={text} headings={headings} className="live-block" data-source-start={start} data-source-end={end} tabIndex={0} role="group" aria-label={`Editable block ${blockIndex+1}`}
    onPointerEnter={event=>{blockElRef.current=event.currentTarget;if(event.pointerType==='mouse'&&event.buttons===0&&!document.querySelector('.is-panning'))setHovered(true);}}
    onPointerMove={event=>{
      blockElRef.current=event.currentTarget;
      if(tapStartRef.current?.id===event.pointerId&&Math.hypot(event.clientX-tapStartRef.current.x,event.clientY-tapStartRef.current.y)>8)tapStartRef.current.moved=true;
      if(event.pointerType==='mouse'&&event.buttons===0&&!hovered&&!document.querySelector('.is-panning'))setHovered(true);
    }}
    onPointerLeave={event=>{pressingRef.current=false;if(event.pointerType==='mouse')setHovered(false);}}
    onPointerDown={event=>{
      blockElRef.current=event.currentTarget;
      pressingRef.current=true;
      if(event.pointerType==='mouse')return;
      tapStartRef.current={id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
    }}
    onPointerUp={event=>{
      pressingRef.current=false;
      if(event.pointerType==='mouse')return;
      const tap=tapStartRef.current;tapStartRef.current=null;
      if(active||!tap||tap.id!==event.pointerId||tap.moved||Math.hypot(event.clientX-tap.x,event.clientY-tap.y)>8)return;
      if(document.querySelector('.is-panning')||window.getSelection()?.toString())return;
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest('.live-block-edit,.live-active-block,.image-viewer,.reading-search,.media-dialog,.math-repair-panel'))return;
      if(document.documentElement.dataset.fullscreen==='true'&&!target?.closest(fullscreenInteractiveSelector))return;
      setTapped(true);
    }}
    onPointerCancel={()=>{pressingRef.current=false;tapStartRef.current=null;}}
    onFocus={event=>{blockElRef.current=event.currentTarget;if(!pressingRef.current)setFocused(true);}}
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocused(false);}}
    onDoubleClick={event=>{
      if(active||(event.target as Element).closest('a,button,input,select,textarea'))return;
      window.getSelection()?.removeAllRanges();onOpen(event.currentTarget,start,end,protectedHint);
    }}
    onKeyDown={event=>{if(!active&&event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();onOpen(event.currentTarget,start,end,protectedHint);}}}>
    {revealed?<button type="button" className="live-block-edit" data-independent-zoom aria-label="Edit block" title="Edit block" onClick={event=>{
      event.preventDefault();event.stopPropagation();
      const owner=event.currentTarget.closest<HTMLElement>('.live-block');
      if(owner)onOpen(owner,start,end,protectedHint);
    }}><PencilSimpleIcon size={13} weight="bold" aria-hidden="true"/><span>Edit</span></button>:null}
    {active?<ActiveBlockEditor/>:children}
  </WindowedBlock>;
}
