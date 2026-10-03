import {test,expect} from '@playwright/test';
test('desktop fullscreen chrome follows reading gestures without stealing selection or double clicks',async({page})=>{
  await page.addInitScript(()=>{(window as any).chromeActions=[];window.SuperMD={post:(id,command,args)=>{if(command==='reader_chrome')(window as any).chromeActions.push(JSON.parse(args).action);window.supermdReply?.(id,true,null);}};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(()=>document.documentElement.dataset.host='qt');
  const content='# A desktop note\n\n'+('A readable paragraph with enough text to scroll. '.repeat(18)+'\n\n').repeat(25);
  const state={id:'desktop-chrome',content,path:null,mode:'reader' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100,widthPercent:80};
  await page.evaluate(state=>window.supermdLoad?.(state),state);await page.mouse.move(350,350);await page.mouse.wheel(0,120);
  expect(await page.evaluate(()=>(window as any).chromeActions)).toEqual([]);
  await page.evaluate(state=>{window.supermdLoad?.({...state,fullscreen:true});window.supermdChromeInset?.(56);},state);
  await page.mouse.wheel(0,120);await expect.poll(()=>page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide']);
  await page.evaluate(()=>window.supermdNativeWheel?.(0,-40,{x:350,y:350},false));await expect.poll(()=>page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide','show']);
  const paragraph=page.locator('.markdown-body p').nth(1);
  await paragraph.click();await expect.poll(()=>page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide','show','toggle']);
  await paragraph.dblclick();await page.waitForTimeout(400);
  expect(await page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide','show','toggle']);
  await paragraph.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  await page.waitForTimeout(350);expect(await page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide','show','toggle']);
  await page.evaluate(()=>{window.getSelection()?.removeAllRanges();window.supermdNativeWheel?.(0,30,{x:350,y:350},true);});
  expect(await page.evaluate(()=>(window as any).chromeActions)).toEqual(['hide','show','toggle']);
});
test('native overlay spacing protects the title and fullscreen never narrows the text column',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const content='# Visible title\n\n'+('A readable paragraph with some words. '.repeat(16)+'\n\n').repeat(35);
  for(const viewport of [{width:414,height:896},{width:896,height:414},{width:1200,height:900}]){
    await page.setViewportSize(viewport);
    for(const mode of ['reader','live'] as const){
      const state={id:`overlay-${mode}-${viewport.width}`,content,path:null,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:100,widthPercent:80};
      await page.evaluate(state=>window.supermdLoad?.(state),state);
      await page.evaluate(()=>document.fonts.ready);
      await page.evaluate(()=>{window.supermdSetZoom?.(100);window.supermdChromeInset?.(196);});
      await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1');
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      const root=page.locator('.android-reading'),title=page.getByRole('heading',{name:'Visible title'});
      await root.evaluate(el=>el.scrollTop=0);
      await expect.poll(()=>title.evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(196);
      const text=page.locator('.markdown-body').first(),width=await text.evaluate(el=>el.clientWidth);
      const height=await root.evaluate(el=>el.clientHeight);
      await page.evaluate(state=>window.supermdLoad?.({...state,fullscreen:true}),state);
      await page.waitForFunction(()=>document.documentElement.dataset.fullscreen==='true');
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      expect(await text.evaluate(el=>el.clientWidth)).toBe(width);
      expect(await root.evaluate(el=>el.clientHeight)).toBe(height);
      // The note's initial spacer is not magnified like its text, and changing
      // compact/expanded chrome retains the reading position away from the top.
      await page.evaluate(()=>window.supermdZoomBy?.(2,{x:200,y:300}));
      await expect(page.locator('.document-page')).toHaveAttribute('data-scale','2');
      await root.evaluate(el=>el.scrollTop=0);
      await expect.poll(()=>title.evaluate(el=>el.getBoundingClientRect().top)).toBeLessThan(270);
      await root.evaluate(el=>el.scrollTop=900);
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      const paragraph=page.locator('.markdown-body p').nth(3),before=(await paragraph.boundingBox())!.y;
      await page.evaluate(()=>window.supermdChromeInset?.(88));
      await expect.poll(async()=>Math.abs((await paragraph.boundingBox())!.y-before),{message:`${mode} ${viewport.width}: chrome resize must retain the paragraph anchor`}).toBeLessThan(2);
      await page.evaluate(()=>window.supermdChromeInset?.(196));
    }
  }
});
test('fullscreen entry keeps the presented zoom and wrapping even before its native acknowledgement',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>window.supermdReply?.(id,true,null)};});await page.goto('/android-reader.html');
  const content='# Same page\n\n'+('A readable long paragraph. '.repeat(20)+'\n\n').repeat(100);
  await page.evaluate(content=>window.supermdLoad?.({id:'fullscreen-width',content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:130,widthPercent:80}),content);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.3');
  const width=await page.locator('.document-page').evaluate(el=>getComputedStyle(el).width);
  await page.evaluate(content=>{
    window.supermdZoomBy?.(1.2,{x:400,y:300});
    window.supermdLoad?.({id:'fullscreen-width',content,path:null,mode:'reader',dark:false,fullscreen:true,colors:{},font:'Manrope',size:15,zoom:70,widthPercent:80});
  },content);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.56');
  expect(await page.locator('.document-page').evaluate(el=>getComputedStyle(el).width)).toBe(width);
});
test('heading links land at the distant heading, not a partially scrolled magnified page',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  const content='[Go to distant chapter](#chapter-599)\n\n'+Array.from({length:600},(_,i)=>`## Chapter ${i}\n\n${'Readable note with **formatting** and $E=mc^2$. '.repeat(8)}\n\n`).join('');
  for(const mode of ['reader','live'] as const) {
    await page.evaluate(({content,mode})=>window.supermdLoad?.({id:mode,content,path:null,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:200}),{content,mode});
    await page.getByRole('link',{name:'Go to distant chapter'}).click();
    await expect(page.getByRole('heading',{name:'Chapter 599',exact:true})).toBeVisible();
    await expect.poll(()=>page.locator('#chapter-599').evaluate(el=>Math.abs(el.getBoundingClientRect().top-document.querySelector('.android-reading')!.getBoundingClientRect().top-16))).toBeLessThan(3);
    await page.evaluate(()=>window.supermdHeading?.('chapter-2'));
    await expect(page.getByRole('heading',{name:'Chapter 2',exact:true})).toBeVisible();
  }
});
test('Android settled zoom hit testing selects the word at the displayed location',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  await page.evaluate(()=>{document.documentElement.dataset.platform='android';window.supermdLoad?.({id:'selection',content:'# Selection\n\nAlpha Bravo Charlie Delta\n\n'+('Another paragraph with equations $x^2$.\n\n').repeat(100),path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:175});});
  await expect(page.locator('.document-page')).toHaveAttribute('data-selection-scale','1.75');
  const hit=await page.locator('.markdown-body p').first().evaluate(el=>{
    const text=el.firstChild!;const range=document.createRange();range.setStart(text,6);range.setEnd(text,11);const r=range.getBoundingClientRect();
    const caret=document.caretRangeFromPoint(r.left+r.width*.5,r.top+r.height*.5);
    return {text:caret?.startContainer.textContent,offset:caret?.startOffset,width:r.width,top:r.top};
  });
  expect(hit.text).toBe('Alpha Bravo Charlie Delta');expect(hit.offset).toBeGreaterThanOrEqual(6);expect(hit.offset).toBeLessThanOrEqual(11);
});
test('native two-finger deltas pan the magnified page in both directions without changing scale',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  await page.evaluate(()=>window.supermdLoad?.({id:'pan',content:'# Pan\n\n'+('Wide readable paragraph. '.repeat(20)+'\n\n').repeat(100),path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:200}));
  const root=page.locator('.android-reading');await expect(page.locator('.document-page')).toHaveAttribute('data-scale','2');
  const before=await root.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop}));
  await page.evaluate(()=>window.supermdNativeWheel?.(120,300,{x:400,y:300},false));
  await expect.poll(()=>root.evaluate(el=>el.scrollTop)).toBeGreaterThan(before.top+200);
  await expect.poll(()=>root.evaluate(el=>el.scrollLeft)).toBeGreaterThan(before.left+50);
  await page.evaluate(()=>window.supermdNativeWheel?.(-60,-100,{x:400,y:300},false));
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','2');
  expect(await root.evaluate(el=>el.scrollLeft)).toBeLessThan(before.left+120);
});
test('queued native snapshots cannot rewind an in-progress zoom, and both limits apply',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>window.supermdReply?.(id,true,null)};});await page.goto('/android-reader.html');
  await page.evaluate(()=>window.supermdLoad?.({id:'feedback',content:'# Feedback\n\n'+('A substantial readable paragraph. '.repeat(20)+'\n\n').repeat(100),path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:100}));
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1');
  await page.evaluate(async()=>{
    for(let i=0;i<12;i++){
      window.supermdZoomBy?.(1.06,{x:400,y:300});
      window.supermdLoad?.({id:'feedback',content:'# Feedback\n\n'+('A substantial readable paragraph. '.repeat(20)+'\n\n').repeat(100),path:null,mode:'reader',dark:false,fullscreen:false,colors:{primary:i%2?'#446699':'#336688'},font:'Manrope',size:15,zoom:100});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    }
  });
  await expect.poll(()=>page.locator('.document-page').evaluate(el=>Number((el as HTMLElement).dataset.scale))).toBeCloseTo(1.06**12,3);
  await page.evaluate(()=>window.supermdSetZoom?.(10));await expect(page.locator('.document-page')).toHaveAttribute('data-scale','0.4');
  await page.evaluate(()=>window.supermdSetZoom?.(400));await expect(page.locator('.document-page')).toHaveAttribute('data-scale','3');
});
test('live code editing scrolls inside its bounded box without zooming the document',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>window.supermdReply?.(id,true,null)};});await page.goto('/android-reader.html');
  await page.evaluate(()=>window.supermdLoad?.({id:'live-scroll',content:'# Long editable example\n\n```python\n'+Array.from({length:300},(_,i)=>`print(${i})`).join('\n')+'\n```\n',path:null,mode:'live',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:100}));
  await page.getByRole('group',{name:'Editable block 2'}).focus();await page.keyboard.press('Enter');
  const input=page.getByRole('textbox',{name:'Edit Markdown block'});await expect(input).toBeVisible();
  const box=await input.boundingBox();expect(box).not.toBeNull();expect(box!.height).toBeLessThan(500);
  await page.evaluate(({x,y})=>window.supermdNativeWheel?.(0,300,{x,y},true),{x:box!.x+40,y:box!.y+40});
  await expect.poll(()=>input.evaluate(el=>el.scrollTop)).toBeGreaterThan(200);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1');
});
test('settled selection scale stays stable while scrolling lazy content',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>window.supermdReply?.(id,true,null)};});await page.goto('/android-reader.html');
  await page.evaluate(()=>{document.documentElement.dataset.platform='android';window.supermdLoad?.({id:'scroll-stability',content:Array.from({length:600},(_,i)=>`## Heading ${i}\n\n${'Readable **paragraph** with $x^2$. '.repeat(12)}\n\n`).join(''),path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:15,zoom:175});});
  await expect(page.locator('.document-page')).toHaveAttribute('data-selection-scale','1.75');
  const samples=await page.evaluate(async()=>{
    const root=document.querySelector<HTMLElement>('.android-reading')!,page=document.querySelector<HTMLElement>('.document-page')!;const samples:Array<{top:number;zoom:string}>=[];
    for(let i=0;i<24;i++){root.scrollBy(0,90);await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));samples.push({top:root.scrollTop,zoom:page.style.zoom});}
    return samples;
  });
  for(let i=1;i<samples.length;i++)expect(samples[i].top).toBeGreaterThanOrEqual(samples[i-1].top-1);
  expect(samples.every(sample=>sample.zoom==='1.75')).toBe(true);
});
