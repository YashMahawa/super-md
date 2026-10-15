export type MediaAppearance='original'|'invert-dark'|'auto'|'contrast';
export function mediaFilter(mode:MediaAppearance|undefined,dark:boolean,_separation=1.25):string {
  if(mode==='invert-dark')return dark?'invert(1) hue-rotate(180deg)':'none';
  if(mode==='auto')return 'url("#supermd-media-tone")';
  // Contrast means separation from the surrounding page, not pixel processing.
  return 'none';
}
const hex=(v:unknown,fallback:string)=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v:fallback;
const rgb=(v:string)=>[1,3,5].map(i=>parseInt(v.slice(i,i+2),16)/255);
function luminance(v:string){const c=rgb(v).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
export function mediaContrast(a:string,b:string){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
/** A bounded accent-derived ink, with a real WCAG contrast guard even for
 * imported themes. All photos and SVGs share this luminance-preserving duotone. */
export function mediaTone(colors:Record<string,string>,dark:boolean){
  const paper=hex(colors.surface,dark?'#17131b':'#f1dfd4'),accent=hex(colors.primary,dark?'#c6a8ed':'#654483');
  const target=mediaContrast('#000000',paper)>mediaContrast('#ffffff',paper)?'#000000':'#ffffff';
  let ink=accent;
  for(let n=1;mediaContrast(ink,paper)<4.5&&n<=20;n++){
    const a=rgb(accent),b=rgb(target),t=n/20;
    ink='#'+a.map((x,i)=>Math.round((x*(1-t)+b[i]*t)*255).toString(16).padStart(2,'0')).join('');
  }
  return {paper,ink,channels:rgb(ink).map((v,i)=>`${v} ${rgb(paper)[i]}`)};
}
