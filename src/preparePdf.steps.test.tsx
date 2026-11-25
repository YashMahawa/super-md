// @vitest-environment jsdom
import {afterEach, expect, it, vi} from "vitest";
const {invoke} = vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("./nativeBridge",()=>({invoke}));
import {registerMedia} from "./mediaExport";
import {preparePdf} from "./preparePdf";
afterEach(()=>{invoke.mockReset();document.body.innerHTML="";});

it("exports every image in a sequence, preserving labels, captions and surrounding blocks",async()=>{
  invoke.mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+");
  const steps = Array.from({length:7},(_,i)=>({label:`Stage ${i+1}`,image:`assets/${i}.svg`,description:`Caption ${i+1}`}));
  const source = '# Before\n\n```smd-steps\n'+JSON.stringify({title:'Sequence',steps})+'\n```\n\n## After\n\nText.';
  const result=await preparePdf(source,'/notes/a.smd');
  expect(invoke).toHaveBeenCalledTimes(7);
  expect(Object.keys(result.assets)).toHaveLength(7);
  const grid=JSON.parse(/```smd-step-grid\n([\s\S]*?)\n```/.exec(result.content)![1]);
  expect(grid.steps.map((s:any)=>s.label)).toEqual(steps.map(s=>s.label));
  for(const step of grid.steps)expect(result.assets[step.image]).toBe('PHN2Zy8+');
  expect(result.content).toContain('\n\n## After\n\n');
  expect(source).toContain('```smd-steps');
});

it("prepares declarative diagrams and charts as actual print SVGs",async()=>{
  const diagram={width:240,height:100,nodes:[{id:'a',label:'A',x:60,y:50},{id:'b',label:'B',x:180,y:50,state:'active'}],edges:[{from:'a',to:'b'}]};
  const chart={title:'Line',xRange:[-2,2],yRange:[-2,2],series:[{expression:'x'}]};
  const source='```smd-steps\n'+JSON.stringify({title:'Mixed',steps:[{label:'Nodes',diagram},{label:'Plot',chart},{label:'Interpretation',description:'A plain text frame'}]})+'\n```';
  const result=await preparePdf(source,null);
  expect(Object.keys(result.assets)).toHaveLength(2);
  const svg=atob(Object.values(result.assets)[0]);
  expect(svg).toContain('stroke="#667085"');
  expect(svg).toContain('fill="#ffb367"');
  expect(result.content).toContain('A plain text frame');
});

it("reports malformed decks rather than printing their raw JSON",async()=>{
  await expect(preparePdf('```smd-steps\n{"steps":[]}\n```',null)).rejects.toThrow('Invalid step cards');
});

it("keeps step Markdown and LaTeX as formatted export content",async()=>{
  const source='```smd-steps\n'+JSON.stringify({title:'Calculation',steps:[{label:'Mean',markdown:'**Result**\n\n$$x=3$$'},{label:'Interpretation',markdown:'- First item\n- Second item'}]})+'\n```';
  const prepared=await preparePdf(source,null);
  const grid=JSON.parse(/```smd-step-grid\n([\s\S]*?)\n```/.exec(prepared.content)![1]);
  expect(grid.steps[0].markdown).toContain('**Result**');
  expect(grid.steps[0].markdown).toContain('$$');
  expect(grid.steps[1].markdown).toContain('First item');
});

it("exports smd-chart point arrays and code literals alongside prose wikilinks and callouts without JSON corruption",async()=>{
  const source=[
    ':::callout tip Overview',
    'Compare [[#Samples|sample plot]] and [[Notes|study notes]].',
    ':::',
    '',
    '## Samples',
    '',
    '```smd-chart',
    '{"title":"Discrete","series":[{"name":"Points","points":[[0,1],[1,3]]}]}',
    '```',
    '',
    '```python',
    'matrix = [[1, 2]]',
    '```',
    '',
    '```bash',
    'if [[ -f note.md ]]; then echo ok; fi',
    '```',
  ].join('\n');
  const prepared=await preparePdf(source,null);
  expect(Object.keys(prepared.assets)).toHaveLength(1);
  const svg=atob(Object.values(prepared.assets)[0]);
  expect(svg).toContain('<svg');
  expect(prepared.content).toContain('[!TIP] Overview');
  expect(prepared.content).toContain('[sample plot](#samples)');
  expect(prepared.content).toContain('[study notes](Notes.md)');
  expect(prepared.content).toContain('matrix = [[1, 2]]');
  expect(prepared.content).toContain('if [[ -f note.md ]]; then echo ok; fi');
});

it("exports standalone smd-tree, smd-diagram, and svg blocks as vector SVGs and rejects invalid diagrams or active SVGs",async()=>{
  const source=[
    '# Diagrams',
    '',
    '```smd-tree',
    JSON.stringify({title:'Max Heap',values:[50,30,40,10,20,35],highlight:[5]}),
    '```',
    '',
    '```smd-diagram',
    JSON.stringify({title:'State Flow',width:280,height:120,nodes:[{id:'s1',label:'Start',x:70,y:60,state:'visited'},{id:'s2',label:'End',x:210,y:60,shape:'box',state:'active'}],edges:[{from:'s1',to:'s2',dashed:true}]}),
    '```',
    '',
    '```svg',
    '<svg viewBox="0 0 80 40"><circle cx="40" cy="20" r="14" fill="#386a57"/></svg>',
    '```',
  ].join('\n');
  const prepared=await preparePdf(source,null);
  expect(Object.keys(prepared.assets)).toEqual(['diagram-1.svg','diagram-2.svg','diagram-3.svg']);
  expect(prepared.content).toContain('![Max Heap](diagram-1.svg)');
  expect(prepared.content).toContain('![State Flow](diagram-2.svg)');
  expect(prepared.content).toContain('![Diagram](diagram-3.svg)');
  expect(atob(prepared.assets['diagram-1.svg'])).toContain('fill="#ffb367"');
  expect(atob(prepared.assets['diagram-2.svg'])).toContain('stroke-dasharray="5 7"');
  expect(atob(prepared.assets['diagram-3.svg'])).toContain('xmlns="http://www.w3.org/2000/svg"');

  await expect(preparePdf('```smd-tree\n{"values":[null]}\n```',null)).rejects.toThrow('Invalid diagram');
  await expect(preparePdf('```smd-diagram\n{"nodes":[]}\n```',null)).rejects.toThrow('Invalid diagram');
  await expect(preparePdf('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n```',null)).rejects.toThrow('without scripts');
});

it("rewrites Obsidian numeric pipe widths and HTML img sizes while preserving page breaks",async()=>{
  invoke.mockResolvedValue('data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60"/></svg>'));
  const source=[
    '![[assets/obsidian.svg|300]]',
    '',
    '![[assets/captioned.svg|Diagram Caption]]',
    '',
    '<img src="assets/sized.svg" alt="Sized" width="200px" />',
    '',
    'Inline <img src="assets/zoomed.svg" style="zoom:50%" /> figure.',
    '',
    '<div style="page-break-after:always"></div>',
    '',
    '\\newpage',
    '',
    '{{< pagebreak >}}',
  ].join('\n');
  const prepared=await preparePdf(source,'/notes/sizing.md');
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(prepared.content).toContain('![assets/obsidian.svg](asset-1.svg){width=300}');
  expect(prepared.content).toContain('![Diagram Caption](asset-2.svg)');
  expect(prepared.content).toContain('![Sized](asset-3.svg){width=200px}');
  expect(prepared.content).toContain('Inline ![Image](asset-4.svg){zoom=50%} figure.');
  expect(prepared.content).toContain('<div style="page-break-after:always"></div>');
  expect(prepared.content).toContain('\\newpage');
  expect(prepared.content).toContain('{{< pagebreak >}}');
});

it("parses HTML img tags with > and attribute-like text inside quoted alt and title attributes",async()=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  invoke.mockResolvedValue(png);
  const source=[
    '<img alt="A > B" src="assets/plot.png" width="300">',
    '',
    `<p data-caption="x > y"><img title='Ratio: 2 > 1 & "quoted"' alt='src=wrong.png width=999 > real' src="assets/wrapped.png" style="width: 240px; zoom: 50%" /></p>`,
    '',
    `Inline <img alt="Left > Right" title="Upper > Lower" src="assets/inline.png" width="180"> comparison.`,
    '',
    '<img alt="Multi > Line"\n  title="Span > Break"\n  src="assets/multiline.png"\n  width="150">',
  ].join('\n');
  const prepared=await preparePdf(source,'/notes/quoted.md');
  expect(invoke.mock.calls.map(call=>call[1])).toEqual([
    {documentPath:'/notes/quoted.md',source:'assets/plot.png'},
    {documentPath:'/notes/quoted.md',source:'assets/wrapped.png'},
    {documentPath:'/notes/quoted.md',source:'assets/inline.png'},
    {documentPath:'/notes/quoted.md',source:'assets/multiline.png'},
  ]);
  expect(Object.keys(prepared.assets)).toEqual(['asset-1.png','asset-2.png','asset-3.png','asset-4.png']);
  expect(prepared.content).toContain('![A > B](asset-1.png){width=300}');
  expect(prepared.content).toContain('![src=wrong.png width=999 > real](asset-2.png "Ratio: 2 > 1 & \\"quoted\\""){width=240px zoom=50%}');
  expect(prepared.content).toContain('Inline ![Left > Right](asset-3.png "Upper > Lower"){width=180} comparison.');
  expect(prepared.content).toContain('![Multi > Line](asset-4.png "Span > Break"){width=150}');
  expect(prepared.content).not.toContain('<img');
});

it("blocks untrusted remote HTML img URLs without ever invoking fetch_resource while preserving consented and offline local HTML img export",async()=>{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const svg='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="45"><rect width="90" height="45"/></svg>');
  invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='fetch_resource')return {body:svg};
    if(command==='load_asset')return png;
    throw new Error(`Unexpected native call: ${command} ${JSON.stringify(args)}`);
  });

  // 1. Untrusted remote HTML <img> variants (including mixed with offline local images or inside smd-steps) never invoke fetch_resource.
  const untrustedInputs=[
    '<img src="https://untrusted.example/remote.png" width="300">',
    '<p><img alt="A > B" src="http://untrusted.example/wrapped.png" style="width: 240px"></p>',
    'Inline <img src="https://untrusted.example/inline.png" width="120"> text.',
    '<img src="//untrusted.example/protocol-relative.png">',
    '<img src="https:untrusted.example/no-slashes.png">',
    '<img src="https://user:pass@images.example/credentialed.png">',
    '<img src="assets/local.png" width="180">\n\n<img src="https://untrusted.example/after-local.png" width="300">',
    '```smd-steps\n'+JSON.stringify({title:'Steps',steps:[{label:'Step 1',markdown:'<img src="https://untrusted.example/in-step.png" width="160">'},{label:'Step 2',description:'Done'}]})+'\n```',
  ];
  for(const input of untrustedInputs){
    await expect(preparePdf(input,'/notes/consent.md','embedded',{trustedImageHosts:['images.example']})).rejects.toThrow(/consent/i);
  }
  expect(invoke).not.toHaveBeenCalledWith('fetch_resource',expect.anything());
  expect(invoke).not.toHaveBeenCalled();

  // 2. Unapproved .remote-image-card placeholder in the reader DOM does not grant consent.
  const blockedCard=document.createElement('span');
  blockedCard.className='remote-image-card';
  blockedCard.dataset.noteImageSource='https://once.example/card-only.png';
  document.body.append(blockedCard);
  await expect(preparePdf('<img src="https://once.example/card-only.png" width="200">','/notes/consent.md')).rejects.toThrow(/consent/i);
  expect(invoke).not.toHaveBeenCalledWith('fetch_resource',expect.anything());

  // 3. One-time reader consent (loaded [data-note-image-source] media) exports that exact URL offline without invoking fetch_resource,
  //    and never carries consent to a different URL on the same host.
  const loadedSpan=document.createElement('span');
  loadedSpan.className='note-image';
  loadedSpan.dataset.noteImageSource='https://once.example/approved-once.png';
  const loadedImg=document.createElement('img');
  loadedSpan.append(loadedImg);
  document.body.append(loadedSpan);
  const unregister=registerMedia(loadedImg,{label:'Approved Once',uri:()=>png});
  try{
    const oncePrepared=await preparePdf('<img alt="Once" src="https://once.example/approved-once.png" width="210">','/notes/consent.md');
    expect(invoke).not.toHaveBeenCalledWith('fetch_resource',expect.anything());
    expect(oncePrepared.content).toContain('![Once](asset-1.png){width=210}');
    expect(Object.keys(oncePrepared.assets)).toEqual(['asset-1.png']);

    await expect(preparePdf('<img src="https://once.example/different.png" width="210">','/notes/consent.md')).rejects.toThrow(/consent/i);
    expect(invoke).not.toHaveBeenCalledWith('fetch_resource',expect.anything());
  }finally{
    unregister();
  }

  // 4. Offline local and inline data: HTML <img> export works without trusted hosts and never invokes fetch_resource.
  const offlinePrepared=await preparePdf(
    `<img alt="Local" src="assets/offline.png" width="220">\n\n<img alt="Embedded" src="${png}" style="zoom:50%">`,
    '/notes/consent.md',
  );
  expect(invoke).not.toHaveBeenCalledWith('fetch_resource',expect.anything());
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('load_asset',{documentPath:'/notes/consent.md',source:'assets/offline.png'});
  expect(Object.keys(offlinePrepared.assets).sort()).toEqual(['asset-1.png','asset-2.png']);
  expect(offlinePrepared.content).toMatch(/!\[Local\]\(asset-[12]\.png\)\{width=220\}/);
  expect(offlinePrepared.content).toMatch(/!\[Embedded\]\(asset-[12]\.png\)\{zoom=50%\}/);

  // 5. Explicitly trusted reader image host allows remote HTML <img> export through fetch_resource.
  invoke.mockClear();
  const trustedPrepared=await preparePdf(
    '<img alt="Trusted Diagram" src="https://images.example/approved.svg" width="240">',
    '/notes/consent.md',
    'embedded',
    {trustedImageHosts:['images.example']},
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('fetch_resource',{url:'https://images.example/approved.svg',image:true});
  expect(trustedPrepared.content).toContain('![Trusted Diagram](asset-1.svg){width=240}');
});
