import {test,expect} from '@playwright/test';

test('native edits send small UTF-16 patches and flush waits for all acknowledgements',async({page})=>{
  const content='# Draft\n\n'+('A substantial unchanged paragraph.\n'.repeat(12000));
  await page.addInitScript(initial=>{
    const native={content:initial,revision:0,patchSizes:[] as number[],flushed:''};
    (window as any).__editNative=native;
    window.SuperMD={post:(id,command,raw)=>{
      const args=JSON.parse(raw);
      if(command==='document_sync'){
        window.setTimeout(()=>window.supermdReply?.(id,{accepted:args.content===native.content,revision:0},null),20);return;
      }
      if(command==='document_patch'){
        native.patchSizes.push(raw.length);
        window.setTimeout(()=>{
          if(args.baseRevision!==native.revision){window.supermdReply?.(id,{accepted:false},null);return;}
          for(const change of [...args.changes].reverse())native.content=native.content.slice(0,change.from)+change.insert+native.content.slice(change.to);
          native.revision=args.revision;
          window.supermdReply?.(id,{accepted:true,revision:native.revision},null);
        },60);return;
      }
      if(command==='document_flushed')native.flushed=args.content;
      queueMicrotask(()=>window.supermdReply?.(id,true,null));
    }};
  },content);
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(content=>window.supermdLoad?.({id:'patch-note',path:'patch-note',content,mode:'editor',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,editProtocol:1} as any),content);
  const editor=page.locator('.cm-content');await editor.click();await page.keyboard.press('Control+End');
  await page.keyboard.insertText('😀 edited');
  await page.evaluate(()=>window.supermdFlush?.({action:'save',target:'patch-note'}));
  await expect.poll(()=>page.evaluate(()=>(window as any).__editNative.flushed)).toBe(content+'😀 edited');
  const native=await page.evaluate(()=>(window as any).__editNative);
  expect(native.content).toBe(native.flushed);
  expect(native.patchSizes.length).toBeGreaterThan(0);
  expect(Math.max(...native.patchSizes)).toBeLessThan(1024);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Live preserves document-wide links, footnote numbering and loose-list semantics',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const state={id:'live-context',path:null,content:'# Same\n\nA [reference][site] and footnote[^first].\n\n- First item\n\n  Second paragraph\n\n- Second item\n\n# Same\n\nAnother footnote[^second].\n\n[site]: https://example.org\n\n[^first]: First definition\n\n[^second]: Second definition',mode:'live' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await expect(page.locator('a[href="https://example.org"]')).toHaveCount(1);
  await expect(page.locator('[data-footnote-ref]')).toHaveText(['1','2']);
  await expect(page.locator('h1#same')).toHaveCount(1);await expect(page.locator('h1#same-1')).toHaveCount(1);
  await expect(page.locator('ul>li').first()).toContainText('Second paragraph');
  await expect(page.locator('[data-footnotes]')).toHaveCount(1);
  await page.locator('h1#same').dblclick();
  await page.getByRole('textbox',{name:'Edit Markdown block'}).fill('# Updated');
  await page.getByRole('textbox',{name:'Edit Markdown block'}).press('Escape');
  await expect(page.getByRole('heading',{name:'Updated',exact:true})).toBeVisible();
  await expect(page.locator('a[href="https://example.org"]')).toHaveCount(1);
});
