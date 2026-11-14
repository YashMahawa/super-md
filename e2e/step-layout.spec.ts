import {test,expect} from '@playwright/test';
for(const width of [1200,900,412])test(`compact rich step layout ${width}`,async({page})=>{
 await page.setViewportSize({width,height:width===900?412:width===412?915:800});
 await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};});
 await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
 const svg='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 340"><circle cx="320" cy="80" r="45" fill="#ffb66b"/><path d="M300 125L200 235M340 125L440 235" stroke="#73e3e0" stroke-width="5"/><circle cx="190" cy="275" r="45" fill="#153d4b"/><circle cx="450" cy="275" r="45" fill="#153d4b"/></svg>').toString('base64');
 const deck={title:'Tree update',steps:[{label:'Before',image:svg,markdown:'**Mean** of two values:\n\n$$\\mu=\\frac{2+4}{2}=3$$'},{label:'After',image:svg,markdown:'The **updated** centre is 3.'}]};
 await page.evaluate(content=>window.supermdLoad?.({id:'layout',content,path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100}),'```smd-steps\n'+JSON.stringify(deck)+'\n```');
 const card=page.locator('.step-cards');await expect(card.locator('.katex')).toBeVisible();
 await expect(card.locator('strong').filter({hasText:'Mean'})).toBeVisible();
 const bounds=await card.locator('.step-cards-stage').boundingBox();const notes=await card.locator('.step-cards-notes').boundingBox();
 expect(notes!.height).toBeLessThan(300);
 if(width>700)expect(notes!.x).toBeGreaterThan(bounds!.x+bounds!.width-1);else expect(notes!.y).toBeGreaterThanOrEqual(bounds!.y+bounds!.height-1);
 await card.hover();await page.keyboard.press('ArrowRight');await expect(card.locator('.step-cards-step-title')).toHaveText('After');
 await page.keyboard.press('ArrowLeft');await expect(card.locator('.step-cards-step-title')).toHaveText('Before');
 await expect(page.getByText('Choose step',{exact:true})).toHaveCount(0);
 await page.screenshot({path:test.info().outputPath(`steps-${width}.png`)});
 if(width===1200){
  const prior=(await card.locator('.step-cards-stage').boundingBox())!.height;
  await page.setViewportSize({width,height:350});
  await expect.poll(async()=> (await card.locator('.step-cards-stage').boundingBox())!.height).toBeLessThan(prior);
  await page.setViewportSize({width,height:800});
 }
 const long={title:'Long explanation',steps:[{label:'One',markdown:Array.from({length:50},(_,i)=>`Paragraph ${i}: a necessary explanation.`).join('\n\n')},{label:'Two',markdown:'Short ending.'}]};
 await page.evaluate(content=>window.supermdLoad?.({id:'scrolling',content,path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100}),'```smd-steps\n'+JSON.stringify(long)+'\n```');
 const layout=page.locator('.step-cards-layout');
 await expect.poll(()=>layout.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 const before=(await page.locator('.step-cards-controls').boundingBox())!;
 await layout.evaluate(el=>el.scrollTop=el.scrollHeight);
 const after=(await page.locator('.step-cards-controls').boundingBox())!;
 expect(Math.abs(after.y-before.y)).toBeLessThan(1);
 await expect(page.getByRole('button',{name:'Next step'})).toBeVisible();
});
