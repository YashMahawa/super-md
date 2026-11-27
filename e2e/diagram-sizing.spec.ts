import {test,expect} from '@playwright/test';

const vector='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160" viewBox="0 0 400 160"><rect width="400" height="160" fill="#e6edf6"/><path d="M20 130L110 80L220 110L380 20" fill="none" stroke="#3072b8" stroke-width="3"/><text x="35" y="35" font-size="18">A readable diagram</text></svg>';
const svgUri='data:image/svg+xml;base64,'+Buffer.from(vector).toString('base64');
const icon='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3072b8"/></svg>').toString('base64');

const portraitSvg='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="300" viewBox="0 0 140 300"><rect width="140" height="300" rx="12" fill="#eef3f8"/><rect x="20" y="24" width="100" height="56" rx="8" fill="#ffffff" stroke="#3072b8" stroke-width="2"/><text x="70" y="57" text-anchor="middle" font-size="14" fill="#1c2635">Input</text><path d="M70 80 V200" stroke="#3072b8" stroke-width="2"/><rect x="20" y="200" width="100" height="56" rx="8" fill="#ffffff" stroke="#3072b8" stroke-width="2"/><text x="70" y="233" text-anchor="middle" font-size="14" fill="#1c2635">Output</text></svg>';
const portraitViewBoxOnly='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 300"><rect width="140" height="300" rx="12" fill="#eef3f8"/><circle cx="70" cy="70" r="34" fill="#ffffff" stroke="#3072b8" stroke-width="2"/><path d="M70 104 V196" stroke="#3072b8" stroke-width="2"/><circle cx="70" cy="230" r="34" fill="#ffffff" stroke="#3072b8" stroke-width="2"/></svg>';
const portraitSvgUri='data:image/svg+xml;base64,'+Buffer.from(portraitSvg).toString('base64');

const wideSequenceBody=[
  'sequenceDiagram',
  '  participant Client as Mobile App',
  '  participant Edge as API Gateway',
  '  participant Auth as Auth Service',
  '  participant Ledger as Billing Ledger',
  '  participant Store as Primary DB',
  '  participant Queue as Notification Worker',
  '  participant Hook as Webhook Dispatcher',
  '  Client->>Edge: POST /v1/checkout (idempotency_key)',
  '  Edge->>Auth: Validate bearer session token',
  '  Auth-->>Edge: Session principal + scopes',
  '  Edge->>Ledger: Reserve payment authorization',
  '  Ledger->>Store: Commit ledger entry + audit row',
  '  Store-->>Ledger: Committed tx_id',
  '  Ledger->>Queue: Enqueue receipt + push event',
  '  Queue->>Hook: Deliver signed merchant webhook',
  '  Hook-->>Client: 200 OK checkout confirmation',
].join('\n');

const sizes=[
  {name:'desktop',width:1920,height:1080,zoom:100},
  {name:'tablet',width:1024,height:768,zoom:100},
  {name:'phone landscape',width:915,height:412,zoom:100},
  {name:'phone portrait',width:412,height:915,zoom:100},
  {name:'desktop magnified',width:1600,height:900,zoom:180},
  {name:'desktop reduced',width:1600,height:900,zoom:40},
];

for(const size of sizes)for(const mode of ['reader','live','split'] as const){
  test(`diagrams keep suitable intrinsic dimensions while preserving full-column Python plots, photos, and inline icons: ${size.name}, ${mode}`,async({page})=>{
    await page.setViewportSize({width:size.width,height:size.height});
    await page.addInitScript(svg=>{
      const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;
      const ctx=canvas.getContext('2d')!;ctx.fillStyle='#b7d5c9';ctx.fillRect(0,0,80,40);
      const raster=canvas.toDataURL();
      (window as any).testRaster=raster;
      window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='run_python'?{ok:true,stdout:'',stderr:'',images:[svg,raster]}:null,null))};
    },svgUri);
    await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
    await page.evaluate(({vector,svgUri,icon,mode,size})=>{
      document.documentElement.dataset.platform=size.name.startsWith('phone')||size.name==='tablet'?'android':'desktop';
      document.documentElement.dataset.host=document.documentElement.dataset.platform==='android'?'android':'qt';
      const content=['# Readable figures','```svg\n'+vector+'\n```','![Linked vector]('+svgUri+')','```mermaid\nflowchart LR\nA[Read] --> B[Understand] --> C[Apply]\n```','![Photo]('+(window as any).testRaster+')','An inline icon ![Inline icon]('+icon+') stays small.','```python\nprint("fixture")\n```'].join('\n\n');
      window.supermdLoad?.({id:'responsive-diagrams',content,path:null,mode,dark:false,colors:{},font:'Manrope',size:16,zoom:size.zoom,restorePosition:false});
    },{vector,svgUri,icon,mode,size});
    await expect(page.locator('.mermaid img')).toBeVisible();
    await page.getByRole('button',{name:'Run',exact:true}).click();
    const diagrams=page.locator('.svg-figure img,.media-paragraph .note-image--diagram img,.cell-output > img');
    await expect(diagrams).toHaveCount(5);
    expect(await page.locator('.mermaid svg, .svg-figure svg, .media-paragraph svg').count()).toBe(0);
    for(const diagram of await diagrams.all()){
      await expect.poll(()=>diagram.evaluate(node=>(node as HTMLImageElement).complete&&node.getBoundingClientRect().height>0)).toBe(true);
      const geometry=await diagram.evaluate(node=>{
        const image=node as HTMLImageElement;
        const inPython=Boolean(image.closest('.cell-output'));
        const container=image.closest('.svg-figure,.media-paragraph,.cell-output')!;
        const sizedHost=image.closest<HTMLElement>('[data-svg-sized="true"]')??image;
        const box=image.getBoundingClientRect(),parent=container.getBoundingClientRect(),style=getComputedStyle(image),cs=getComputedStyle(container);
        const scale=Number(image.closest<HTMLElement>('.document-page')?.dataset.scale)||(sizeZoom());
        function sizeZoom(){
          const pageEl=image.closest<HTMLElement>('.document-page');
          const zoomVal=pageEl?parseFloat(pageEl.style.zoom||'1'):1;
          return Number.isFinite(zoomVal)&&zoomVal>0?zoomVal:1;
        }
        const horizontal=['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'] as const;
        const vertical=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'] as const;
        const frameX=horizontal.reduce((sum,key)=>sum+parseFloat(style[key]),0)*scale;
        const frameY=vertical.reduce((sum,key)=>sum+parseFloat(style[key]),0)*scale;
        const available=parent.width-horizontal.reduce((sum,key)=>sum+parseFloat(cs[key]),0)*scale;
        const cssMax=parseFloat(sizedHost.style.getPropertyValue('--svg-width')||'0')*scale;
        const cssMin=parseFloat(sizedHost.style.getPropertyValue('--svg-min-width')||'0')*scale;
        const expectedIntrinsic=Math.min(Math.max(cssMin+frameX,available),cssMax+frameX);
        return {
          inPython,
          draggable:image.getAttribute('draggable'),
          width:box.width,
          available,
          expectedIntrinsic,
          cssMax,
          ratio:(box.width-frameX)/(box.height-frameY),
          natural:image.naturalWidth/image.naturalHeight,
        };
      });
      expect(geometry.draggable).toBe('false');
      if(geometry.inPython){
        expect(Math.abs(geometry.width-geometry.available)).toBeLessThan(2);
      }else{
        expect(geometry.cssMax).toBeGreaterThan(0);
        expect(Math.abs(geometry.width-geometry.expectedIntrinsic)).toBeLessThan(3);
      }
      expect(geometry.ratio).toBeCloseTo(geometry.natural,1);
    }
    const photo=page.getByRole('img',{name:'Photo',exact:true}),inline=page.getByRole('img',{name:'Inline icon',exact:true});
    expect(await photo.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThan(85*size.zoom/100);
    expect(await inline.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThan(29*size.zoom/100);
    await page.locator('.mermaid img').click();
    await expect(page.getByRole('dialog',{name:'Image viewer'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog',{name:'Image viewer'})).toHaveCount(0);
  });
}

test('small portrait SVG (width/height, viewBox-only, and linked) and portrait Mermaid stay compact while Python plots fill the column',async({page})=>{
  await page.setViewportSize({width:1280,height:900});
  await page.addInitScript(svg=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=240;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#dce8f5';ctx.fillRect(0,0,640,240);
    const raster=canvas.toDataURL();
    window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='run_python'?{ok:true,stdout:'',stderr:'',images:[svg,raster]}:null,null))};
  },svgUri);
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(({portraitSvg,portraitViewBoxOnly,portraitSvgUri})=>{
    document.documentElement.dataset.platform='desktop';
    document.documentElement.dataset.host='qt';
    const content=[
      '# Small portrait diagrams vs Python plots',
      '```svg\n'+portraitSvg+'\n```',
      '```svg\n'+portraitViewBoxOnly+'\n```',
      '![Linked portrait]('+portraitSvgUri+')',
      '```mermaid\nflowchart TD\n  A[Start] --> B[Verify] --> C[Done]\n```',
      '```python\nprint("plots")\n```',
    ].join('\n\n');
    window.supermdLoad?.({id:'portrait-vs-python',content,path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  },{portraitSvg,portraitViewBoxOnly,portraitSvgUri});

  await expect(page.locator('.mermaid img')).toBeVisible();
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await expect(page.locator('.cell-output img')).toHaveCount(2);
  await expect.poll(()=>page.evaluate(()=>Array.from(document.querySelectorAll<HTMLImageElement>('.cell-output img')).every(img=>img.complete&&img.getBoundingClientRect().height>0))).toBe(true);

  const metrics=await page.evaluate(()=>{
    const columnWidth=document.querySelector('.markdown-body')!.getBoundingClientRect().width;
    const measure=(el:Element)=>{
      const img=el as HTMLImageElement,r=img.getBoundingClientRect(),cs=getComputedStyle(img);
      const padX=parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)+parseFloat(cs.borderLeftWidth)+parseFloat(cs.borderRightWidth);
      const padY=parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)+parseFloat(cs.borderTopWidth)+parseFloat(cs.borderBottomWidth);
      return {width:r.width,height:r.height,contentWidth:r.width-padX,contentHeight:r.height-padY};
    };
    const standaloneSvgs=Array.from(document.querySelectorAll(':not(.mermaid):not(.cell-output) > .svg-figure img.svg-diagram'),measure);
    const linkedPortrait=measure(document.querySelector('.media-paragraph .note-image--diagram img')!);
    const portraitMermaid=measure(document.querySelector('.mermaid img.svg-diagram')!);
    const cellOutput=document.querySelector('.cell-output')!,cellCs=getComputedStyle(cellOutput);
    const cellOutputWidth=cellOutput.getBoundingClientRect().width-parseFloat(cellCs.paddingLeft)-parseFloat(cellCs.paddingRight)-parseFloat(cellCs.borderLeftWidth)-parseFloat(cellCs.borderRightWidth);
    const pythonPlots=Array.from(document.querySelectorAll('.cell-output img'),measure);
    return {columnWidth,cellOutputWidth,standaloneSvgs,linkedPortrait,portraitMermaid,pythonPlots};
  });

  expect(metrics.columnWidth).toBeGreaterThan(900);
  expect(metrics.standaloneSvgs).toHaveLength(2);
  for(const svg of [...metrics.standaloneSvgs,metrics.linkedPortrait]){
    expect(svg.contentWidth).toBeCloseTo(140,0);
    expect(svg.contentHeight).toBeCloseTo(300,0);
    expect(svg.width).toBeLessThan(200);
  }
  expect(metrics.portraitMermaid.width).toBeGreaterThan(70);
  expect(metrics.portraitMermaid.width).toBeLessThan(240);
  expect(metrics.portraitMermaid.height).toBeGreaterThan(metrics.portraitMermaid.width);

  expect(metrics.pythonPlots).toHaveLength(2);
  for(const plot of metrics.pythonPlots){
    expect(Math.abs(plot.width-metrics.cellOutputWidth)).toBeLessThan(2);
    expect(plot.width).toBeGreaterThan(900);
  }
});

test('wide sequence diagrams on mobile keep readable intrinsic scale, render as inert images, pan horizontally via native wheel, and export cleanly',async({page})=>{
  await page.setViewportSize({width:412,height:915});
  await page.addInitScript(()=>{
    (window as any).savedMedia=[];
    window.SuperMD={post:(id,command,raw)=>{
      if(command==='save_media_native')(window as any).savedMedia.push(JSON.parse(raw));
      queueMicrotask(()=>window.supermdReply?.(id,command==='save_media_native'?{filename:'sequence-export'}:true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(wideSequenceBody=>{
    document.documentElement.dataset.platform='android';
    document.documentElement.dataset.host='qt';
    const trailing=Array.from({length:18},(_,i)=>`Paragraph ${i+1}: Mobile sequence diagram verification keeps vertical scrolling responsive below the diagram.`).join('\n\n');
    const content=[
      '# Wide sequence mobile panning',
      '```mermaid\n'+wideSequenceBody+'\n```',
      '```mermaid\n%%{init: {"theme": "base"}}%%\n'+wideSequenceBody+'\n```',
      trailing,
    ].join('\n\n');
    window.supermdLoad?.({id:'wide-sequence-mobile',content,path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100,centerLock:true,restorePosition:false});
  },wideSequenceBody);

  const mermaidBlocks=page.locator('.mermaid');
  await expect(mermaidBlocks).toHaveCount(2);
  const mermaidImages=page.locator('.mermaid img.svg-diagram');
  await expect(mermaidImages).toHaveCount(2,{timeout:20_000});

  for(let idx=0;idx<2;idx++){
    const block=mermaidBlocks.nth(idx);
    const img=mermaidImages.nth(idx);
    await block.scrollIntoViewIfNeeded();
    await expect(img).toBeVisible();
    await expect.poll(()=>img.evaluate(el=>(el as HTMLImageElement).complete&&(el as HTMLImageElement).naturalWidth>800)).toBe(true);

    const info=await block.evaluate((container,expectedIdx)=>{
      const image=container.querySelector('img.svg-diagram') as HTMLImageElement;
      const decoded=decodeURIComponent(image.src.split(',').slice(1).join(','));
      const mdWidth=document.querySelector('.markdown-body')!.getBoundingClientRect().width;
      return {
        engine:expectedIdx===0?'pele':'mermaid',
        hasEngineAttr:decoded.includes(`data-diagram-engine="${expectedIdx===0?'pele':'mermaid'}"`),
        inlineSvgCount:container.querySelectorAll('svg').length,
        draggable:image.getAttribute('draggable'),
        sized:image.getAttribute('data-svg-sized'),
        imgWidth:image.getBoundingClientRect().width,
        imgHeight:image.getBoundingClientRect().height,
        clientWidth:container.clientWidth,
        scrollWidth:container.scrollWidth,
        mdWidth,
      };
    },idx);

    expect(info.hasEngineAttr).toBe(true);
    expect(info.inlineSvgCount).toBe(0);
    expect(info.draggable).toBe('false');
    expect(info.sized).toBe('true');
    expect(info.clientWidth).toBeLessThanOrEqual(info.mdWidth+1);
    expect(info.imgWidth).toBeGreaterThan(750);
    expect(info.imgHeight).toBeGreaterThan(220);
    expect(info.scrollWidth).toBeGreaterThan(info.clientWidth+400);

    // Pan horizontally via window.supermdNativeWheel over the inert <img>.
    const box=(await block.boundingBox())!;
    const point={x:Math.round(box.x+box.width/2),y:Math.round(box.y+Math.min(120,box.height/2))};
    await page.evaluate(pt=>window.supermdNativeWheel?.(260,0,pt,false),point);
    await expect.poll(()=>block.evaluate(el=>Math.round(el.scrollLeft))).toBeGreaterThanOrEqual(250);
    expect(await page.locator('.android-reading').evaluate(el=>el.scrollLeft)).toBe(0);

    // Pan to right boundary and verify vertical delta chains to .android-reading without horizontal bleed.
    const prevTop=await page.locator('.android-reading').evaluate(el=>el.scrollTop);
    await page.evaluate(pt=>window.supermdNativeWheel?.(1400,120,pt,false),point);
    await expect.poll(()=>block.evaluate(el=>el.scrollWidth-el.clientWidth-el.scrollLeft)).toBeLessThan(2);
    await expect.poll(()=>page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBeGreaterThan(prevTop+90);
    expect(await page.locator('.android-reading').evaluate(el=>el.scrollLeft)).toBe(0);
  }

  // Export checks: SVG + full-resolution PNG via media menu, plus agent diagram export.
  const firstImg=mermaidImages.first();
  await firstImg.scrollIntoViewIfNeeded();
  await firstImg.click({button:'right'});
  const menu=page.getByRole('menu',{name:'Save image or diagram'});
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem',{name:'Save as PNG'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).savedMedia.length)).toBe(1);
  await page.keyboard.press('Escape');

  await firstImg.click({button:'right'});
  await menu.getByRole('menuitem',{name:'Save as SVG',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).savedMedia.length)).toBe(2);
  await page.keyboard.press('Escape');

  const exportCheck=await page.evaluate(async()=>{
    const pngPayload=(window as any).savedMedia[0];
    const svgPayload=(window as any).savedMedia[1];
    const header=Uint8Array.from(atob(pngPayload.body.slice(0,44)),c=>c.charCodeAt(0));
    const view=new DataView(header.buffer);
    const pngWidth=view.getUint32(16),pngHeight=view.getUint32(20);
    const svgText=atob(svgPayload.body);
    const agentCall=(req:Record<string,unknown>)=>new Promise<any>((resolve,reject)=>window.supermdAgentRequest?.(req,(res,err)=>err?reject(Error(err)):resolve(res)));
    const list=await agentCall({action:'list_diagrams'});
    const shot=await agentCall({action:'get_diagram_image',diagramId:list.diagrams[0].id,expectedRevision:list.revision,width:1200});
    return {pngMime:pngPayload.mimeType,pngWidth,pngHeight,svgHasDispatcher:svgText.includes('Webhook Dispatcher'),diagramCount:list.total,agentMime:shot.mime_type};
  });
  expect(exportCheck.pngMime).toBe('image/png');
  expect(exportCheck.pngWidth).toBeGreaterThan(1000);
  expect(exportCheck.pngHeight).toBeGreaterThan(350);
  expect(exportCheck.svgHasDispatcher).toBe(true);
  expect(exportCheck.diagramCount).toBe(2);
  expect(exportCheck.agentMime).toBe('image/png');
});

test('diagram widths follow portrait/landscape changes without replacing the source or overflowing their column',async({page})=>{
  await page.setViewportSize({width:412,height:915});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(vector=>window.supermdLoad?.({id:'rotate-diagram',content:'```svg\n'+vector+'\n```',path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false}),vector);
  const image=page.locator('.svg-diagram');await expect(image).toBeVisible();
  const source=await image.getAttribute('src');
  // In 412px portrait, column (~336px) is narrower than 402px intrinsic box -> fills column.
  await expect.poll(()=>image.evaluate(node=>Math.abs(node.getBoundingClientRect().width-node.parentElement!.getBoundingClientRect().width))).toBeLessThan(2);
  // Rotate to 915px landscape -> column (~720px) is wider than 402px intrinsic box -> caps at intrinsic box and stays centered inside column.
  await page.setViewportSize({width:915,height:412});
  await expect.poll(()=>image.evaluate(node=>{
    const w=node.getBoundingClientRect().width,pw=node.parentElement!.getBoundingClientRect().width;
    return Math.abs(w-402)<3&&w<pw-100;
  })).toBe(true);
  await expect(image).toHaveAttribute('src',source!);
  // Rotate back to 412px portrait -> clamps back to column width without replacing src.
  await page.setViewportSize({width:412,height:915});
  await expect.poll(()=>image.evaluate(node=>Math.abs(node.getBoundingClientRect().width-node.parentElement!.getBoundingClientRect().width))).toBeLessThan(2);
  await expect(image).toHaveAttribute('src',source!);
});
