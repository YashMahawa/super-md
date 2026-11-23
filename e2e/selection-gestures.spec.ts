import {test,expect,type Page} from '@playwright/test';

for(const platform of ['desktop','android'])test(`selection from the upper edge follows the visible text and scrolling never zooms it: ${platform}`,async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(platform=>{document.documentElement.dataset.platform=platform;window.supermdLoad?.({id:'selection-gesture',path:null,content:'# Selection\n\nAlpha Bravo Charlie Delta Echo Foxtrot.\n\n'+('A later paragraph that must not become the selection anchor.\n\n').repeat(220),mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:175,restorePosition:false});},platform);
  await page.evaluate(()=>document.fonts.ready);
  const points=await page.locator('.markdown-body p').first().evaluate(node=>{
    const text=node.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,1);const first=range.getBoundingClientRect();
    range.setStart(text,18);range.setEnd(text,19);const last=range.getBoundingClientRect();
    return {x:first.left+1,y:first.top-1,endX:last.right+1,endY:last.top+last.height/2};
  });
  await page.mouse.move(points.x,points.y);await page.mouse.down();
  await page.mouse.move(points.endX,points.endY,{steps:12});
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString().trim())).toBe('Alpha Bravo Charlie');
  await page.mouse.wheel(0,90);await page.waitForTimeout(350);
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.75');
  await page.evaluate(()=>window.supermdNativeWheel?.(0,90,{x:300,y:200},true));
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.75');
  await page.mouse.up();
  if(platform==='android'){
    await expect(page.locator('.document-page')).toHaveAttribute('data-selection-scale','1.75');
    await expect(page.locator('.document-page')).toHaveAttribute('data-selection-model','layout');
  }
});

async function checkParagraphSelection(page:Page,mode:'reader'|'live'|'split',zoom:number){
  await page.setViewportSize({width:1600,height:1000});
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(({mode,zoom})=>{
    document.documentElement.dataset.platform='desktop';
    window.supermdLoad?.({id:'selection-scrolled',path:null,content:('# Previous paragraph\n\nText above must stay outside the selected excerpt.\n\n').repeat(15)+'## Target\n\nAlpha Bravo Charlie Delta Echo Foxtrot.\n\nText below must stay outside the selected excerpt.',mode,dark:false,colors:{},font:'Manrope',size:16,zoom,restorePosition:false});
  },{mode,zoom});
  await page.evaluate(()=>document.fonts.ready);
  const paragraph=page.locator('.markdown-body p').filter({hasText:'Alpha Bravo Charlie Delta Echo Foxtrot.'});
  await paragraph.scrollIntoViewIfNeeded();
  for(const reverse of [false,true]){
    const point=await paragraph.evaluate(node=>{
      const range=document.createRange(),text=node.firstChild!;range.setStart(text,6);range.setEnd(text,11);const r=range.getBoundingClientRect();
      return {left:r.left+.5,right:r.right-.5,y:r.top+r.height/2};
    });
    await page.mouse.move(reverse?point.right:point.left,point.y);await page.mouse.down();
    const start=await page.evaluate(()=>{const s=window.getSelection();return {text:s?.toString(),anchor:s?.anchorOffset,focus:s?.focusOffset};});
    await page.mouse.move(reverse?point.left:point.right,point.y,{steps:10});
    const moving=await page.evaluate(()=>{const s=window.getSelection();return {text:s?.toString(),anchor:s?.anchorOffset,focus:s?.focusOffset};});
    await page.mouse.up();
    const diagnostic=await paragraph.evaluate(node=>{const r=node.getBoundingClientRect(),s=window.getSelection();return {x:r.x,y:r.y,zoom:(node.closest('.document-page') as HTMLElement).style.zoom,anchor:s?.anchorNode?.parentElement?.outerHTML.slice(0,200),offset:s?.anchorOffset,focus:s?.focusOffset,active:document.activeElement?.tagName};});
    await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()),{message:JSON.stringify({mode,zoom,reverse,point,start,moving,diagnostic})}).toBe('Bravo');
    await expect(page.locator('.document-page')).toHaveAttribute('data-scale',String(zoom/100));
  }
}

for(const mode of ['reader','live','split'] as const)for(const zoom of [40,300])test(`forward and backward text selection stays on its paragraph after scrolling: ${mode} ${zoom}%`,async({page})=>checkParagraphSelection(page,mode,zoom));
for(const scale of [1.25,2])test.describe(`native selection at display scale ${scale}`,()=>{
  test.use({deviceScaleFactor:scale});
  test('small text remains selectable in Split at 40%',async({page})=>checkParagraphSelection(page,'split',40));
});
