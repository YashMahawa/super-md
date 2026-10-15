/** Theme styling never inserts raw stylesheets, URLs, markup or selectors. */
import {validArtwork,artworkPosition,type ThemeArtwork} from './themeArtwork';
import {applyComponentColors,componentMetrics} from './themeComponents';
export interface CustomStyle { colors?:Record<string,string>;metrics?:Record<string,number>;artwork?:Record<string,ThemeArtwork>;background?:{pattern:string;color:string;opacity?:number;spacing?:number;size?:number;angle?:number}|null }
const metrics:Record<string,[string,number,number,string]>={...componentMetrics,contentRadius:['radius',0,32,'px'],paragraphSpacing:['paragraph',.5,2.5,'em'],codePadding:['code-padding',8,32,'px'],headingWeight:['heading-weight',400,900,''],headingTracking:['heading-tracking',-.05,.1,'em'],textTracking:['tracking',-.03,.1,'em'],tableBorderWidth:['table-border-width',0,3,'px']};
const roles=['link','heading','code-bg','code-text','code-border','callout-tip','callout-warning','callout-danger','callout-info','callout-example'];
const validColor=(value:unknown):value is string=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
function luminance(color:string){const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function readable(color:string,background:string){return contrast(color,background)>=4.5?color:contrast('#111111',background)>=contrast('#f9f9f9',background)?'#111111':'#f9f9f9';}
export function applyCustomStyle(root:HTMLElement,style:CustomStyle|undefined,base:Record<string,string>){
  root.dataset.customTheme=String(!!style&&(Object.keys(style.colors??{}).length>0||Object.keys(style.metrics??{}).length>0||!!style.background||!!style.artwork?.reader));
  for(const role of roles){root.style.removeProperty(`--custom-${role}`);root.removeAttribute(`data-custom-${role}`);}
  for(const [name] of Object.values(metrics)){root.style.removeProperty(`--custom-${name}`);root.removeAttribute(`data-custom-${name}`);}
  root.style.removeProperty('--custom-pattern');root.style.removeProperty('--custom-pattern-size');
  for(const name of ['art','art-size','art-position','art-veil','background','background-size','background-position','background-repeat'])root.style.removeProperty('--custom-'+name);
  const art=style?.artwork?.reader;
  if(art&&validArtwork(art.image)){
    const opacity=Math.max(0,Math.min(.25,Number.isFinite(art.opacity)?art.opacity!:.06));
    root.style.setProperty('--custom-art',`url("${art.image}")`);
    root.style.setProperty('--custom-art-size',art.fit==='contain'?'contain':'cover');
    root.style.setProperty('--custom-art-position',artworkPosition(art.position));
    const veil=`color-mix(in srgb, ${validColor(base.surface)?base.surface:'#ffffff'} ${(1-opacity)*100}%, transparent)`;
    root.style.setProperty('--custom-art-veil',`linear-gradient(${veil},${veil})`);
  }
  const colors=style?.colors??{},background=validColor(base.surface)?base.surface:'#ffffff';
  for(const role of roles){let value=colors[role];if(!validColor(value))continue;
    if(role==='link'||role==='heading'||role.startsWith('callout-'))value=readable(value,background);
    if(role==='code-text')value=readable(value,validColor(colors['code-bg'])?colors['code-bg']:base['surface-low']??background);
    root.style.setProperty(`--custom-${role}`,value);
    root.setAttribute(`data-custom-${role}`,'');
  }
  if(validColor(colors['code-bg'])&&!validColor(colors['code-text'])){root.style.setProperty('--custom-code-text',readable(base.text??'#111111',colors['code-bg']));root.setAttribute('data-custom-code-text','');}
  applyComponentColors(root,colors,base);
  const layout:Record<string,number>={};
  for(const [key,value] of Object.entries(style?.metrics??{})){const rule=Object.prototype.hasOwnProperty.call(metrics,key)?metrics[key]:undefined;if(!rule||!Number.isFinite(value)||value<rule[1]||value>rule[2])continue;root.style.setProperty(`--custom-${rule[0]}`,`${value}${rule[3]}`);root.setAttribute(`data-custom-${rule[0]}`,'');layout[key]=value;}
  const bg=style?.background;
  if(bg&&validColor(bg.color)){
    const opacity=Math.max(0,Math.min(.25,Number.isFinite(bg.opacity)?bg.opacity!:.06)),spacing=Math.max(12,Math.min(192,Number.isFinite(bg.spacing)?bg.spacing!:24)),angle=Math.max(0,Math.min(360,Number.isFinite(bg.angle)?bg.angle!:0));
    const color=`color-mix(in srgb, ${bg.color} ${opacity*100}%, transparent)`;
    const patterns:Record<string,string>={none:'none',dots:`radial-gradient(${color} 1px, transparent 1px)`,grid:`linear-gradient(${color} 1px,transparent 1px),linear-gradient(90deg,${color} 1px,transparent 1px)`,diagonal:`repeating-linear-gradient(${angle||45}deg,transparent 0px,transparent ${spacing-1}px,${color} ${spacing-1}px,${color} ${spacing}px)`,gradient:`linear-gradient(${angle}deg,transparent,${color})`};
    // Application-owned geometry only, never SVG supplied by a theme. A small
    // repeat tile is decoded once; it has no DOM nodes or input handlers.
    if(bg.pattern==='paws'){
      const size=Math.min(spacing*.8,Math.max(8,Math.min(64,Number.isFinite(bg.size)?bg.size!:24)));
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}" viewBox="0 0 ${spacing} ${spacing}"><g fill="${bg.color}" opacity="${opacity}" transform="translate(${spacing/2} ${spacing/2}) rotate(${angle}) scale(${size/32}) translate(-16 -16)"><ellipse cx="6" cy="12" rx="3.6" ry="5" transform="rotate(-28 6 12)"/><ellipse cx="13" cy="6.5" rx="3.5" ry="4.8" transform="rotate(-9 13 6.5)"/><ellipse cx="21" cy="7" rx="3.5" ry="4.8" transform="rotate(12 21 7)"/><ellipse cx="27" cy="13" rx="3.5" ry="4.8" transform="rotate(30 27 13)"/><path d="M7.5 24c0-4 5-11 9-11s9 7 9 11c0 6-6 3-9 3s-9 3-9-3Z"/></g></svg>`;
      patterns.paws=`url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    }
    if(Object.prototype.hasOwnProperty.call(patterns,bg.pattern)){root.style.setProperty('--custom-pattern',patterns[bg.pattern]);root.style.setProperty('--custom-pattern-size',bg.pattern==='gradient'||bg.pattern==='diagonal'?'auto':`${spacing}px ${spacing}px`);}
  }
  if(root.style.getPropertyValue('--custom-art')){
    const layers=bg?.pattern==='grid'?2:1;
    root.style.setProperty('--custom-background',`${root.style.getPropertyValue('--custom-pattern')||'none'},${root.style.getPropertyValue('--custom-art-veil')},${root.style.getPropertyValue('--custom-art')}`);
    root.style.setProperty('--custom-background-size',`${Array(layers).fill(root.style.getPropertyValue('--custom-pattern-size')||'auto').join(',')},cover,${root.style.getPropertyValue('--custom-art-size')}`);
    root.style.setProperty('--custom-background-position',`${Array(layers).fill('0 0').join(',')},center,${root.style.getPropertyValue('--custom-art-position')}`);
    root.style.setProperty('--custom-background-repeat',`${Array(layers).fill('repeat').join(',')},no-repeat,no-repeat`);
  }
  return JSON.stringify(layout);
}
