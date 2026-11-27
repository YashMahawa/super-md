// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {agentDiagrams,diagramMetadata,visibleSourceRange,diagramMedia} from './agentView';
import {mediaBytes,registerMedia} from './mediaExport';
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

it('scopes diagram lookup to a UTF-16 viewport range while preserving document-wide image definitions and code-point IDs',()=>{
  const source=[
    '[early-art]: assets/early.svg',
    '',
    '```mermaid',
    'graph LR; Early-->Skip',
    '```',
    '',
    '😀\ud83d Section before viewport',
    '',
    '![Early ref][early-art]',
    '',
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    '```',
    '',
    '![Late ref][late-art]',
    '',
    '```mermaid',
    'graph TD; Late-->Skip',
    '```',
    '',
    '[late-art]: data:image/png;base64,iVBORw0KGgo=',
  ].join('\n');
  const full=agentDiagrams(source);
  expect(full).toHaveLength(5);
  const rangeStart=source.indexOf('![Early ref]');
  const rangeEnd=source.indexOf('```mermaid\ngraph TD; Late');
  const scoped=agentDiagrams(source,{start:rangeStart,end:rangeEnd});
  expect(scoped.map(item=>item.id)).toEqual(full.slice(1,4).map(item=>item.id));
  const scopedMeta=scoped.map(item=>diagramMetadata(source,item));
  const fullMeta=full.slice(1,4).map(item=>diagramMetadata(source,item));
  expect(scopedMeta).toEqual(fullMeta);
  expect(scopedMeta[0].assetReference).toBe('assets/early.svg');
  expect(scopedMeta[2].assetReference).toBe('(embedded image)');
  expect(scopedMeta[1].sourceStart).toBe(Array.from(source.slice(0,scoped[1].start)).length);
  expect(scopedMeta[1].sourceEnd).toBe(Array.from(source.slice(0,scoped[1].end)).length);
  expect(agentDiagrams(source,{start:rangeStart,end:rangeStart})).toEqual([]);
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

 const secondCell='plt.figure(); plt.plot([0, 1])';
 const multiCellSource=`# 😀 Figures\n\n\`\`\`python\nprint("cell 1")\n\`\`\`\n\n\`\`\`python\n${secondCell}\n\`\`\``;
 const ctxSecond={document:'/notes/a.md',cell:'0',interpreter:'embedded'};
 const resultSecond={ok:true,stdout:'',stderr:'',images:[pngData],provenance:{verified:true,document:'/notes/a.md',cell:'0',interpreter:'embedded'}};
 rememberPythonOutput(secondCell,resultSecond,ctxSecond);
 const releaseSecond=retainVisiblePython(secondCell,resultSecond,ctxSecond);
 const secondFenceStart=multiCellSource.indexOf(`\`\`\`python\n${secondCell}`);
 const scopedPy=agentDiagrams(multiCellSource,{documentPath:'/notes/a.md',python:'embedded',range:{start:secondFenceStart,end:multiCellSource.length}});
 expect(scopedPy).toHaveLength(1);
 expect(scopedPy[0].label).toBe('Python cell 2 — Figure 1');
 expect(scopedPy[0].id).toBe(`diagram:python:${Array.from(multiCellSource.slice(0,secondFenceStart)).length}:0`);
 releaseSecond();

 expect(invokeSpy).not.toHaveBeenCalledWith('run_python',expect.anything());
 releaseVisible();
 invokeSpy.mockRestore();
 pythonResults.clear();
});

const PNG_SIGNATURE=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const CRC32_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let i=0;i<256;i++){
    let crc=i;
    for(let bit=0;bit<8;bit++)crc=(crc&1)?(0xedb88320^(crc>>>1)):(crc>>>1);
    table[i]=crc>>>0;
  }
  return table;
})();
function crc32(bytes:Uint8Array):number{
  let crc=0xffffffff;
  for(const byte of bytes)crc=CRC32_TABLE[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
function adler32(bytes:Uint8Array):number{
  let s1=1,s2=0;
  for(const byte of bytes){s1=(s1+byte)%65521;s2=(s2+s1)%65521;}
  return ((s2<<16)|s1)>>>0;
}
function pngChunk(type:string,data:Uint8Array):Uint8Array{
  const chunk=new Uint8Array(12+data.length);
  const view=new DataView(chunk.buffer);
  view.setUint32(0,data.length);
  for(let i=0;i<4;i++)chunk[4+i]=type.charCodeAt(i);
  chunk.set(data,8);
  view.setUint32(8+data.length,crc32(chunk.subarray(4,8+data.length)));
  return chunk;
}
function createSyntheticPng(width:number,height:number,rgba:[number,number,number,number]){
  const ihdr=new Uint8Array(13);
  const ihdrView=new DataView(ihdr.buffer);
  ihdrView.setUint32(0,width);
  ihdrView.setUint32(4,height);
  ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  const stride=1+width*4;
  const raw=new Uint8Array(height*stride);
  for(let y=0;y<height;y++){
    const row=y*stride;
    raw[row]=0;
    for(let x=0;x<width;x++)raw.set(rgba,row+1+x*4);
  }
  const zlib=new Uint8Array(2+5+raw.length+4);
  zlib[0]=0x78;zlib[1]=0x01;zlib[2]=0x01;
  zlib[3]=raw.length&0xff;zlib[4]=(raw.length>>>8)&0xff;
  const nlen=(~raw.length)&0xffff;
  zlib[5]=nlen&0xff;zlib[6]=(nlen>>>8)&0xff;
  zlib.set(raw,7);
  new DataView(zlib.buffer).setUint32(7+raw.length,adler32(raw));
  const ihdrChunk=pngChunk('IHDR',ihdr);
  const idatChunk=pngChunk('IDAT',zlib);
  const iendChunk=pngChunk('IEND',new Uint8Array(0));
  const bytes=new Uint8Array(PNG_SIGNATURE.length+ihdrChunk.length+idatChunk.length+iendChunk.length);
  let offset=0;
  for(const part of [PNG_SIGNATURE,ihdrChunk,idatChunk,iendChunk]){bytes.set(part,offset);offset+=part.length;}
  let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  const base64=btoa(binary);
  return {bytes,base64,dataUri:`data:image/png;base64,${base64}`};
}
function decodeBase64Bytes(base64:string):Uint8Array{
  return Uint8Array.from(atob(base64),ch=>ch.charCodeAt(0));
}
function decodeBase64Utf8(base64:string):string{
  return new TextDecoder('utf-8',{fatal:true}).decode(decodeBase64Bytes(base64));
}

describe('diagramMedia remote consent and owning-note load_asset bridge',()=>{
  const cleanups:Array<()=>void>=[];
  afterEach(()=>{
    while(cleanups.length)cleanups.pop()!();
    vi.restoreAllMocks();
  });

  function installBridge(handler:(command:string,args:Record<string,unknown>)=>unknown|Promise<unknown>){
    const previous=window.SuperMD;
    const calls:Array<{command:string;args:Record<string,unknown>}>=[];
    window.SuperMD={
      post(id,command,rawArgs){
        const parsed=JSON.parse(rawArgs) as Record<string,unknown>;
        calls.push({command,args:parsed});
        void Promise.resolve().then(()=>handler(command,parsed)).then(
          value=>window.supermdReply?.(id,value,null),
          error=>window.supermdReply?.(id,null,error instanceof Error?error.message:String(error)),
        );
      },
    };
    cleanups.push(()=>{
      if(previous===undefined)delete window.SuperMD;
      else window.SuperMD=previous;
    });
    return calls;
  }

  it('refuses remote images that have not appeared in the reader without loading them',async()=>{
    const bridgeCalls=installBridge((command)=>{
      throw new Error(`Unexpected native bridge command: ${command}`);
    });
    const invokeSpy=vi.spyOn(nativeBridge,'invoke');
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network fetch'));

    const deck={
      title:'Walkthrough',
      steps:[
        {label:'Overview',markdown:'Before viewing the slide.'},
        {label:'Remote slide',image:'https://images.example/slide.png'},
      ],
    };
    const source=[
      '![Unseen plot](https://images.example/unseen-plot.png)',
      '',
      '![Unseen vector][remote-svg]',
      '',
      '![Uppercase remote](HTTPS://images.example/uppercase.png)',
      '',
      '```smd-steps',
      JSON.stringify(deck),
      '```',
      '',
      '[remote-svg]: http://images.example/unseen.svg',
    ].join('\n');

    const diagrams=agentDiagrams(source);
    expect(diagrams.map(item=>item.url)).toEqual([
      'https://images.example/unseen-plot.png',
      'http://images.example/unseen.svg',
      'HTTPS://images.example/uppercase.png',
      'https://images.example/slide.png',
    ]);

    for(const diagram of diagrams){
      await expect(diagramMedia(diagram,'/vault/notes/lecture.md')).rejects.toThrow(
        'Load this remote image in the app before requesting its pixels',
      );
    }
    expect(bridgeCalls).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Unconsented .remote-image-card / .image-error placeholders (and unrelated loaded remote images)
    // still do not count as the requested remote image having appeared in the reader.
    const otherPng=createSyntheticPng(2,2,[0x20,0x90,0x50,0xff]);
    const container=document.createElement('div');
    container.innerHTML=[
      '<span class="remote-image-card" data-note-image-source="https://images.example/unseen-plot.png"><button type="button">Load image</button></span>',
      '<span class="image-error" data-note-image-source="http://images.example/unseen.svg"><span>Image unavailable</span></span>',
      '<span class="note-image" data-note-image-source="https://images.example/other-loaded.png"><img class="other-loaded" alt="Other"/></span>',
    ].join('');
    document.body.append(container);
    cleanups.push(()=>container.remove());
    cleanups.push(registerMedia(container.querySelector('.other-loaded'),{label:'Other',uri:()=>otherPng.dataUri}));

    for(const diagram of diagrams){
      await expect(diagramMedia(diagram,'/vault/notes/lecture.md')).rejects.toThrow(
        'Load this remote image in the app before requesting its pixels',
      );
    }
    expect(bridgeCalls).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Once the user loads that exact remote image in the reader, diagramMedia reuses its registered
    // pixels offline without invoking load_asset/fetch_resource or fetch, and refuses again once unmounted.
    const consentedPng=createSyntheticPng(3,2,[0x16,0x88,0xdd,0xff]);
    const mounted=document.createElement('span');
    mounted.className='note-image';
    mounted.dataset.noteImageSource='https://images.example/unseen-plot.png';
    const mountedImg=document.createElement('img');
    mountedImg.alt='Unseen plot';
    mounted.append(mountedImg);
    document.body.append(mounted);
    const unregisterMounted=registerMedia(mountedImg,{label:'Unseen plot',uri:()=>consentedPng.dataUri});

    const loadedMedia=await diagramMedia(diagrams[0],'/vault/notes/lecture.md');
    const exported=await mediaBytes(loadedMedia,'original');
    expect(exported.mimeType).toBe('image/png');
    expect(exported.filename).toBe('Unseen plot.png');
    expect(exported.width).toBe(3);
    expect(exported.height).toBe(2);
    expect(decodeBase64Bytes(exported.body)).toEqual(consentedPng.bytes);
    expect(bridgeCalls).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    unregisterMounted();
    mounted.remove();
    await expect(diagramMedia(diagrams[0],'/vault/notes/lecture.md')).rejects.toThrow(
      'Load this remote image in the app before requesting its pixels',
    );
    expect(bridgeCalls).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads relative PNG and SVG images via load_asset with the owning note path and preserves MIME and canonical bytes',async()=>{
    const owningNotePath='/vault/courses/ml/lecture-03.md';
    const lossPng=createSyntheticPng(3,2,[0x16,0x88,0xdd,0xff]);
    const pipelineSvgSource='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><rect width="48" height="32" fill="#ffffff"/><path id="pipeline-edge" d="M6 26 L24 8 L42 26" stroke="#1688dd" stroke-width="3" fill="none"/></svg>';
    const pipelineSvgDataUri=`data:image/svg+xml;base64,${btoa(pipelineSvgSource)}`;
    const stepSvgSource='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40"><rect width="64" height="40" fill="#ffffff"/><circle id="step-centroid" cx="20" cy="20" r="8" fill="#d9480f"/></svg>';
    const stepSvgDataUri=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(stepSvgSource)}`;

    const assetsBySource:Record<string,string>={
      'assets/plots/loss.png':lossPng.dataUri,
      '../shared/pipeline.svg':pipelineSvgDataUri,
      './slides/init.svg':stepSvgDataUri,
    };

    const bridgeCalls=installBridge((command,args)=>{
      if(command!=='load_asset')throw new Error(`Unexpected command: ${command}`);
      if(args.documentPath!==owningNotePath)throw new Error(`Wrong documentPath: ${String(args.documentPath)}`);
      const hit=assetsBySource[String(args.source)];
      if(!hit)throw new Error(`Missing fixture for ${String(args.source)}`);
      return hit;
    });
    const invokeSpy=vi.spyOn(nativeBridge,'invoke');
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network fetch'));

    const deck={
      title:'K-means',
      steps:[
        {label:'Initialize',image:'./slides/init.svg'},
        {label:'Converge',markdown:'Centroids stabilize.'},
      ],
    };
    const source=[
      '![Loss curve](assets/plots/loss.png)',
      '',
      '![Pipeline architecture][arch]',
      '',
      '```smd-steps',
      JSON.stringify(deck),
      '```',
      '',
      '[arch]: ../shared/pipeline.svg',
    ].join('\n');

    const diagrams=agentDiagrams(source);
    expect(diagrams).toHaveLength(3);

    // 1. Relative PNG image -> load_asset bridge call + image/png MIME + canonical PNG bytes & IHDR dimensions.
    const pngMedia=await diagramMedia(diagrams[0],owningNotePath);
    const pngOut=await mediaBytes(pngMedia,'original');
    expect(invokeSpy).toHaveBeenNthCalledWith(1,'load_asset',{
      documentPath:owningNotePath,
      source:'assets/plots/loss.png',
    });
    expect(pngOut.mimeType).toBe('image/png');
    expect(pngOut.filename).toBe('Loss curve.png');
    expect(pngOut.width).toBe(3);
    expect(pngOut.height).toBe(2);
    const decodedPng=decodeBase64Bytes(pngOut.body);
    expect(decodedPng.subarray(0,8)).toEqual(PNG_SIGNATURE);
    expect(decodedPng).toEqual(lossPng.bytes);

    // 2. Reference relative SVG (base64 data URI) -> load_asset bridge call + image/svg+xml MIME + canonical SVG XML.
    const archMedia=await diagramMedia(diagrams[1],owningNotePath);
    const archOut=await mediaBytes(archMedia,'svg');
    expect(invokeSpy).toHaveBeenNthCalledWith(2,'load_asset',{
      documentPath:owningNotePath,
      source:'../shared/pipeline.svg',
    });
    expect(archOut.mimeType).toBe('image/svg+xml');
    expect(archOut.filename).toBe('Pipeline architecture.svg');
    const archXmlText=decodeBase64Utf8(archOut.body);
    const archXml=new DOMParser().parseFromString(archXmlText,'image/svg+xml');
    expect(archXml.querySelector('parsererror')).toBeNull();
    expect(archXml.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(archXml.documentElement.getAttribute('viewBox')).toBe('0 0 48 32');
    expect(archXml.documentElement.getAttribute('width')).toBe('48');
    expect(archXml.documentElement.getAttribute('height')).toBe('32');
    const edge=archXml.getElementById('pipeline-edge');
    expect(edge?.getAttribute('d')).toBe('M6 26 L24 8 L42 26');
    expect(edge?.getAttribute('stroke')?.toLowerCase()).toBe('#1688dd');

    // 3. Step-deck relative SVG (percent-encoded UTF-8 data URI) -> load_asset bridge call + canonical SVG XML.
    const stepMedia=await diagramMedia(diagrams[2],owningNotePath);
    const stepOut=await mediaBytes(stepMedia,'original');
    expect(invokeSpy).toHaveBeenNthCalledWith(3,'load_asset',{
      documentPath:owningNotePath,
      source:'./slides/init.svg',
    });
    expect(stepOut.mimeType).toBe('image/svg+xml');
    expect(stepOut.filename).toBe('K-means — Initialize.svg');
    const stepXmlText=decodeBase64Utf8(stepOut.body);
    const stepXml=new DOMParser().parseFromString(stepXmlText,'image/svg+xml');
    expect(stepXml.querySelector('parsererror')).toBeNull();
    expect(stepXml.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(stepXml.documentElement.getAttribute('width')).toBe('64');
    expect(stepXml.documentElement.getAttribute('height')).toBe('40');
    const centroid=stepXml.getElementById('step-centroid');
    expect(centroid?.getAttribute('cx')).toBe('20');
    expect(centroid?.getAttribute('cy')).toBe('20');
    expect(centroid?.getAttribute('r')).toBe('8');

    expect(bridgeCalls).toEqual([
      {command:'load_asset',args:{documentPath:owningNotePath,source:'assets/plots/loss.png'}},
      {command:'load_asset',args:{documentPath:owningNotePath,source:'../shared/pipeline.svg'}},
      {command:'load_asset',args:{documentPath:owningNotePath,source:'./slides/init.svg'}},
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards each owning note path to load_asset when resolving identically named relative images across notes',async()=>{
    const pngAlpha=createSyntheticPng(3,2,[0x12,0x64,0xab,0xff]);
    const pngBeta=createSyntheticPng(5,4,[0xd9,0x48,0x0f,0xff]);
    const pngDraft=createSyntheticPng(2,2,[0x2b,0x8a,0x3e,0xff]);
    const fixturesByDocPath:Record<string,ReturnType<typeof createSyntheticPng>>={
      '/vault/alpha/summary.md':pngAlpha,
      '/vault/beta/nested/summary.md':pngBeta,
      '':pngDraft,
    };

    const bridgeCalls=installBridge((command,args)=>{
      if(command!=='load_asset'||args.source!=='assets/figure.png'){
        throw new Error(`Unexpected bridge call: ${command} ${JSON.stringify(args)}`);
      }
      const fixture=fixturesByDocPath[String(args.documentPath)];
      if(!fixture)throw new Error(`Unexpected documentPath: ${String(args.documentPath)}`);
      return fixture.dataUri;
    });
    const invokeSpy=vi.spyOn(nativeBridge,'invoke');

    const [diagram]=agentDiagrams('![Shared name](assets/figure.png)');
    expect(diagram.kind).toBe('image');

    const alphaOut=await mediaBytes(await diagramMedia(diagram,'/vault/alpha/summary.md'),'original');
    const betaOut=await mediaBytes(await diagramMedia(diagram,'/vault/beta/nested/summary.md'),'original');
    const draftOut=await mediaBytes(await diagramMedia(diagram,null),'original');

    expect(invokeSpy.mock.calls).toEqual([
      ['load_asset',{documentPath:'/vault/alpha/summary.md',source:'assets/figure.png'}],
      ['load_asset',{documentPath:'/vault/beta/nested/summary.md',source:'assets/figure.png'}],
      ['load_asset',{documentPath:'',source:'assets/figure.png'}],
    ]);
    expect(bridgeCalls).toEqual([
      {command:'load_asset',args:{documentPath:'/vault/alpha/summary.md',source:'assets/figure.png'}},
      {command:'load_asset',args:{documentPath:'/vault/beta/nested/summary.md',source:'assets/figure.png'}},
      {command:'load_asset',args:{documentPath:'',source:'assets/figure.png'}},
    ]);

    expect({mime:alphaOut.mimeType,w:alphaOut.width,h:alphaOut.height,bytes:decodeBase64Bytes(alphaOut.body)}).toEqual({
      mime:'image/png',
      w:3,
      h:2,
      bytes:pngAlpha.bytes,
    });
    expect({mime:betaOut.mimeType,w:betaOut.width,h:betaOut.height,bytes:decodeBase64Bytes(betaOut.body)}).toEqual({
      mime:'image/png',
      w:5,
      h:4,
      bytes:pngBeta.bytes,
    });
    expect({mime:draftOut.mimeType,w:draftOut.width,h:draftOut.height,bytes:decodeBase64Bytes(draftOut.body)}).toEqual({
      mime:'image/png',
      w:2,
      h:2,
      bytes:pngDraft.bytes,
    });
  });
});
