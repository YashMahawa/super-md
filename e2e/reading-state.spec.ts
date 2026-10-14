import {test,expect} from '@playwright/test';

test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
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
  await expect.poll(()=>image.evaluate(el=>getComputedStyle(el).filter)).toBe('contrast(1.5)');
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'auto'}),state);
  await expect.poll(()=>image.getAttribute('src')).toContain(encodeURIComponent('#aaccff'));
  await expect(page.locator('.svg-figure')).toHaveAttribute('data-auto-ink','true');
});
