import {useMemo} from "react";

/** Portable, responsive SVG for authored diagrams. Only geometry and text;
 * no arbitrary markup, scripts, URLs or event handlers. */
export type DiagramNode={id:string;label:string;x:number;y:number;state?:"normal"|"active"|"visited"|"muted";shape?:"circle"|"box"};
export type DiagramEdge={from:string;to:string;dashed?:boolean};
export type DiagramSpec={title?:string;width:number;height:number;nodes:DiagramNode[];edges:DiagramEdge[]};
const ID=/^[A-Za-z0-9_-]{1,32}$/;
export function parseDiagram(value:unknown):DiagramSpec|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const obj=value as Record<string,unknown>;
  if(obj.title!==undefined&&(typeof obj.title!=="string"||obj.title.length>160))return null;
  if(typeof obj.width!=="number"||obj.width<120||obj.width>1200||!Number.isFinite(obj.width))return null;
  if(typeof obj.height!=="number"||obj.height<80||obj.height>1000||!Number.isFinite(obj.height))return null;
  if(!Array.isArray(obj.nodes)||obj.nodes.length<1||obj.nodes.length>60)return null;
  if(!Array.isArray(obj.edges)||obj.edges.length>140)return null;
  const nodes:DiagramNode[]=[];
  const seen=new Set<string>();
  for(const raw of obj.nodes){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const n=raw as Record<string,unknown>;
    if(typeof n.id!=="string"||!ID.test(n.id)||seen.has(n.id))return null;
    if(typeof n.label!=="string"||n.label.length>40)return null;
    if(typeof n.x!=="number"||typeof n.y!=="number"||!Number.isFinite(n.x)||!Number.isFinite(n.y)||n.x<30||n.y<30||n.x>obj.width-30||n.y>obj.height-30)return null;
    if(n.state!==undefined&&!["normal","active","visited","muted"].includes(String(n.state)))return null;
    if(n.shape!==undefined&&!["circle","box"].includes(String(n.shape)))return null;
    seen.add(n.id);nodes.push({id:n.id,label:n.label,x:n.x,y:n.y,state:(n.state as DiagramNode["state"])??"normal",shape:(n.shape as DiagramNode["shape"])??"circle"});
  }
  const edges:DiagramEdge[]=[];
  for(const raw of obj.edges){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
    const e=raw as Record<string,unknown>;
    if(typeof e.from!=="string"||typeof e.to!=="string"||!seen.has(e.from)||!seen.has(e.to)||e.from===e.to)return null;
    if(e.dashed!==undefined&&typeof e.dashed!=="boolean")return null;
    edges.push({from:e.from,to:e.to,dashed:e.dashed===true});
  }
  return {title:obj.title as string|undefined,width:obj.width,height:obj.height,nodes,edges};
}
export function parseDiagramSource(source:string):DiagramSpec|null {
  if(source.length>16000)return null;
  try{return parseDiagram(JSON.parse(source));}catch{return null;}
}

/** Update SVG primitives in place: React preserves matching node and edge keys. */
export default function InlineDiagram({diagram}:{diagram:DiagramSpec|null}){
  const lookups=useMemo(()=>new Map(diagram?.nodes.map(n=>[n.id,n])??[]),[diagram]);
  if(!diagram)return <span className="inline-diagram-error" role="alert">Invalid diagram. Check node positions, IDs and edges.</span>;
  return <figure className="inline-diagram" role="group" aria-label={diagram.title||"Interactive SVG diagram"}>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={"0 0 "+diagram.width+" "+diagram.height} role="img" aria-label={diagram.title||"Diagram"} preserveAspectRatio="xMidYMid meet">
      {diagram.edges.map((e,i)=>{
        const a=lookups.get(e.from)!,b=lookups.get(e.to)!;
        const dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy)||1;
        const shapeRadius=(n:DiagramNode)=>n.shape==="box"?35:29;
        const ra=shapeRadius(a),rb=shapeRadius(b);
        return <line key={e.from+":"+e.to+":"+i} x1={a.x+dx*ra/dist} y1={a.y+dy*ra/dist} x2={b.x-dx*rb/dist} y2={b.y-dy*rb/dist} className={"inline-diagram-edge"+(e.dashed?" is-dashed":"")}/>;
      })}
      {diagram.nodes.map(n=><g key={n.id} className={"inline-diagram-node is-"+(n.state??"normal")} transform={"translate("+n.x+" "+n.y+")"}>
        {n.shape==="box"?<rect x={-38} y={-28} width={76} height={56} rx={12}/>:<circle r={29}/>}
        <text textAnchor="middle" dominantBaseline="central">{n.label}</text>
      </g>)}
    </svg>
  </figure>;
}
