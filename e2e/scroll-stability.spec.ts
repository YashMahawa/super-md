import {test,expect} from '@playwright/test';

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
