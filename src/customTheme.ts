/** Theme styling never inserts raw stylesheets, URLs, markup or selectors. */
export interface CustomStyle { colors?:Record<string,string>;metrics?:Record<string,number>;background?:{pattern:string;color:string;opacity?:number;spacing?:number;angle?:number}|null }
const metrics:Record<string,[string,number,number,string]>={contentRadius:['radius',0,32,'px'],paragraphSpacing:['paragraph',.5,2.5,'em'],codePadding:['code-padding',8,32,'px'],headingWeight:['heading-weight',400,900,''],headingTracking:['heading-tracking',-.05,.1,'em'],textTracking:['tracking',-.03,.1,'em'],tableBorderWidth:['table-border',0,3,'px']};
const roles=['link','heading','code-bg','code-text','code-border','callout-tip','callout-warning','callout-danger','callout-info','callout-example'];
const validColor=(value:unknown):value is string=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
function luminance(color:string){const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function readable(color:string,background:string){return contrast(color,background)>=4.5?color:contrast('#111111',background)>=contrast('#f9f9f9',background)?'#111111':'#f9f9f9';}
export function applyCustomStyle(root:HTMLElement,style:CustomStyle|undefined,base:Record<string,string>){
  root.dataset.customTheme=String(!!style&&(Object.keys(style.colors??{}).length>0||Object.keys(style.metrics??{}).length>0||!!style.background));
  for(const role of roles){root.style.removeProperty(`--custom-${role}`);root.removeAttribute(`data-custom-${role}`);}
  for(const [name] of Object.values(metrics)){root.style.removeProperty(`--custom-${name}`);root.removeAttribute(`data-custom-${name}`);}
  root.style.removeProperty('--custom-pattern');root.style.removeProperty('--custom-pattern-size');
  const colors=style?.colors??{},background=validColor(base.surface)?base.surface:'#ffffff';
  for(const role of roles){let value=colors[role];if(!validColor(value))continue;
    if(role==='link'||role==='heading'||role.startsWith('callout-'))value=readable(value,background);
    if(role==='code-text')value=readable(value,validColor(colors['code-bg'])?colors['code-bg']:base['surface-low']??background);
    root.style.setProperty(`--custom-${role}`,value);
    root.setAttribute(`data-custom-${role}`,'');
  }
  if(validColor(colors['code-bg'])&&!validColor(colors['code-text'])){root.style.setProperty('--custom-code-text',readable(base.text??'#111111',colors['code-bg']));root.setAttribute('data-custom-code-text','');}
  const layout:Record<string,number>={};
  for(const [key,value] of Object.entries(style?.metrics??{})){const rule=Object.prototype.hasOwnProperty.call(metrics,key)?metrics[key]:undefined;if(!rule||!Number.isFinite(value)||value<rule[1]||value>rule[2])continue;root.style.setProperty(`--custom-${rule[0]}`,`${value}${rule[3]}`);root.setAttribute(`data-custom-${rule[0]}`,'');layout[key]=value;}
  const bg=style?.background;
  if(bg&&validColor(bg.color)){
    const opacity=Math.max(0,Math.min(.15,Number.isFinite(bg.opacity)?bg.opacity!:.06)),spacing=Math.max(12,Math.min(96,Number.isFinite(bg.spacing)?bg.spacing!:24)),angle=Math.max(0,Math.min(360,Number.isFinite(bg.angle)?bg.angle!:0));
    const color=`color-mix(in srgb, ${bg.color} ${opacity*100}%, transparent)`;
    const patterns:Record<string,string>={none:'none',dots:`radial-gradient(${color} 1px, transparent 1px)`,grid:`linear-gradient(${color} 1px,transparent 1px),linear-gradient(90deg,${color} 1px,transparent 1px)`,diagonal:`repeating-linear-gradient(${angle||45}deg,transparent 0px,transparent ${spacing-1}px,${color} ${spacing-1}px,${color} ${spacing}px)`,gradient:`linear-gradient(${angle}deg,transparent,${color})`};
    if(Object.prototype.hasOwnProperty.call(patterns,bg.pattern)){root.style.setProperty('--custom-pattern',patterns[bg.pattern]);root.style.setProperty('--custom-pattern-size',bg.pattern==='gradient'||bg.pattern==='diagonal'?'auto':`${spacing}px ${spacing}px`);}
  }
  return JSON.stringify(layout);
}
