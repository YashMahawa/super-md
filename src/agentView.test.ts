// @vitest-environment jsdom
import {describe,it,expect} from 'vitest';
import {agentDiagrams,diagramMetadata,visibleSourceRange} from './agentView';
describe('structured reader context',()=>{
  it('exposes exact diagram source with compact revision-relative references',()=>{
    const source='# 😀 Notes\n\n```mermaid\ngraph TD; A-->B\n```\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```';
    const diagrams=agentDiagrams(source);expect(diagrams.map(item=>item.kind)).toEqual(['mermaid','svg']);expect(diagrams[0].source).toBe('graph TD; A-->B');
    const info=diagramMetadata(source,diagrams[0]);expect(info.sourceStart).toBe(Array.from(source.slice(0,diagrams[0].start)).length);expect(info.id).toBe(`diagram:${info.sourceStart}`);expect(info.preview).toContain('graph TD');
  });
  it('only includes source blocks that intersect the current reading viewport',()=>{
    const host=document.createElement('div');host.getBoundingClientRect=()=>({top:100,bottom:300,left:0,right:600,height:200,width:600,x:0,y:100,toJSON(){}});
    for(const [start,end,top,bottom] of [[0,10,0,60],[10,30,120,160],[30,50,270,340],[50,80,350,390]]){const child=document.createElement('p');child.dataset.sourceStart=String(start);child.dataset.sourceEnd=String(end);child.getBoundingClientRect=()=>({top,bottom,left:0,right:600,height:bottom-top,width:600,x:0,y:top,toJSON(){}});host.append(child);}
    expect(visibleSourceRange(host,'x'.repeat(80))).toEqual({start:10,end:50});
  });
  it('uses code-point diagram IDs after astral characters',()=>{const source='😀\n```svg\n<svg/>\n```';const item=agentDiagrams(source)[0];expect(item.id).toBe('diagram:2');expect(diagramMetadata(source,item).sourceStart).toBe(2);});
  it('gives Markdown and reference images compact IDs without exposing base64 in metadata',()=>{
    const source='![Photo](assets/photo.png)\n\n![SVG][art]\n\n[art]: data:image/svg+xml;base64,PHN2Zy8+';
    const media=agentDiagrams(source);expect(media.map(item=>item.kind)).toEqual(['image','image']);
    const metadata=media.map(item=>diagramMetadata(source,item));expect(metadata[0].assetReference).toBe('assets/photo.png');expect(metadata[1].assetReference).toBe('(embedded image)');expect(JSON.stringify(metadata)).not.toContain('PHN2Zy8+');
  });
});
