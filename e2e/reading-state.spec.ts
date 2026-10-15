import {test,expect} from '@playwright/test';
// The screenshot decoder shipped with the pinned Playwright runtime avoids a
// second imaging dependency. Assert actual filtered pixels, not only CSS text.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const artworkFixtures:Record<string,string>=JSON.parse(readFileSync(new URL('../test-fixtures/theme-artwork.json',import.meta.url),'utf8'));
const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');

test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
});

test('custom theme patterns and typography reset cleanly without replacing math nodes',async({page})=>{
  const state={id:'custom-theme',path:null,content:'# A themed note\n\nAn equation $x^2+1$ and a [link](https://example.com).\n\n> [!TIP] A callout\n> Still readable.',mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#e4d4c9','surface-low':'#d9c4b4',text:'#30221b',primary:'#774a30'},font:'Manrope',size:17,zoom:140};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await expect(page.locator('.katex')).toBeVisible();
  await page.evaluate(()=>{(window as any).__themeMath=document.querySelector('.katex');});
  const customStyle={colors:{heading:'#542e48',link:'#63314c'},metrics:{headingWeight:800,contentRadius:10},background:{pattern:'dots',color:'#774a30',opacity:.06,spacing:24}};
  await page.evaluate(({state,customStyle})=>window.supermdLoad?.({...state,customStyle}),{state,customStyle});
  await expect.poll(()=>page.locator('.android-reading').evaluate(el=>getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.4');
  expect(await page.locator('h1').evaluate(el=>getComputedStyle(el).fontWeight)).toBe('800');
  expect(await page.evaluate(()=>(window as any).__themeMath.isConnected)).toBe(true);
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await expect(page.locator('html')).toHaveAttribute('data-custom-theme','false');
  await expect.poll(()=>page.locator('.android-reading').evaluate(el=>getComputedStyle(el).backgroundImage)).toBe('none');
  expect(await page.evaluate(()=>(window as any).__themeMath.isConnected)).toBe(true);
});

test('reading position survives a renderer restart and can be disabled',async({page})=>{
  const content=Array.from({length:90},(_,i)=>`## Chapter ${i}\n\n${'A readable paragraph about balanced search trees. '.repeat(12)}\n\n`).join('');
  const state={id:'first-open',path:'/notes/saved note.md',content,mode:'reader' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:100,restorePosition:true};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await page.evaluate(()=>window.supermdHeading?.('chapter-45'));
  const root=page.locator('.android-reading');await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(3000);
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('supermd.reading-locations.v1'))).not.toBeNull();
  const top=await root.evaluate(el=>el.scrollTop);
  await page.reload();await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(state=>window.supermdLoad?.({...state,id:'reopened'}),state);
  await expect.poll(async()=>Math.abs(await root.evaluate(el=>el.scrollTop)-top)).toBeLessThan(5);
  await page.reload();await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(state=>window.supermdLoad?.({...state,id:'disabled',restorePosition:false}),state);
  await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBe(0);
});

test('paw backgrounds paint adjustable tiles without intercepting reading or replacing math',async({page})=>{
  const state={id:'paws',path:null,content:'# Quiet study\n\nA [working jump](#destination) and $x^2+1$.\n\n## Destination\n\nStill ordinary text.',mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#f0e1d0',text:'#39291f',primary:'#80502d'},font:'Manrope',size:17,zoom:125,customStyle:{background:{pattern:'paws',color:'#865d3e',opacity:.2,spacing:96,size:30,angle:342}}};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await expect(page.locator('.katex')).toBeVisible();
  await page.evaluate(()=>{(window as any).__pawMath=document.querySelector('.katex');});
  const root=page.locator('.android-reading');
  await expect.poll(()=>root.evaluate(el=>getComputedStyle(el).backgroundImage)).toContain('data:image/svg+xml');
  const painted=await root.screenshot();
  await page.evaluate(state=>window.supermdLoad?.({...state,customStyle:{background:{...state.customStyle.background,opacity:0,spacing:144,size:40}}}),state);
  await expect.poll(()=>root.evaluate(el=>getComputedStyle(el).backgroundSize)).toBe('144px 144px');
  const hidden=await root.screenshot();
  const a=PNG.sync.read(painted),b=PNG.sync.read(hidden);let changed=0;
  for(let i=0;i<a.data.length;i+=4)if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>10)changed++;
  expect(changed).toBeGreaterThan(500);
  expect(await page.evaluate(()=>(window as any).__pawMath.isConnected)).toBe(true);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.25');
  await page.getByRole('link',{name:'working jump'}).click();
  expect(await page.locator('h2').textContent()).toBe('Destination');
});

test('palette-only changes retain rendered math nodes and do not rewind active scrolling',async({page})=>{
  const content=Array.from({length:240},(_,i)=>`## Part ${i}\n\n${'A paragraph with $x^2+1$ and **stable layout**. '.repeat(12)}\n\n`).join('');
  const state={id:'large-theme',path:null,content,mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#ead8cb',text:'#251c18',primary:'#8c4c30'},font:'Manrope',size:15,zoom:150,motion:false};
  await page.evaluate(state=>{document.documentElement.dataset.host='qt';window.supermdLoad?.(state);},state);
  const root=page.locator('.android-reading');await page.evaluate(()=>window.supermdHeading?.('part-80'));
  await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(10000);
  await expect.poll(()=>root.evaluate(el=>Array.from(el.querySelectorAll('.katex')).filter(node=>{const r=node.getBoundingClientRect();return r.top>100&&r.bottom<600;}).length)).toBeGreaterThan(0);
  const samples=await page.evaluate(async state=>{
    const root=document.querySelector<HTMLElement>('.android-reading')!;const values:number[]=[];
    const {content:_,...rest}=state;
    const math=Array.from(root.querySelectorAll('.katex')).find(node=>{const r=node.getBoundingClientRect();return r.top>100&&r.bottom<600;})!;
    window.supermdLoad?.({...rest,contentUnchanged:true,dark:true} as any);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    const retained=math.isConnected;
    for(let i=0;i<12;i++){
      window.supermdLoad?.({...rest,contentUnchanged:true,dark:i%2===0,colors:{surface:i%2===0?'#151118':'#ead8cb',text:i%2===0?'#eee0ee':'#251c18',primary:'#8c4c30'}} as any);
      window.supermdNativeWheel?.(0,55,{x:400,y:300},false);
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      values.push(root.scrollTop);
    }
    return {values,retained};
  },state);
  expect(samples.retained).toBe(true);
  for(let i=1;i<samples.values.length;i++)expect(samples.values[i]).toBeGreaterThanOrEqual(samples.values[i-1]-2);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.5');
});

test('image adjustments default to off and change viewing only',async({page})=>{
  const state={id:'appearance',path:null,content:'```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M10 10L100 60" stroke="black"/></svg>\n```',mode:'reader' as const,dark:true,fullscreen:false,colors:{text:'#eee0ee',primary:'#aaccff'},font:'Manrope',size:15,zoom:100};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  const image=page.locator('.svg-diagram');await expect(image).toBeVisible();
  expect(await image.evaluate(el=>getComputedStyle(el).filter)).toBe('none');
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'contrast',imageContrast:1.5}),state);
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toBe('none');
  // Chromium rounds device-pixel outline widths, while retaining the setting.
  await expect.poll(()=>page.locator('html').evaluate(el=>(el as HTMLElement).style.getPropertyValue('--media-separation'))).toBe('1.5px');
  expect(Number.parseFloat(await image.evaluate(el=>getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(1);
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'auto'}),state);
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toBe('none');
  expect(decodeURIComponent(await image.getAttribute('src')??'')).not.toContain('stroke="black"');
});

test('an open image follows theme adjustments without losing its zoom',async({page})=>{
  const state={id:'viewer-theme',path:null,content:'```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><path d="M10 10L100 60" stroke="black"/></svg>\n```',mode:'reader' as const,dark:true,fullscreen:false,colors:{text:'#eee0ee',primary:'#aaccff'},font:'Manrope',size:15,zoom:100,svgAppearance:'invert-dark' as const};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await page.locator('.svg-diagram').click();
  const image=page.locator('.image-viewer-canvas img');await expect(image).toBeVisible();
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toContain('invert(1)');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('supermd-image-zoom',{detail:{factor:1.4}})));
  await expect(page.getByLabel('Image zoom')).toHaveText('140%');
  await page.evaluate(state=>window.supermdLoad?.({...state,dark:false}),state);
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toBe('none');
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'auto',colors:{text:'#eee0ee',primary:'#df9dca'}}),state);
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toBe('none');
  await expect(page.getByLabel('Image zoom')).toHaveText('140%');
});

test('auto recolours raster photos and SVGs using actual accent pixels while contrast preserves source pixels',async({page})=>{
  const raster=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=160;c.height=80;const x=c.getContext('2d')!;x.fillStyle='#000000';x.fillRect(0,0,80,80);x.fillStyle='#ffffff';x.fillRect(80,0,80,80);return c.toDataURL();});
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="80" height="80" fill="#000000"/><rect x="80" width="80" height="80" fill="#ffffff"/></svg>';
  const state={id:'actual-media-pixels',path:null,content:`![Raster](${raster})\n\n\`\`\`svg\n${svg}\n\`\`\``,mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#ead8cb',text:'#251c18',primary:'#713453'},font:'Manrope',size:15,zoom:100,imageAppearance:'auto',svgAppearance:'auto'};
  await page.evaluate(state=>window.supermdLoad?.(state as any),state);
  const images=page.locator('.markdown-body img');await expect(images).toHaveCount(2);
  const pixel=async(index:number)=>{
    const image=images.nth(index);await expect(image).toBeVisible();
    const png=PNG.sync.read(await image.screenshot());const i=((png.height>>1)*png.width+(png.width>>2))*4;
    return Array.from(png.data.subarray(i,i+3));
  };
  for(const i of [0,1])expect(await pixel(i)).toEqual([113,52,83]);
  await page.evaluate(state=>window.supermdLoad?.({...state,dark:true,colors:{surface:'#17131b',text:'#eee0ee',primary:'#aaccff'}} as any),state);
  for(const i of [0,1])await expect.poll(()=>pixel(i)).toEqual([170,204,255]);
  await page.evaluate(state=>window.supermdLoad?.({...state,imageAppearance:'contrast',svgAppearance:'contrast'} as any),state);
  for(const i of [0,1])expect(await pixel(i)).toEqual([0,0,0]);
  expect(await images.first().getAttribute('src')).toBe(raster);
});

test('centre lock centres normal and fullscreen zoom and keeps vertical pan independent',async({page})=>{
  const state={id:'centre',path:null,content:'# Centre\n\n'+('A long paragraph with selectable text. '.repeat(600)),mode:'reader' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:200,centerLock:true};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  const root=page.locator('.android-reading');
  const center=()=>root.evaluate(el=>{const a=el.getBoundingClientRect(),b=el.querySelector('.document-page')!.getBoundingClientRect();return Math.abs((a.left+a.right-b.left-b.right)/2);});
  await expect.poll(center).toBeLessThan(2);
  await page.evaluate(()=>window.supermdNativeWheel?.(160,190,{x:400,y:300},false));
  await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);await expect.poll(center).toBeLessThan(2);
  await page.evaluate(state=>window.supermdLoad?.({...state,fullscreen:true,zoom:250}),state);await expect.poll(center).toBeLessThan(2);
  await page.evaluate(state=>window.supermdLoad?.({...state,fullscreen:true,zoom:250,centerLock:false}),state);
  const left=await root.evaluate(el=>el.scrollLeft);await page.evaluate(()=>window.supermdNativeWheel?.(120,0,{x:400,y:300},false));
  await expect.poll(()=>root.evaluate(el=>el.scrollLeft)).toBeGreaterThan(left+50);
});

test('Auto preserves coloured raster pixels while monochrome remains a separate full recolour',async({page})=>{
  const raster=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=160;c.height=80;const x=c.getContext('2d')!;['#000000','#ffffff','#f03c50','#3060db'].forEach((color,i)=>{x.fillStyle=color;x.fillRect(i*40,0,40,80);});return c.toDataURL();});
  const state={id:'colour-preservation',path:null,content:`![Colour chart](${raster})`,mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#ead8cb',text:'#251c18',primary:'#713453'},font:'Manrope',size:15,zoom:100,imageAppearance:'auto' as const};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  const image=page.getByRole('img',{name:'Colour chart'});await expect(image).toBeVisible();
  const pixels=async()=>{const png=PNG.sync.read(await image.screenshot());return [0,1,2,3].map(n=>{const i=((png.height>>1)*png.width+Math.floor(png.width*(n+.5)/4))*4;return Array.from(png.data.subarray(i,i+3));});};
  // Filter transfer tables can round a channel down by one byte. Coloured
  // pixels must remain exact; only transformed neutral endpoints allow this.
  await expect.poll(async()=>{const seen=await pixels();return Math.max(...seen.slice(0,2).flatMap((p,i)=>p.map((v,j)=>Math.abs(v-[[113,52,83],[234,216,203]][i][j]))));}).toBeLessThanOrEqual(1);
  expect((await pixels()).slice(2)).toEqual([[240,60,80],[48,96,219]]);
  await page.evaluate(state=>window.supermdLoad?.({...state,imageAppearance:'monochrome'}),state);
  await expect.poll(async()=>(await pixels())[2]).not.toEqual([240,60,80]);
});

test('embedded scene artwork paints once, fades out, and leaves document nodes and zoom intact',async({page})=>{
  const art='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#bd4354"/><circle cx="250" cy="100" r="70" fill="#1d4ed8"/></svg>');
  const state={id:'scene',path:null,content:'# A composed scene\n\nStill selectable: $x^2$.',mode:'reader' as const,dark:false,fullscreen:false,colors:{surface:'#eddcda',text:'#38272c',primary:'#8c384d'},font:'Manrope',size:17,zoom:130,customStyle:{artwork:{reader:{image:art,opacity:.2,fit:'cover'}}}};
  await page.evaluate(state=>window.supermdLoad?.(state),state);await expect(page.locator('.katex')).toBeVisible();
  await page.evaluate(()=>{(window as any).__sceneMath=document.querySelector('.katex');});
  const root=page.locator('.android-reading'),before=PNG.sync.read(await root.screenshot());
  await page.evaluate(state=>window.supermdLoad?.({...state,customStyle:{artwork:{reader:{...state.customStyle.artwork.reader,opacity:0}}}}),state);
  const after=PNG.sync.read(await root.screenshot());const sample=(png:any)=>Array.from(png.data.subarray((png.width*(png.height-20)+20)*4,(png.width*(png.height-20)+20)*4+3));
  expect(sample(before)).not.toEqual(sample(after));expect(sample(after)).toEqual([237,220,218]);
  expect(await page.evaluate(()=>(window as any).__sceneMath.isConnected)).toBe(true);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.3');
});

test('PNG, JPEG and WebP wallpaper paint actual reader pixels and do not replace math',async({page})=>{
  const state={id:'raster-wallpaper',path:null,content:'# Offline art\n\nA stable equation $x^2+1$.',mode:'reader' as const,dark:true,fullscreen:false,colors:{surface:'#000000',text:'#ffffff',primary:'#aaccff'},font:'Manrope',size:15,zoom:100};
  await page.evaluate(state=>window.supermdLoad?.(state),state);await expect(page.locator('.katex')).toBeVisible();
  await page.evaluate(()=>{(window as any).__rasterArtMath=document.querySelector('.katex');});
  for(const [kind,image] of Object.entries(artworkFixtures)){
    await page.evaluate(({state,image})=>window.supermdLoad?.({...state,customStyle:{artwork:{reader:{image,opacity:.2,fit:'cover',position:'right'}}}}),{state,image});
    const png=PNG.sync.read(await page.locator('.android-reading').screenshot());
    const i=((png.height-20)*png.width+20)*4;
    expect(png.data[i],kind).toBeGreaterThanOrEqual(49);expect(png.data[i],kind).toBeLessThanOrEqual(52);
    expect(png.data[i+1],kind).toBeLessThanOrEqual(1);expect(png.data[i+2],kind).toBeLessThanOrEqual(1);
    expect(await page.evaluate(()=>(window as any).__rasterArtMath.isConnected)).toBe(true);
  }
});
