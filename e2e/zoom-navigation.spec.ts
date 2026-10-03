import {test,expect} from '@playwright/test';
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
