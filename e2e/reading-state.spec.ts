import {test,expect} from '@playwright/test';
// The screenshot decoder shipped with the pinned Playwright runtime avoids a
// second imaging dependency. Assert actual filtered pixels, not only CSS text.
import {createRequire} from 'node:module';
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
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toContain('#supermd-media-tone');
  expect(await image.getAttribute('src')).toContain('stroke%3D%22black%22');
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
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toContain('#supermd-media-tone');
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
