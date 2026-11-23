import {test,expect} from '@playwright/test';

test('reverse text selection at a glyph end stays native beside inline math',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'glyph-boundary',path:null,content:'and $X$ and $S^2$ are independent. That independence matters.',mode:'reader',dark:false,colors:{},font:'Manrope',size:32,widthPercent:85,zoom:95.59963715447921,restorePosition:false});});
  await page.evaluate(()=>document.fonts.ready);
  const point=await page.locator('.markdown-body p').evaluate(el=>{
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node:Node|null;
    while(node=walker.nextNode()){const start=node.textContent?.indexOf('are independent')??-1;if(start<0)continue;const r=document.createRange();r.setStart(node,start);r.setEnd(node,start+15);const b=r.getBoundingClientRect();return{x:b.left+.8,end:b.right-.8,y:b.top+b.height/2};}
    throw Error('Missing text fixture');
  });
  await page.mouse.move(point.end,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y,{steps:12});await page.mouse.up();
  expect(await page.evaluate(()=>getSelection()?.toString())).toBe('are independent');
});

test('a drag starting in the gap above a paragraph selects the following text',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'gap-selection',path:null,content:'A previous paragraph must remain outside the selection.\n\nTarget reader passage continues on the next line.',mode:'reader',dark:false,colors:{},font:'Manrope',size:22,zoom:100,restorePosition:false});});
  await page.evaluate(()=>document.fonts.ready);
  const target=page.locator('.markdown-body p').last();await target.evaluate(el=>el.style.marginTop='70px');
  for(const xOffset of [1,-12,-32])for(const yOffset of [4,20,48]){
    const point=await target.evaluate((el,{xOffset,yOffset})=>{const r=document.createRange();r.setStart(el.firstChild!,0);r.setEnd(el.firstChild!,6);const b=r.getBoundingClientRect();return{x:b.left+xOffset,y:b.top-yOffset,endX:b.right-.5,endY:b.top+b.height*.5};},{xOffset,yOffset});
    await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.endY,{steps:12});await page.mouse.up();
    expect(await page.evaluate(()=>getSelection()?.toString()),JSON.stringify({xOffset,yOffset})).toBe('Target');
  }
});

for(const mode of ['reader','live','split'] as const)for(const [kind,body,selector]of [
  ['paragraph','Target reader passage continues below.','p'],
  ['heading','## Target heading below the margin','h2'],
  ['list','- Target reader passage\n- A later item','li'],
  ['table','| Heading |\n| --- |\n| Target reader passage |','td'],
])test(`empty-area selection starts in the intended ${kind}: ${mode}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000});
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(({mode,body})=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'general-gap',path:null,content:'Text above must remain unselected.\n\n'+body,mode,dark:false,colors:{},font:'Manrope',size:32,widthPercent:85,zoom:95.59963715447921,restorePosition:false});},{mode,body});
  await page.evaluate(()=>document.fonts.ready);
  const target=page.locator(`.android-reading .markdown-body ${selector}`).filter({hasText:'Target'}).first();
  await target.evaluate((el,kind)=>{if(kind==='table')el.style.paddingTop='70px';else el.style.marginTop='70px';},kind);
  const point=await target.evaluate(el=>{const text=document.createTreeWalker(el,NodeFilter.SHOW_TEXT).nextNode()!,r=document.createRange();r.setStart(text,0);r.setEnd(text,6);const b=r.getBoundingClientRect();return{x:b.left+1,y:b.top-24,endX:b.right-.5,endY:b.top+b.height*.5};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.endY,{steps:12});await page.mouse.up();
  expect(await page.evaluate(()=>getSelection()?.toString())).toBe('Target');
});

test('stationary hold-wheel zooms but moving a selection then wheeling only scrolls',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'hold-zoom',path:null,content:'Alpha Bravo Charlie Delta Echo Foxtrot.\n\n'+('A later paragraph should scroll without zooming.\n\n').repeat(200),mode:'reader',dark:false,colors:{},font:'Manrope',size:22,zoom:100,restorePosition:false});});
  await page.evaluate(()=>document.fonts.ready);
  const point=await page.locator('.markdown-body p').first().evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild!,0);r.setEnd(el.firstChild!,19);const b=r.getBoundingClientRect();return{x:b.left+1,y:b.top+b.height/2,endX:b.right-.5};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();
  await page.evaluate(point=>window.supermdNativeWheel?.(0,-120,point,true),point);await page.mouse.up();
  await expect.poll(()=>page.locator('.document-page').getAttribute('data-scale')).not.toBe('1');
  await page.evaluate(()=>window.supermdSetZoom?.(100));
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.y,{steps:10});
  await page.evaluate(point=>window.supermdNativeWheel?.(0,120,point,true),point);
  await expect.poll(()=>page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBeGreaterThan(10);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1');await page.mouse.up();
});

test('starting in the empty callout gutter does not select its title above the pointer',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'callout-selection',path:null,content:'# A note\n\n> [!example] Context above the body\n> Target reader passage remains below the empty gutter.',mode:'reader',dark:false,colors:{},font:'Manrope',size:32,widthPercent:85,zoom:95.59963715447921,restorePosition:false});});
  await page.evaluate(()=>document.fonts.ready);
  const target=page.locator('.callout > p:not(.callout-title)');
  const point=await target.evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild!,0);r.setEnd(el.firstChild!,6);const b=r.getBoundingClientRect();return{x:b.left+1,y:b.top-20,endX:b.right-.5,endY:b.top+b.height*.5};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.endY,{steps:12});await page.mouse.up();
  expect(await page.evaluate(()=>getSelection()?.toString())).toBe('Target');
});

test('a blank-start selection extends while wheel/edge scrolling and keeps its original zoom',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{document.documentElement.dataset.platform='desktop';window.supermdLoad?.({id:'gap-scroll',path:null,content:'> [!example] Context above the body\n> Target reader passage below the empty gutter.\n\n'+Array.from({length:280},(_,i)=>`## Later section ${i}\n\n${'Further source text remains selectable as the note scrolls. '.repeat(6)}\n`).join('\n'),mode:'reader',dark:false,colors:{},font:'Manrope',size:32,widthPercent:85,zoom:95.59963715447921,restorePosition:false});});
  await page.evaluate(()=>document.fonts.ready);
  const target=page.locator('.callout > p:not(.callout-title)');
  const point=await target.evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild!,0);r.setEnd(el.firstChild!,6);const b=r.getBoundingClientRect();return{x:b.left+1,y:b.top-20,endX:b.right-.5,endY:b.top+b.height*.5};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.endX,point.endY,{steps:12});
  expect(await page.evaluate(()=>getSelection()?.toString())).toBe('Target');
  await page.evaluate(point=>window.supermdNativeWheel?.(0,120,{x:point.endX,y:point.endY},true),point);
  await expect.poll(()=>page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBeGreaterThan(50);
  await expect.poll(()=>page.evaluate(()=>getSelection()?.toString().startsWith('Target'))).toBe(true);
  const before=await page.locator('.android-reading').evaluate(el=>el.scrollTop);
  const bounds=(await page.locator('.android-reading').boundingBox())!;
  await page.mouse.move(point.endX,bounds.y+bounds.height-4,{steps:12});
  await expect.poll(()=>page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBeGreaterThan(before+20);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','0.9559963715447921');
  expect(await page.evaluate(()=>getSelection()?.toString())).not.toContain('Context above the body');await page.mouse.up();
});

test('native input bursts are coalesced by display frame without dropping scroll distance',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>window.supermdLoad?.({id:'frame-scroll',path:null,content:('A paragraph for continuous touchpad scrolling.\n\n').repeat(180),mode:'reader',dark:false,colors:{},font:'Manrope',size:22,zoom:100,restorePosition:false}));
  await page.evaluate(()=>document.fonts.ready);
  const result=await page.locator('.android-reading').evaluate(async el=>{
    const rect=el.getBoundingClientRect(),before=el.scrollTop;
    for(let i=0;i<120;i++)window.supermdNativeWheel?.(0,2,{x:rect.left+50,y:rect.top+100},false);
    const immediate=el.scrollTop-before;await new Promise(requestAnimationFrame);
    return{immediate,distance:el.scrollTop-before};
  });
  expect(result.immediate).toBe(0);expect(result.distance).toBe(240);
});
