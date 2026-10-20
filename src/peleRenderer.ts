/** Conservative fast path. Authored Mermaid configuration and features whose
 * semantics differ in Pele stay with Mermaid.js, not a lossy conversion. */
export function canUsePele(source:string):boolean {
  if(source.length>50_000||/%%\s*\{|^\s*---|\$|\bclick\s|\b(?:image|img|icon)\s*[:(]|@\{/im.test(source))return false;
  if(source.replace(/<br\s*\/?\s*>/gi,'').includes('<'))return false;
  const body=source.replace(/^\s*%%[^\n]*(?:\n|$)/gm,'').trimStart();
  return /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|pie|mindmap)\b/.test(body);
}

/** Resolve only SVG attributes, never label text. Inert SVG images and native
 * PDF engines cannot inherit the app's CSS variables. Keep exported vectors
 * self-contained, without measuring or mounting them in the document DOM. */
export function resolvePeleSvg(source:string,dark:boolean,id:string):string {
  const xml=new DOMParser().parseFromString(source,'image/svg+xml'),root=xml.documentElement;
  if(root.localName!=='svg'||xml.querySelector('parsererror'))throw new Error('Invalid Pele SVG');
  const variables=new Map<string,string>(Object.entries(dark?{
    '--pele-bg':'#19171b','--pele-fg':'#e9e2e8','--pele-muted':'#b7afb6','--pele-line':'#d9ced8',
    '--pele-surface':'#252128','--pele-surface-alt':'#342e38','--pele-border':'#8d818f','--pele-accent':'#c6a8ed',
  }:{}));
  const style=(root as unknown as SVGElement).style;
  for(const key of Array.from(style))if(key.startsWith('--')&&!variables.has(key))variables.set(key,style.getPropertyValue(key));
  const resolve=(value:string,depth=0):string=>{
    if(depth>12||value.length>100_000)throw new Error('Unsupported SVG variables');
    let result='',offset=0;
    while(true){
      const start=value.indexOf('var(',offset);if(start<0)return result+value.slice(offset);
      result+=value.slice(offset,start);let level=1,end=start+4,comma=-1;
      for(;end<value.length&&level;end++){const ch=value[end];if(ch==='(')level++;else if(ch===')')level--;else if(ch===','&&level===1&&comma<0)comma=end;}
      if(level)throw new Error('Unclosed SVG variable');
      const name=value.slice(start+4,comma<0?end-1:comma).trim();
      const fallback=comma<0?undefined:value.slice(comma+1,end-1).trim();
      const replacement=variables.get(name)??fallback;
      if(replacement===undefined)throw new Error('Unresolved SVG variable');
      result+=resolve(replacement,depth+1);offset=end;
      if(result.length>1_000_000)throw new Error('Expanded SVG exceeds the output limit');
    }
  };
  for(const node of [root,...Array.from(root.querySelectorAll('*'))]){
    for(const attr of Array.from(node.attributes))if(attr.value.includes('var('))node.setAttribute(attr.name,resolve(attr.value));
    const nodeStyle=(node as SVGElement).style;
    if(nodeStyle)for(const key of Array.from(nodeStyle))if(key.startsWith('--'))nodeStyle.removeProperty(key);
  }
  if(root.querySelector('style'))throw new Error('Unexpected Pele stylesheet');
  root.setAttribute('id',id);root.setAttribute('data-diagram-engine','pele');
  return new XMLSerializer().serializeToString(root);
}
