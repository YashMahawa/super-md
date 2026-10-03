import { invoke } from "./nativeBridge";
const overlays=new Set<string>();
/** Native fullscreen chrome must not cover document dialogs. Nested overlays
 * keep ownership until the last one closes. No note bytes cross this signal. */
export function setReaderOverlay(kind:string,open:boolean) {
  const previous=overlays.size>0;
  if(open)overlays.add(kind);else overlays.delete(kind);
  const present=overlays.size>0;
  document.documentElement.dataset.readerOverlay=String(present);
  if(previous!==present || kind==="image")void invoke("reader_overlay_changed",{open:present,image:overlays.has("image")}).catch(()=>{});
}
