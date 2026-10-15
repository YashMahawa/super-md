import {mediaContrast,mediaTone} from './mediaAppearance';
import {svgImage,svgContrastBackdrop} from './svgImage';

type RGB=[number,number,number];
type Matrix=[number,number,number,number,number,number];
type Box=[number,number,number,number];
const identity:Matrix=[1,0,0,1,0,0];
const hex=(rgb:RGB)=>'#'+rgb.map(n=>Math.round(Math.max(0,Math.min(255,n))).toString(16).padStart(2,'0')).join('');
function rgb(value:string):RGB|null {
  value=({black:'#000000',white:'#ffffff',gray:'#808080',grey:'#808080'} as Record<string,string>)[value.toLowerCase()]??value;
  const h=value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if(h)return (h.length===3?h.split('').map(c=>parseInt(c+c,16)):[0,2,4].map(i=>parseInt(h.slice(i,i+2),16))) as RGB;
  const m=value.match(/^rgb\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)\s*\)$/i);return m?m.slice(1).map(Number) as RGB:null;
}
const neutral=(c:RGB)=>Math.max(...c)-Math.min(...c)<=12||(Math.max(...c)<100&&Math.max(...c)-Math.min(...c)<=32);
/** Resolve ordinary embedded SVG paint rules in the inert XML tree. Never
 * mount authored stylesheets in the app DOM or measure the document. */
function flattenPaintRules(root:Element,nodes:Element[]){
  const rules:Array<{selector:string;weight:number;values:Array<[string,string,boolean]>}>=[];
  for(const style of Array.from(root.querySelectorAll('style'))){
    const source=(style.textContent??'').replace(/\/\*[\s\S]*?\*\//g,'');
    if(/@(?:media|supports|layer|keyframes)\b/i.test(source))return false;
    for(const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      const values=Array.from(match[2].matchAll(/(?:^|;)\s*(fill|stroke|stroke-width)\s*:\s*([^;]+)/g),m=>[m[1],m[2].replace(/\s*!important\s*$/i,'').trim(),/!important\s*$/i.test(m[2])] as [string,string,boolean]);
      if(!values.length||match[1].includes('@'))continue;
      for(const selector of match[1].split(',').map(s=>s.trim())){
        if(rules.length>=256)return false;
        const weight=(selector.match(/#[\w-]+/g)?.length??0)*10000+(selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g)?.length??0)*100+(selector.match(/(?:^|[ >+~])\s*[a-z][\w-]*/gi)?.length??0);
        rules.push({selector,weight,values});
      }
    }
  }
  if(!rules.length)return true;
  for(const node of [root,...nodes]){
    const style=(node as SVGElement).style;if(!style)continue;
    const selected=new Map<string,{value:string;weight:number;important:boolean}>();
    for(const rule of rules){let matches=false;try{matches=node.matches(rule.selector);}catch{/* Unsupported selectors keep authored styling. */}
      if(matches)for(const [key,value,important] of rule.values){const weight=rule.weight+(important?1e8:0),prior=selected.get(key);if(!prior||weight>=prior.weight)selected.set(key,{value,weight,important});}
    }
    for(const [key,rule] of selected){const inline=style.getPropertyValue(key),priority=style.getPropertyPriority(key);if(!inline||rule.important&&priority!=='important')style.setProperty(key,rule.value,rule.important?'important':'');}
  }
  return true;
}
function readable(color:string,backdrop:string,minimum:number){
  const c=rgb(color);if(!c||mediaContrast(hex(c),backdrop)>=minimum)return color;
  const target=mediaContrast('#000000',backdrop)>mediaContrast('#ffffff',backdrop)?0:255;
  // Move only lightness, retaining a coloured mark's channel ordering/hue.
  for(let step=1;step<=40;step++){
    const next=hex(c.map(v=>v+(target-v)*step/40) as RGB);
    if(mediaContrast(next,backdrop)>=minimum)return next;
  }
  return target?'#ffffff':'#000000';
}
function multiply(a:Matrix,b:Matrix):Matrix{return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function transform(value:string):Matrix {
  let result=identity;
  for(const match of value.matchAll(/(translate|scale|matrix|rotate)\s*\(([^)]+)\)/g)){
    const n=match[2].trim().split(/[\s,]+/).map(Number);if(n.some(v=>!Number.isFinite(v)))continue;
    let next:Matrix=identity;
    if(match[1]==='translate')next=[1,0,0,1,n[0]??0,n[1]??0];
    if(match[1]==='scale')next=[n[0]??1,0,0,n[1]??n[0]??1,0,0];
    if(match[1]==='matrix'&&n.length===6)next=n as Matrix;
    if(match[1]==='rotate'){
      const r=n[0]*Math.PI/180,c=Math.cos(r),s=Math.sin(r);next=[c,s,-s,c,0,0];
      if(n.length===3)next=multiply(multiply([1,0,0,1,n[1],n[2]],next),[1,0,0,1,-n[1],-n[2]]);
    }
    result=multiply(result,next);
  }
  return result;
}
const point=(m:Matrix,x:number,y:number):[number,number]=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
function bounds(node:Element,m:Matrix):Box|null {
  const number=(key:string)=>parseFloat(node.getAttribute(key)||'0');let points:number[]=[];
  if(node.localName==='rect'){const x=number('x'),y=number('y');points=[x,y,x+number('width'),y+number('height')];}
  if(['circle','ellipse'].includes(node.localName)){const x=number('cx'),y=number('cy'),rx=number(node.localName==='circle'?'r':'rx'),ry=number(node.localName==='circle'?'r':'ry');points=[x-rx,y-ry,x+rx,y+ry];}
  if(node.localName==='polygon')points=(node.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number);
  if(node.localName==='path'){
    const d=node.getAttribute('d')||'';
    // Closed, straight-line paths include Matplotlib's paper patches. Curved
    // paths and font outlines are not guessed to be background rectangles.
    if(/[zZ]\s*$/.test(d)&&/^[\sMLZ0-9.,eE+\-]+$/.test(d))points=(d.match(/[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g)||[]).map(Number);
  }
  if(points.length<4||points.length>20000||points.length%2||points.some(v=>!Number.isFinite(v)))return null;
  const world:Array<[number,number]>=[];
  for(let i=0;i<points.length;i+=2)world.push(point(m,points[i],points[i+1]));
  return [Math.min(...world.map(p=>p[0])),Math.min(...world.map(p=>p[1])),Math.max(...world.map(p=>p[0])),Math.max(...world.map(p=>p[1]))];
}
interface Paint {node:Element;index:number;fill:string;stroke:string;matrix:Matrix;box:Box|null;label:boolean;paper:boolean;newFill:string}
/** Inert, display-only adaptation. Coloured nodes remain coloured; labels are
 * contrasted against their local node, not blindly recoloured against paper.
 * No DOM measurement, raster copy, Markdown reparse, scripts or source writes. */
export function adaptSvg(source:string,colors:Record<string,string>,dark:boolean):string {
  const safe=svgImage(source);
  if(safe.length>1_000_000)return safe;
  const xml=new DOMParser().parseFromString(safe,'image/svg+xml'),root=xml.documentElement;
  const nodes=Array.from(root.querySelectorAll('*'));if(nodes.length>6000)return safe;
  if(!flattenPaintRules(root,nodes))return safe;
  const {paper,ink}=mediaTone(colors,dark);
  const lightInk=svgContrastBackdrop(safe)==='#222026';
  const view=(root.getAttribute('viewBox')||`0 0 ${parseFloat(root.getAttribute('width')||'0')} ${parseFloat(root.getAttribute('height')||'0')}`).split(/[\s,]+/).map(Number);
  const viewArea=view[2]*view[3];let index=0;const paints:Paint[]=[];
  const hasDrawing=nodes.filter(n=>['path','rect','circle','ellipse','polygon','line','text','use'].includes(n.localName)&&!n.closest('defs')).length>1;
  const visit=(node:Element,fill:string,stroke:string,matrix:Matrix,label:boolean)=>{
    if(['defs','clipPath','mask','pattern','metadata','style','title','desc'].includes(node.localName))return;
    const style=(node as SVGElement).style;
    const ownFill=style?.getPropertyValue('fill')||node.getAttribute('fill');
    const ownStroke=style?.getPropertyValue('stroke')||node.getAttribute('stroke');
    if(ownFill&&ownFill!=='inherit')fill=ownFill;
    if(ownStroke&&ownStroke!=='inherit')stroke=ownStroke;
    matrix=multiply(matrix,transform(node.getAttribute('transform')||''));
    label=label||['text','tspan'].includes(node.localName)||/^text[_-]/.test(node.id);
    if(['path','rect','circle','ellipse','polygon','polyline','line','text','tspan','use'].includes(node.localName)){
      const box=label?null:bounds(node,matrix),area=box?(box[2]-box[0])*(box[3]-box[1]):0;
      const c=rgb(fill);
      const isPaper=!lightInk&&!!box&&viewArea>0&&area>=viewArea*.65&&!!c&&neutral(c)&&(Math.min(...c)>180||hasDrawing);
      let newFill=fill;
      if(c&&!label){
        if(isPaper)newFill=paper;
        else if(neutral(c))newFill=Math.min(...c)>180&&!lightInk?paper:ink;
        else if(box&&Math.min(...c)>215&&Math.max(...c)-Math.min(...c)<64){
          const base=rgb(paper)!,average=(c[0]+c[1]+c[2])/3;
          newFill=hex(base.map((v,i)=>v+(c[i]-average)*1.3) as RGB);
        }else if(box&&mediaContrast(hex(c),paper)<1.6)newFill=readable(fill,paper,3);
      }
      paints.push({node,index:index++,fill,stroke,matrix,box,label,paper:isPaper,newFill});
    }
    for(const child of Array.from(node.children))visit(child,fill,stroke,matrix,label);
  };
  visit(root,'#000000','none',identity,false);
  const shapes=paints.filter(p=>p.box&&rgb(p.fill));
  const set=(node:Element,key:string,value:string)=>{
    node.setAttribute(key,value);
    // Adaptation is a display variant: inline paint also wins over embedded
    // class rules, including authored !important declarations.
    const style=(node as SVGElement).style;
    if(style){style.setProperty(key,value,'important');node.setAttribute('style',style.cssText);}
  };
  for(const paint of paints){
    const {node,matrix,label,box}=paint;
    let x=parseFloat(node.getAttribute('x')||'0'),y=parseFloat(node.getAttribute('y')||'0');
    if(box){x=(box[0]+box[2])/2;y=(box[1]+box[3])/2;}
    else [x,y]=point(matrix,x,y);
    let local:Paint|undefined;
    // Unbounded/curved paths have no reliable sample point. Do not treat the
    // default (0,0) as their backdrop: a different shape there can otherwise
    // make an unrelated line acquire the wrong colour.
    if(box||label)for(let i=shapes.length-1;i>=0;i--){const p=shapes[i];if(p.index<paint.index&&p.box&&x>=p.box[0]&&x<=p.box[2]&&y>=p.box[1]&&y<=p.box[3]){local=p;break;}}
    const background=rgb(local?.newFill||'')?hex(rgb(local!.newFill)!):paper;
    const c=rgb(paint.fill);
    if(c){
      const intended=label?(neutral(c)?ink:paint.fill):paint.newFill;
      set(node,'fill',label?readable(intended,background,7):intended);
      if(!label&&box&&!paint.paper&&paint.stroke==='none'&&mediaContrast(hex(rgb(intended)!),background)<1.6){set(node,'stroke',readable(intended,background,3));set(node,'stroke-width','1');}
    }
    const edge=rgb(paint.stroke);
    if(edge){
      const width=parseFloat((node as SVGElement).style?.getPropertyValue('stroke-width')||node.getAttribute('stroke-width')||'1');
      const halo=!lightInk&&neutral(edge)&&Math.min(...edge)>230&&width>=4;
      set(node,'stroke',halo?paper:readable(neutral(edge)?ink:paint.stroke,background,3));
    }
  }
  // Marker geometry lives in defs, outside painter-order node backdrops. Give
  // arrowheads the same legible edge treatment as the lines that use them.
  for(const marker of Array.from(root.querySelectorAll('marker'))){
    if(!marker.getAttribute('fill'))marker.setAttribute('fill',ink);
    for(const node of [marker,...Array.from(marker.querySelectorAll('*'))])for(const key of ['fill','stroke']){
      const value=(node as SVGElement).style?.getPropertyValue(key)||node.getAttribute(key),c=value&&rgb(value);
      if(c)set(node,key,readable(neutral(c)?ink:value!,paper,3));
    }
  }
  root.setAttribute('color',ink);
  return new XMLSerializer().serializeToString(root);
}

export function adaptSvgData(uri:string,colors:Record<string,string>,dark:boolean):string {
  if(!uri.startsWith('data:image/svg+xml')||uri.length>1_400_000)return uri;
  try {const comma=uri.indexOf(','),source=uri.slice(0,comma).includes(';base64')?decodeURIComponent(escape(atob(uri.slice(comma+1)))):decodeURIComponent(uri.slice(comma+1));return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(adaptSvg(source,colors,dark));}catch{return uri;}
}
