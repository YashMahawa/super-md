import {test,expect} from '@playwright/test';

test('wide short onboarding keeps its actions reachable with local scrolling only when needed',async({page})=>{
  await page.setViewportSize({width:1000,height:520});
  await page.addInitScript(()=>{
    localStorage.removeItem('setup.complete');localStorage.removeItem('setup.started');localStorage.removeItem('theme.normal');
    window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};
  });
  await page.goto('/');
  const dialog=page.getByRole('dialog',{name:'Welcome to Super MD'}),card=page.locator('.welcome-card');
  await expect(dialog).toBeVisible();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'Set your reading mood'})).toBeVisible();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'Start with a clear page'})).toBeVisible();

  const short=await card.evaluate(element=>{
    const box=element.getBoundingClientRect();return {top:box.top,bottom:box.bottom,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};
  });
  expect(short.top).toBeGreaterThanOrEqual(0);expect(short.bottom).toBeLessThanOrEqual(520);
  expect(short.scrollHeight).toBeGreaterThan(short.clientHeight);
  await card.evaluate(element=>{element.scrollTop=element.scrollHeight;});
  const sample=dialog.getByRole('button',{name:'Explore the sample',exact:true});
  await expect(sample).toBeInViewport();
  expect(await page.evaluate(()=>window.scrollY)).toBe(0);

  await page.setViewportSize({width:1440,height:900});
  await card.evaluate(element=>{element.scrollTop=0;});
  const normal=await card.evaluate(element=>({scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,scrollTop:element.scrollTop}));
  expect(normal.scrollHeight).toBeLessThanOrEqual(normal.clientHeight);
  expect(normal.scrollTop).toBe(0);
  await expect(sample).toBeInViewport();
});
