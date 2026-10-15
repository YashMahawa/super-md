export interface ThemeArtwork {image:string;opacity?:number;fit?:string;position?:string}
export function artworkPosition(position:string|undefined){return ({center:'center',left:'left center',right:'right center',top:'center top',bottom:'center bottom','top-left':'left top','top-right':'right top','bottom-left':'left bottom','bottom-right':'right bottom'} as Record<string,string>)[position??'center']??'center';}
/** Read dimensions without allocating a decoded bitmap. Native import validates
 * the same container types before this defence-in-depth browser boundary. */
function rasterSize(bytes:Uint8Array,type:string):[number,number]|undefined {
  const v=new DataView(bytes.buffer),n=bytes.length;
  const tag=(p:number,s:string)=>p+s.length<=n&&[...s].every((c,i)=>bytes[p+i]===c.charCodeAt(0));
  if(type==='png'&&n>=33&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)&&tag(12,'IHDR')){
    for(let p=8;p+12<=n;){const len=v.getUint32(p);if(tag(p+4,'acTL')||p+len+12>n)return;p+=len+12;}
    return [v.getUint32(16),v.getUint32(20)];
  }
  if(type==='jpeg'&&n>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255){
    for(let p=2;p+4<=n;){
      if(bytes[p++]!==255)return;while(bytes[p]===255)p++;
      const marker=bytes[p++];if(marker===217||marker===218)return;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(p+2>n)return;const len=v.getUint16(p);if(len<2||p+len>n)return;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&len>=8)return [v.getUint16(p+5),v.getUint16(p+3)];
      p+=len;
    }
  }
  if(type==='webp'&&n>=20&&tag(0,'RIFF')&&tag(8,'WEBP')){
    let size:[number,number]|undefined;
    const u24=(p:number)=>bytes[p]+(bytes[p+1]<<8)+(bytes[p+2]<<16);
    for(let p=12;p+8<=n;){
      const len=v.getUint32(p+4,true),d=p+8;if(d+len+(len%2)>n)return;
      if(tag(p,'ANIM')||tag(p,'ANMF'))return;
      if(tag(p,'VP8X')&&len>=10){if(bytes[d]&2)return;size=[u24(d+4)+1,u24(d+7)+1];}
      else if(!size&&tag(p,'VP8 ')&&len>=10&&tag(d+3,'\x9d\x01\x2a'))size=[v.getUint16(d+6,true)&16383,v.getUint16(d+8,true)&16383];
      else if(!size&&tag(p,'VP8L')&&len>=5&&bytes[d]===47){const bits=v.getUint32(d+1,true);size=[(bits&16383)+1,((bits>>>14)&16383)+1];}
      p=d+len+(len%2);
    }
    return size;
  }
}
const elements=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','title','desc']);
const attributes=new Set(['id','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','clip-path','preserveAspectRatio']);
const checked=new Map<string,boolean>();
/** Same static-geometry boundary as the native importer; never HTML, CSS,
 * scripts, external image URLs, SVG filters or animations. */
export function validArtwork(image:unknown):image is string {
  if(typeof image!=='string'||image.length>699_180)return false;
  const previous=checked.get(image);if(previous!==undefined)return previous;
  let valid=false;
  try {
    const match=image.match(/^data:image\/(svg\+xml|png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)return false;
    const binary=atob(match[2]);if(binary.length>512*1024)return false;
    if(match[1]!=='svg+xml'){
      const size=rasterSize(Uint8Array.from(binary,c=>c.charCodeAt(0)),match[1]);
      valid=!!size&&size.every(n=>n>0&&n<=4096)&&size[0]*size[1]<=4194304;
    } else {
      if(binary.length>128*1024)return false;
      const xml=new DOMParser().parseFromString(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))),'image/svg+xml');
      const root=xml.documentElement,nodes=[root,...Array.from(root.querySelectorAll('*'))];
      valid=!xml.doctype&&!xml.querySelector('parsererror')&&root.localName==='svg'&&nodes.length<=5000&&nodes.every(node=>elements.has(node.localName)&&Array.from(node.attributes).every(a=>a.name==='xmlns'||attributes.has(a.name)&&!a.value.includes('\\')&&!a.value.includes('://')&&!a.value.includes('data:')&&(!a.value.toLowerCase().includes('url(')||/^url\(#[\w-]+\)$/.test(a.value))));
    }
  }catch{/* Invalid images keep the plain theme background. */}
  if(checked.size>=4)checked.delete(checked.keys().next().value!);
  checked.set(image,valid);return valid;
}
