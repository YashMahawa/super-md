/** Original media stays out of DOM attributes, and is released when unmounted. */
import {invoke} from './nativeBridge';
import {svgImage} from './svgImage';
import {adaptSvg} from './svgTheme';
export type ExportableMedia={label:string;svg?:()=>string|Promise<string>;uri?:()=>string;source?:{text:string;extension:'mmd'}};
const originals=new WeakMap<Element,ExportableMedia>();
export function registerMedia(element:Element|null,media:ExportableMedia):()=>void {
  if(element)originals.set(element,media);
  return()=>{if(element&&originals.get(element)===media)originals.delete(element);};
}
export function mediaAt(element:Element|null):ExportableMedia|undefined {
  for(let node=element;node;node=node.parentElement){const media=originals.get(node);if(media)return media;}
  return undefined;
}
export function neutralChartSvg(element:SVGSVGElement):string {
  const copy=element.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns','http://www.w3.org/2000/svg');
  copy.querySelectorAll('.chart-axis').forEach(node=>node.setAttribute('stroke','#667085'));
  copy.querySelectorAll('.chart-grid').forEach(node=>node.setAttribute('stroke','#d5dbe5'));
  copy.querySelectorAll('text').forEach(node=>{if(!node.classList.contains('chart-curve-label'))node.setAttribute('fill','#20252d');node.setAttribute('font-family','Arial, sans-serif');node.setAttribute('font-size','14');});
  copy.querySelectorAll('.graph-probe-marker,.graph-probe-guide,.graph-probe-label').forEach(node=>node.remove());
  copy.removeAttribute('style');return svgImage(new XMLSerializer().serializeToString(copy));
}
async function asDataUrl(blob:Blob):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('Cannot read media bytes'));reader.readAsDataURL(blob);});}
export async function mediaBytes(media:ExportableMedia,format:'png'|'jpeg'|'svg'|'original'|'source'='png',maxDimension=4096):Promise<{body:string;mimeType:string;filename:string;width?:number;height?:number}> {
  if(!Number.isInteger(maxDimension)||maxDimension<64||maxDimension>4096)throw Error('Image size must be between 64 and 4096 pixels');
  const filename=media.label.replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').trim().slice(0,100)||'Diagram';
  if(format==='source'){
    if(!media.source)throw Error('Source is unavailable');
    return {body:(await asDataUrl(new Blob([media.source.text],{type:'text/plain'}))).split(',')[1],mimeType:'text/plain',filename:`${filename}.${media.source.extension}`};
  }
  let uri:string;
  if(media.svg){
    const safe=svgImage(await media.svg()),svg=adaptSvg(safe,{surface:'#ffffff',primary:'#20252d',text:'#20252d'},false);
    const xml=new DOMParser().parseFromString(svg,'image/svg+xml'),root=xml.documentElement;
    const view=root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if(view?.length===4&&view.every(Number.isFinite)&&view[2]>0&&view[3]>0){if(!root.hasAttribute('width'))root.setAttribute('width',String(view[2]));if(!root.hasAttribute('height'))root.setAttribute('height',String(view[3]));}
    uri=await asDataUrl(new Blob([new XMLSerializer().serializeToString(root)],{type:'image/svg+xml'}));
  }
  else if(media.uri)uri=media.uri();else throw Error('Original media is unavailable');
  if(!uri.startsWith('data:')){
    // Only already-approved, app-owned asset URLs are registered here. Never
    // fetch a remote document URL behind the image consent control.
    const response=await fetch(uri);if(!response.ok)throw Error('Cannot load this image');
    const blob=await response.blob();if(blob.size>25_000_000)throw Error('Image exceeds 25 MB');uri=await asDataUrl(blob);
  }
  if(format==='svg'&&!uri.startsWith('data:image/svg+xml'))throw Error('This image has no SVG representation');
  let rasterDimensions:{width:number;height:number}|undefined;
  if(format==='png'||format==='jpeg'){
    const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(Error('Cannot decode media for export'));image.src=uri;});
    const naturalWidth=image.naturalWidth||1200,naturalHeight=image.naturalHeight||800;
    const factor=Math.min(media.svg?2:1,maxDimension/Math.max(naturalWidth,naturalHeight),Math.sqrt(16_000_000/(naturalWidth*naturalHeight)));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(naturalWidth*factor));canvas.height=Math.max(1,Math.round(naturalHeight*factor));
    const context=canvas.getContext('2d');if(!context)throw Error('Cannot create export canvas');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    rasterDimensions={width:canvas.width,height:canvas.height};
    uri=format==='jpeg'?canvas.toDataURL('image/jpeg',0.9):canvas.toDataURL('image/png');
  }
  const match=/^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(uri);
  if(!match)throw Error('Unsupported original image format');
  if(match[2].length>34_000_000)throw Error('Image exceeds 25 MB');
  const extension:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/svg+xml':'svg'};
  let dimensions=rasterDimensions;
  if(match[1]==='image/png'){
    const header=Uint8Array.from(atob(match[2].slice(0,44)),value=>value.charCodeAt(0));
    if(header.length>=24){const view=new DataView(header.buffer);dimensions={width:view.getUint32(16),height:view.getUint32(20)};}
  }
  return {body:match[2],mimeType:match[1],filename:`${filename}.${extension[match[1]]}`,...dimensions};
}
export async function saveMedia(media:ExportableMedia,format:'png'|'svg'|'original'|'source') {
  return invoke<{filename:string}>('save_media_native',await mediaBytes(media,format));
}

let users=0,uninstall:(()=>void)|undefined;
declare global {interface Window {supermdMediaMenuAt?:(x:number,y:number)=>boolean;}}
/** One delegated menu works for windowed documents without retaining images. */
export function installMediaMenu():()=>void {
  users++;if(users===1){
    let menu:HTMLDivElement|undefined,timer:number|undefined,origin:{x:number;y:number}|undefined;
    const close=()=>{menu?.remove();menu=undefined;};
    const open=(x:number,y:number)=>{
      const media=mediaAt(document.elementFromPoint(x,y));if(!media)return false;
      close();const panel=document.createElement('div');menu=panel;panel.className='media-save-menu';panel.setAttribute('role','menu');panel.setAttribute('aria-label','Save image or diagram');
      const title=document.createElement('div');title.className='media-save-title';title.textContent='Save image';panel.append(title);
      const options:Array<['png'|'svg'|'original'|'source',string]>=[['png','Save as PNG · light background']];
      if(media.svg)options.push(['svg','Save as SVG']);else options.push(['original','Save original image']);
      if(media.source)options.push(['source','Save Mermaid source']);
      for(const [format,label] of options){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.onclick=()=>{panel.querySelectorAll('button').forEach(item=>item.disabled=true);void saveMedia(media,format).then(result=>{title.textContent=`Saved ${result.filename}`;window.setTimeout(close,1800);},error=>{title.textContent=String(error instanceof Error?error.message:error);panel.querySelectorAll('button').forEach(item=>item.disabled=false);});};panel.append(button);}
      document.body.append(panel);const box=panel.getBoundingClientRect();panel.style.left=`${Math.max(8,Math.min(x,innerWidth-box.width-8))}px`;panel.style.top=`${Math.max(8,Math.min(y,innerHeight-box.height-8))}px`;panel.querySelector('button')?.focus();return true;
    };
    window.supermdMediaMenuAt=open;
    const context=(event:MouseEvent)=>{if(open(event.clientX,event.clientY)){event.preventDefault();event.stopPropagation();}};
    const outside=(event:Event)=>{if(menu&&!menu.contains(event.target as Node))close();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
    const cancel=()=>{if(timer!==undefined)clearTimeout(timer);timer=undefined;origin=undefined;};
    const down=(event:PointerEvent)=>{outside(event);if(event.pointerType!=='touch'||!mediaAt(event.target as Element))return;origin={x:event.clientX,y:event.clientY};timer=window.setTimeout(()=>{timer=undefined;if(origin)open(origin.x,origin.y);},550);};
    const move=(event:PointerEvent)=>{if(origin&&Math.hypot(event.clientX-origin.x,event.clientY-origin.y)>12)cancel();};
    const click=(event:MouseEvent)=>{if(menu&&!menu.contains(event.target as Node)){event.preventDefault();event.stopPropagation();}};
    document.addEventListener('contextmenu',context,true);document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',cancel,true);document.addEventListener('pointercancel',cancel,true);document.addEventListener('keydown',key,true);document.addEventListener('click',click,true);
    uninstall=()=>{close();cancel();delete window.supermdMediaMenuAt;document.removeEventListener('contextmenu',context,true);document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',cancel,true);document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('keydown',key,true);document.removeEventListener('click',click,true);};
  }
  return()=>{if(--users===0){uninstall?.();uninstall=undefined;}};
}
