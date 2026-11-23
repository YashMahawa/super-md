import {parseDiagram,type DiagramSpec,type DiagramNode,type DiagramEdge} from "./InlineDiagram";

/** Uses heap-array indices, never automatic flowchart centering.
 * Even a single left/right child occupies its correct half-slot. */
export function parseBinaryTree(value:unknown):DiagramSpec|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(v.title!==undefined&&(typeof v.title!=="string"||v.title.length>160))return null;
  if(!Array.isArray(v.values)||v.values.length<1||v.values.length>15)return null;
  if(v.highlight!==undefined&&(!Array.isArray(v.highlight)||v.highlight.length>15||!v.highlight.every(x=>Number.isInteger(x)&&x>=0&&x<(v.values as unknown[]).length)))return null;
  const values=v.values;
  const levels=Math.floor(Math.log2(values.length))+1;
  const width=Math.max(240,Math.pow(2,levels)*75);
  const height=levels*104;
  const active=new Set<number>((v.highlight as number[]|undefined)??[]);
  const nodes:DiagramNode[]=[];
  const edges:DiagramEdge[]=[];
  for(let i=0;i<values.length;i++){
    const val=values[i];
    if(val===null)continue;
    if(typeof val!=="string"&&typeof val!=="number")return null;
    const label=String(val);
    if(label.length>32)return null;
    const parent=Math.floor((i-1)/2);
    if(i>0&&values[parent]===null)return null;
    const level=Math.floor(Math.log2(i+1));
    const start=2**level-1;
    const slot=i-start;
    const x=(slot+.5)*width/(2**level);
    const y=52+level*104;
    nodes.push({id:"n"+i,label,x,y,state:active.has(i)?"active":"normal"});
    if(i>0)edges.push({from:"n"+parent,to:"n"+i});
  }
  if(nodes.length===0||values[0]===null)return null;
  return parseDiagram({title:v.title,width,height,nodes,edges});
}
export function parseBinaryTreeSource(source:string):DiagramSpec|null {
  if(source.length>12000)return null;
  try{return parseBinaryTree(JSON.parse(source));}catch{return null;}
}
