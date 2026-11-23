import {test,expect} from '@playwright/test';

test('native Find invocation sends immediate typing to search and refocuses an existing search',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='load_python_output'?null:true,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>window.supermdLoad?.({id:'native-find',path:null,content:'# Needle in a note',mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false}));
  await page.evaluate(()=>window.supermdFind?.());
  await page.keyboard.type('Needle');
  const field=page.getByRole('searchbox',{name:'Find in note'});
  await expect(field).toHaveValue('Needle');
  await expect(page.getByRole('search').locator('output')).toHaveText('0 / 1');
  await page.getByRole('button',{name:'Next match'}).click();
  await page.evaluate(()=>window.supermdFind?.());
  await page.keyboard.type('next');
  await expect(field).toHaveValue('next');
});

for(const width of [390,1280,2560])test(`search and export overlays use readable native-size text at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:width===390?844:1440});
  await page.addInitScript(()=>{
    window.SuperMD={post:(id,command)=>{
      // Keep the actual export panel open at the native typesetting boundary.
      if(command==='export_pdf_native')return;
      queueMicrotask(()=>window.supermdReply?.(id,command==='load_python_output'?null:true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(width=>{
    document.documentElement.dataset.platform=width===390?'android':'desktop';
    window.supermdLoad?.({id:'overlay-sizing',content:'# A readable note\n\nNeedle, a Unicode \u03a9 example.',path:null,mode:'reader',dark:true,colors:{},font:'Manrope',size:18,zoom:175,restorePosition:false});
  },width);
  await page.keyboard.press('Control+f');
  const search=page.getByRole('search'),field=page.getByRole('searchbox',{name:'Find in note'});
  await expect(field).toBeFocused();await field.fill('Needle');
  await expect(search.locator('output')).toHaveText('0 / 1');
  const geometry=await field.evaluate(el=>{
    const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
    return {left:rect.left,right:rect.right,font:parseFloat(style.fontSize),height:rect.height,layoutHeight:(el as HTMLElement).offsetHeight,transform:style.transform};
  });
  expect(geometry.font).toBeGreaterThanOrEqual(width===2560?20:16);
  expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(width);
  expect(Math.abs(geometry.height-geometry.layoutHeight)).toBeLessThan(1);
  expect(geometry.transform).toBe('none');
  if(width===2560){expect((await search.boundingBox())!.width).toBeLessThanOrEqual(960);await page.screenshot({path:'/tmp/supermd-large-search.png'});}
  await page.keyboard.press('Escape');await expect(search).toHaveCount(0);
  await page.evaluate(()=>void window.supermdExport?.({pageSize:'a4',margin:18,fontSize:10,lineHeight:1.45,fontFamily:'Manrope',pageNumbers:true}));
  const dialog=page.getByRole('dialog',{name:'Exporting PDF'});
  await expect(dialog).toContainText('Typesetting your document');
  const bounds=(await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
  if(width===2560)expect(bounds.width).toBeLessThanOrEqual(760);
  await expect(dialog.locator('.export-progress-morph')).toBeVisible();
  const progress=dialog.getByRole('progressbar');await expect(progress).toBeAttached();
  expect(await progress.evaluate(el=>getComputedStyle(el).clipPath)).toBe('inset(50%)');
  expect((await progress.boundingBox())!.width).toBe(1);
  await expect(dialog.getByRole('button',{name:'Cancel export'})).toBeVisible();
  if(width===2560)await page.screenshot({path:'/tmp/supermd-large-export-progress.png'});
});
