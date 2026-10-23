import {test,expect} from '@playwright/test';

const scrollContent=Array.from({length:450},(_,i)=>`## Section ${i}\n\n${'A source paragraph explains the difference between differentiating a signal and differentiating its spectrum. '.repeat(3)}\n\n$$x(t)e^{j\\omega_ct}\\leftrightarrow X(j(\\omega-\\omega_c)),\\quad \\frac{dX}{d\\omega}=\\int_{-\\infty}^{\\infty}(-jt)x(t)e^{-j\\omega t}dt.$$${i===171?'\n\n![Remounted figure](figure.svg)':''}`).join('\n\n');
const scrollImage='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#dae7f2"/><path d="M40 800L500 300L1100 80" stroke="#2673ba" stroke-width="8" fill="none"/></svg>').toString('base64');
async function mockScrollAssets(page:import('@playwright/test').Page){
  await page.addInitScript(image=>{window.SuperMD={post:(id,command)=>{
    if(command==='run_python')throw Error('A scroll test must not execute code');
    if(command==='load_asset'){const fail=(window as any).failFixtureImage;window.setTimeout(()=>window.supermdReply?.(id,fail?null:image,fail?'Fixture image unavailable':null),100);}
    else queueMicrotask(()=>window.supermdReply?.(id,null,null));
  }};},scrollImage);
}
const scrollCases=['desktop','android'].flatMap(platform=>[40,100,104,180,300].map(zoom=>({platform,zoom,cold:false})));
scrollCases.push(...['desktop','android'].map(platform=>({platform,zoom:180,cold:true})));
for(const {platform,zoom,cold} of scrollCases){
  test(`fast upward windowed scrolling preserves visible text on ${platform} at ${zoom}%${cold?' with a cold image':''}`,async({page})=>{
    await page.setViewportSize(platform==='desktop'?{width:1280,height:800}:{width:412,height:850});
    await mockScrollAssets(page);
    await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
    await page.evaluate(({content,platform,zoom})=>{
      document.documentElement.dataset.platform=platform;document.documentElement.dataset.host=platform==='desktop'?'qt':'android';
      window.supermdLoad?.({id:'fast-windowed-scroll',content,path:'/fixture/scroll.md',mode:'reader',dark:true,colors:{},font:'Manrope',size:16,zoom,restorePosition:false});
    },{content:scrollContent,platform,zoom});
    await expect(page.locator('[data-windowed-block]').first()).toBeAttached();
    await page.evaluate(()=>document.fonts.ready);
    // This is a repeated-windowing test: establish the figure's real size
    // once before cycling past it. A first-ever intrinsic-size discovery
    // within the viewport legitimately reflows content on either side; the
    // separate delayed-image test checks first loading ABOVE the viewport.
    if(!cold){
      await page.evaluate(()=>window.supermdHeading?.('section-171'));
      await expect.poll(()=>page.locator('.note-image img').evaluateAll(images=>images.some(image=>(image as HTMLImageElement).complete&&image.getBoundingClientRect().height>100))).toBe(true);
    }
    await page.evaluate(()=>window.supermdHeading?.('section-174'));
    await expect(page.locator('.android-reading')).not.toHaveAttribute('data-navigating','true');
    const result=await page.evaluate(async()=>{
      const root=document.querySelector<HTMLElement>('.android-reading')!,drifts:number[]=[];
      for(let cycle=0;cycle<4;cycle++)for(let step=0;step<28;step++){
        const delta=step<14?-520:520,bounds=root.getBoundingClientRect(),point={x:bounds.left+bounds.width*.5,y:bounds.top+bounds.height*.5};
        // Track text expected to remain visible AFTER this input, not an old
        // source line that legitimately leaves the viewport during a burst.
        const caret=(document as Document&{caretRangeFromPoint?:(x:number,y:number)=>Range|null}).caretRangeFromPoint?.(point.x,delta<0?bounds.top+100:bounds.bottom-100);
        const range=caret&&root.contains(caret.startContainer)?caret.cloneRange():null;
        if(range?.startContainer.nodeType===Node.TEXT_NODE&&range.startOffset<(range.startContainer.textContent?.length??0))range.setEnd(range.startContainer,range.startOffset+1);
        const sourceNode=range?.startContainer,sourceOffset=range?.startOffset;
        const before=range?.getBoundingClientRect();
        window.supermdNativeWheel?.(0,delta,point,false);
        await new Promise(requestAnimationFrame);
        // A removed text node retargets its live Range to a parent. Measuring
        // that parent's rectangle is not measuring the original source line.
        if(before?.height&&sourceNode?.nodeType===Node.TEXT_NODE&&sourceNode.isConnected&&range?.startContainer===sourceNode&&range.startOffset===sourceOffset){const after=range.getBoundingClientRect();if(after.height)drifts.push(after.top-before.top+delta);}
      }
      return {drifts,mounted:root.querySelectorAll('[data-windowed-mounted="true"]').length,total:root.querySelectorAll('[data-windowed-block]').length};
    });
    await test.info().attach('fast-scroll-source-drift',{body:JSON.stringify(result,null,2),contentType:'application/json'});
    expect(result.drifts.length).toBeGreaterThan(50);
    expect(Math.max(...result.drifts.map(Math.abs))).toBeLessThan(3);
    // Fixing the anchor must not disable offscreen unmounting to hide the bug.
    expect(result.mounted).toBeLessThan(result.total/3);
  });
}

test('a failed remounted image releases its reserved footprint without leaving a stale gap',async({page})=>{
  await mockScrollAssets(page);await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(content=>window.supermdLoad?.({id:'image-failure-scroll',content,path:'/fixture/scroll.md',mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:104,restorePosition:false}),scrollContent);
  await page.evaluate(()=>window.supermdHeading?.('section-174'));
  await expect.poll(()=>page.locator('.note-image img').evaluateAll(images=>images.some(image=>(image as HTMLImageElement).complete&&image.getBoundingClientRect().height>100))).toBe(true);
  await page.evaluate(()=>window.supermdHeading?.('section-350'));await expect(page.locator('.note-image')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).failFixtureImage=true;window.supermdHeading?.('section-174');});
  await expect(page.locator('.image-error')).toContainText('Fixture image unavailable');
  await expect.poll(()=>page.locator('.image-error').evaluate(node=>(node.closest<HTMLElement>('[data-windowed-block]')!).style.minHeight)).toBe('');
});

test('delayed image sizing does not move the visible source anchor during scrolling',async({page})=>{
  await page.exposeFunction('nativeFetch',async(id:string,command:string)=>{
    if(command==='fetch_resource'){
      await page.evaluate(()=>{(window as any).imageFetchPending=true;});
      await new Promise(resolve=>setTimeout(resolve,1200));
      const body=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1200;const paint=canvas.getContext('2d')!;paint.fillStyle='#d8e7f4';paint.fillRect(0,0,1800,1200);return canvas.toDataURL();});
      await page.evaluate(({id,body})=>window.supermdReply?.(id,{body},null),{id,body});
    }else await page.evaluate(id=>window.supermdReply?.(id,true,null),id);
  });
  await page.addInitScript(()=>{window.SuperMD={post:(id,command)=>(window as any).nativeFetch(id,command)};});
  const content=[
    '# Scroll fixture',
    `## Before the figure\n\n${'Readable lead-in text makes the following source anchor visible at high zoom. '.repeat(12)}`,
    `![Delayed figure](https://slow-scroll.test/slow-scroll-image-${Date.now()}.png)`,
    '## Visible anchor\n\nThis heading is the source location being tracked.',
    ...Array.from({length:8},(_,i)=>`## Lead ${i}\n\n${'Readable source before the delayed figure. '.repeat(14)}`),
    ...Array.from({length:300},(_,i)=>`## Later ${i}\n\n${'Readable source after the delayed figure. '.repeat(14)}`),
  ].join('\n\n');
  const results=[] as Array<{platform:string;zoom:number;before:number;after:number;delta:number;drift:number;loaded:boolean;inViewportAfter:boolean}>;
  for(const {platform,zoom} of [{platform:'qt',zoom:100},{platform:'qt',zoom:180},{platform:'android',zoom:100},{platform:'android',zoom:180}]){
    await page.goto('/android-reader.html');
    await page.waitForFunction(()=>!!window.supermdLoad);
    const run=`${platform}-${zoom}`;
    const runContent=content.replace(/slow-scroll-image-[^/]+\.png/,`slow-scroll-image-${run}.png`);
    await page.evaluate(({platform,zoom,content})=>{
      (window as any).imageFetchPending=false;
      document.documentElement.dataset.host=platform==='qt'?'qt':'android';
      document.documentElement.dataset.platform=platform==='android'?'android':'desktop';
      window.supermdLoad?.({id:`scroll-${platform}-${zoom}`,content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom,restorePosition:false});
    },{platform,zoom,content:runContent});
    await page.evaluate(zoom=>window.supermdSetZoom?.(zoom),zoom);
    await expect(page.locator('.document-page')).toHaveAttribute('data-scale',String(zoom/100));
    const anchor=page.locator('#visible-anchor');
    // The reader requires an explicit trust action for a new remote image host.
    await page.getByRole('button',{name:'Load image'}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).imageFetchPending===true)).toBe(true);
    // Establish a visible source anchor while the image response is still held.
    await anchor.scrollIntoViewIfNeeded();
    await anchor.evaluate(el=>{const root=el.closest<HTMLElement>('.android-reading')!;root.scrollTop+=el.getBoundingClientRect().top-root.getBoundingClientRect().top-220;});
    await expect(anchor).toBeInViewport();
    const before=await anchor.evaluate(el=>el.getBoundingClientRect().top);
    // Leave the image just above the viewport while its response is pending.
    await page.locator('.android-reading').evaluate(root=>root.scrollBy({top:180,behavior:'instant'}));
    const image=page.locator('.android-reading img').first();
    await expect.poll(()=>image.evaluate(el=>(el as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
    const after=await anchor.evaluate(el=>el.getBoundingClientRect().top);
    const loaded=await image.evaluate(el=>(el as HTMLImageElement).complete);
    const delta=after-before;
    const inViewportAfter=await anchor.evaluate(el=>{const r=el.getBoundingClientRect(),root=el.closest('.android-reading')!.getBoundingClientRect();return r.bottom>root.top&&r.top<root.bottom;});
    results.push({platform,zoom,before,after,delta,drift:delta+180,loaded,inViewportAfter});
  }
  console.log('scroll-anchor-drift',JSON.stringify(results));
  await test.info().attach('scroll-anchor-drift',{body:JSON.stringify(results,null,2),contentType:'application/json'});
  for(const result of results){
    expect.soft(Math.abs(result.drift),`${result.platform} at ${result.zoom}% drifted ${result.drift}px`).toBeLessThan(3);
  }
});
