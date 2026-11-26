import { invoke } from "./nativeBridge";
const overlays=new Set<string>();
/** Native fullscreen chrome must not cover document dialogs. Nested overlays
 * keep ownership until the last one closes. No note bytes cross this signal. */
export function setReaderOverlay(kind:string,open:boolean) {
  const previous=overlays.size>0;
  if(open)overlays.add(kind);else overlays.delete(kind);
  const present=overlays.size>0;
  document.documentElement.dataset.readerOverlay=String(present);
  if(previous!==present || kind==="image" || kind==="step-viewer")void invoke("reader_overlay_changed",{open:present,image:overlays.has("image")||overlays.has("step-viewer")}).catch(()=>{});
}
export function hasReaderOverlay():boolean {
  return overlays.size>0||document.documentElement.dataset.readerOverlay==="true"||!!document.querySelector(".media-save-menu,.theme-guide-dialog,.media-dialog,.image-viewer,.math-repair-panel,.reading-search,.reader-export-backdrop");
}
export function dismissReaderOverlay():boolean {
  const element=document.querySelector(".media-save-menu")||document.querySelector(".theme-guide-dialog")||document.querySelector(".media-dialog,.image-viewer,.math-repair-panel,.reading-search,.cm-search,.live-active-block textarea");
  if(!element)return false;
  const target=element.matches("textarea")?element:document.activeElement||document;
  target.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
  if(element.matches("textarea"))(element as HTMLElement).blur();
  return true;
}
