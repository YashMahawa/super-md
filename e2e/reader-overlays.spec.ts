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

test('Android Back dismisses active Live edits and Source search synchronously while keeping drafts and releasing second Back',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(()=>{
    (window as any).__bridgeEvents=[];
    window.SuperMD={post:(id,command,raw)=>{
      (window as any).__bridgeEvents.push({command,args:JSON.parse(raw)});
      queueMicrotask(()=>window.supermdReply?.(id,command==='load_python_output'?null:true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);

  // 1. Active Live edit: first Back dismisses and keeps draft (including uncommitted textarea tail); second Back returns false.
  await page.evaluate(()=>{
    document.documentElement.dataset.platform='android';
    window.supermdLoad?.({
      id:'android-back-live',
      path:null,
      content:'# Study notes\n\nOriginal live paragraph.',
      mode:'live',
      dark:false,
      fullscreen:false,
      colors:{primary:'#42669e','on-primary':'#ffffff','primary-container':'#d7e3ff','on-primary-container':'#162c4c',surface:'#f7f9fd','surface-low':'#f0f3fa','surface-high':'#e5ebf5',text:'#191c20',muted:'#56647c',outline:'#c4c6d0'},
      font:'Manrope',
      size:16,
      zoom:100,
      restorePosition:false,
    });
  });
  const liveBlock=page.locator('.live-block').filter({hasText:'Original live paragraph.'});
  await liveBlock.dblclick();
  const liveTextarea=page.locator('.live-active-block textarea');
  await expect(liveTextarea).toBeVisible();
  await liveTextarea.fill('Edited live draft');
  await liveTextarea.evaluate((area:HTMLTextAreaElement)=>{
    area.value='Edited live draft kept across Android Back.';
    area.setSelectionRange(area.value.length,area.value.length);
  });
  expect(await page.evaluate(()=>document.documentElement.dataset.readerDismissible)).toBe('true');
  expect(await page.evaluate(()=>document.documentElement.dataset.readerOverlay??'false')).toBe('false');
  await page.screenshot({path:'/tmp/android-live-edit-before-back.png'});

  const firstLiveBack=await page.evaluate(()=>{
    const dismissed=Boolean(window.supermdDismiss?.());
    const d=document.documentElement.dataset;
    return {dismissed,overlay:d.readerOverlay==='true',dismissible:d.readerDismissible==='true'};
  });
  expect(firstLiveBack).toEqual({dismissed:true,overlay:false,dismissible:false});
  await expect(liveTextarea).toHaveCount(0);
  await expect(page.locator('.live-block').filter({hasText:'Edited live draft kept across Android Back.'})).toBeVisible();
  await page.screenshot({path:'/tmp/android-live-edit-after-back.png'});
  expect(await page.evaluate(()=>Boolean(window.supermdDismiss?.()))).toBe(false);

  // 2. Source search: both native ReadingSearch ("Find in note") and unfocused CodeMirror .cm-search dismiss while keeping Source drafts.
  await page.evaluate(()=>{
    window.supermdLoad?.({
      id:'android-back-source',
      path:null,
      content:'# Source study note\n\nSearch needle alpha.',
      mode:'editor',
      dark:false,
      fullscreen:false,
      colors:{primary:'#42669e','on-primary':'#ffffff','primary-container':'#d7e3ff','on-primary-container':'#162c4c',surface:'#f7f9fd','surface-low':'#f0f3fa','surface-high':'#e5ebf5',text:'#191c20',muted:'#56647c',outline:'#c4c6d0'},
      font:'Manrope',
      size:16,
      zoom:100,
      restorePosition:false,
    });
  });
  await expect(page.locator('.android-source .cm-content')).toBeVisible();
  await page.evaluate(()=>{
    window.dispatchEvent(new CustomEvent('supermd-goto-offset',{detail:1000000}));
    window.dispatchEvent(new CustomEvent('supermd-format',{detail:{block:true,prefix:'\nDraft line kept across Source search Back.'}}));
    window.supermdFind?.('needle');
  });
  await expect(page.getByRole('searchbox',{name:'Find in note'})).toHaveValue('needle');
  expect(await page.evaluate(()=>document.documentElement.dataset.readerOverlay)).toBe('true');
  await page.screenshot({path:'/tmp/android-source-search-before-back.png'});

  const firstFindBack=await page.evaluate(()=>{
    const dismissed=Boolean(window.supermdDismiss?.());
    const d=document.documentElement.dataset;
    return {dismissed,overlay:d.readerOverlay==='true',dismissible:d.readerDismissible==='true'};
  });
  expect(firstFindBack).toEqual({dismissed:true,overlay:false,dismissible:false});
  await expect(page.locator('.reading-search')).toHaveCount(0);
  await expect(page.locator('.android-source .cm-content')).toContainText('Draft line kept across Source search Back.');
  await page.screenshot({path:'/tmp/android-source-search-after-back.png'});
  expect(await page.evaluate(()=>Boolean(window.supermdDismiss?.()))).toBe(false);

  // CodeMirror inline .cm-search when focus has moved outside the editor.
  await page.evaluate(()=>{
    window.dispatchEvent(new Event('supermd-find'));
    (document.activeElement as HTMLElement|null)?.blur?.();
  });
  await expect(page.locator('.cm-search')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.dataset.readerDismissible)).toBe('true');
  const cmSearchBack=await page.evaluate(()=>{
    const dismissed=Boolean(window.supermdDismiss?.());
    const d=document.documentElement.dataset;
    return {dismissed,overlay:d.readerOverlay==='true',dismissible:d.readerDismissible==='true'};
  });
  expect(cmSearchBack).toEqual({dismissed:true,overlay:false,dismissible:false});
  await expect(page.locator('.cm-search')).toHaveCount(0);
  await expect(page.locator('.android-source .cm-content')).toContainText('Draft line kept across Source search Back.');
  expect(await page.evaluate(()=>Boolean(window.supermdDismiss?.()))).toBe(false);

  const dismissibleSignals=await page.evaluate(()=>((window as any).__bridgeEvents as Array<{command:string;args:{open:boolean}}>).filter(e=>e.command==='reader_dismissible_changed').map(e=>e.args.open));
  expect(dismissibleSignals).toEqual([true,false,true,false]);
});
