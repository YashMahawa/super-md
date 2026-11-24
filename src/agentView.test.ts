// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {agentDiagrams,diagramMetadata,visibleSourceRange,diagramMedia} from './agentView';
import {pythonResults,rememberPythonOutput,retainVisiblePython} from './renderedOutputs';
import * as nativeBridge from './nativeBridge';
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

it('indexes every slider frame by title and step without mounting or changing the current frame',async()=>{
 const deck={title:'K-means',steps:[{label:'Initialize',image:'assets/start.svg'},{label:'Update',diagram:{width:120,height:100,nodes:[{id:'a',label:'3',x:60,y:50}],edges:[]}},{label:'Reasoning only',markdown:'The points stay fixed.'}]};
 const source='😀\n\n```smd-steps\n'+JSON.stringify(deck)+'\n```';
 const diagrams=agentDiagrams(source);expect(diagrams).toHaveLength(2);
 expect(diagrams.map(d=>d.id)).toEqual(['diagram:step:3:0','diagram:step:3:1']);
 const metadata=diagrams.map(d=>diagramMetadata(source,d));
 expect(metadata[0]).toMatchObject({deckTitle:'K-means',stepLabel:'Initialize',stepIndex:0,stepCount:3,assetReference:'assets/start.svg'});
 expect(metadata[1].preview).toBe('K-means — Update');
 const frame=await diagramMedia(diagrams[1]);expect(await frame.svg!()).toContain('>3</text>');
 expect(source).toContain('Reasoning only');
});

it('indexes cached Matplotlib SVG and PNG figures per document without executing Python',async()=>{
 pythonResults.clear();
 const invokeSpy=vi.spyOn(nativeBridge,'invoke');
 const svgB64=btoa('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><circle cx="15" cy="15" r="10"/></svg>');
 const svgData=`data:image/svg+xml;base64,${svgB64}`;
 const pngData='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=';
 const code='import matplotlib.pyplot as plt\nplt.plot([1, 2], [3, 4])';
 const unrun='raise RuntimeError("must never run during inspection")';
 const source=`# Figures\n\n\`\`\`python\n${code}\n\`\`\`\n\n\`\`\`python\n${unrun}\n\`\`\``;

 expect(agentDiagrams(source,{documentPath:'/notes/a.md',python:'embedded'})).toEqual([]);

 const ctxA={document:'/notes/a.md',cell:'0',interpreter:'embedded'};
 const resultA={
  ok:true,
  stdout:'loss=0.1\n',
  stderr:'',
  images:[svgData,pngData],
  provenance:{verified:true,document:'/notes/a.md',cell:'0',interpreter:'embedded'},
 };
 rememberPythonOutput(code,resultA,ctxA);
 const releaseVisible=retainVisiblePython(code,resultA,ctxA);

 const diagramsA=agentDiagrams(source,{documentPath:'/notes/a.md',python:'embedded'});
 expect(diagramsA).toHaveLength(2);
 expect(diagramsA.map(d=>d.id)).toEqual(['diagram:python:11:0','diagram:python:11:1']);
 expect(diagramsA.map(d=>d.kind)).toEqual(['python-figure','python-figure']);
 expect(diagramsA[0].source).toBe(code);

 const metaA=diagramsA.map(d=>diagramMetadata(source,d));
 expect(metaA[0].assetReference).toBe('(embedded image)');
 expect(JSON.stringify(metaA)).not.toContain(svgB64);
 expect(JSON.stringify(metaA)).not.toContain('base64,');

 expect(agentDiagrams(source,{documentPath:'/notes/b.md',python:'embedded'})).toEqual([]);

 const mediaSvg=await diagramMedia(diagramsA[0]);
 expect(await mediaSvg.svg!()).toContain('<circle cx="15" cy="15" r="10"/>');
 const mediaPng=await diagramMedia(diagramsA[1]);
 expect(await mediaPng.uri!()).toBe(pngData);

 expect(invokeSpy).not.toHaveBeenCalledWith('run_python',expect.anything());
 releaseVisible();
 invokeSpy.mockRestore();
 pythonResults.clear();
});
