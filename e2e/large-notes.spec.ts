import {test,expect} from '@playwright/test';

test('offscreen Python figures reload for PDF after RAM-cache eviction without rerunning code',async({page})=>{
  const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path d="M0 90L200 10" stroke="blue"/></svg>').toString('base64');
  const disk=new Map<string,unknown>();let runs=0,exported:any;
  await page.exposeFunction('nativeCache',async(id:string,command:string,raw:string)=>{
    const args=JSON.parse(raw);let result:any=true;
    if(command==='run_python'){runs++;result={ok:true,stdout:'captured output',stderr:'',images:[image]};}
    else if(command==='cache_python_output')disk.set(args.source,args.result);
    else if(command==='load_python_output')result=disk.get(args.source)||null;
    else if(command==='export_pdf_native')exported=args;
    await page.evaluate(({id,result})=>window.supermdReply?.(id,result,null),{id,result});
  });
  await page.addInitScript(()=>{window.SuperMD={post:(id,command,raw)=>(window as any).nativeCache(id,command,raw)};});await page.goto('/android-reader.html');
  const content='## First\n\n```python\nprint("captured output")\n```\n\n'+Array.from({length:600},(_,i)=>`## Part ${i}\n\n${'Readable note. '.repeat(14)}\n\n`).join('');
  await page.evaluate(content=>window.supermdLoad?.({id:'disk-python',content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100}),content);
  await page.getByRole('button',{name:'Run',exact:true}).click();await expect(page.locator('.cell-output img')).toBeVisible();await expect(page.locator('.python-cell')).toHaveAttribute('data-output-pinned','false');
  await page.evaluate(()=>window.supermdHeading?.('part-599'));await expect(page.getByRole('heading',{name:'Part 599'})).toBeVisible();await expect(page.locator('.python-cell')).toHaveCount(0);
  await page.evaluate(async()=>{
    // @ts-expect-error Test-only Vite source import.
    const {pythonResults}=await import('/src/renderedOutputs.ts');pythonResults.clear();
    window.supermdExport?.({pageSize:'a4',margin:18,fontSize:10.5,lineHeight:1.35,fontFamily:'Manrope',pageNumbers:true});
  });
  await expect.poll(()=>exported?.content).toContain('Matplotlib figure');expect(Object.keys(exported.assets).some(key=>key.startsWith('plot-'))).toBe(true);expect(runs).toBe(1);
  await page.evaluate(()=>window.supermdHeading?.('first'));await expect(page.locator('.cell-output img')).toBeVisible();expect(runs).toBe(1);
});

const note=Array.from({length:1000},(_,i)=>`## Chapter ${i}\n\nUnique-${i} ${'Readable text with **emphasis** and a [reference][source]. '.repeat(3)} $x_${i}=\\frac{a+b}{c+d}$\n\n$$\\int_0^1 x^2 dx=\\frac13$$\n\n`).join('')+'\n[source]: https://example.org\n';
test('Source undo remains available in Read without duplicate full-note snapshots',async({page})=>{
  let content='# Draft\n\nOriginal';
  await page.exposeFunction('captureDocument',(_id:string,command:string,raw:string)=>{if(command==='document_changed')content=JSON.parse(raw).content;});
  await page.addInitScript(()=>{window.SuperMD={post:(id,command,raw)=>(window as any).captureDocument(id,command,raw)};});await page.goto('/android-reader.html');
  const state={id:'mode-history',content,path:null,mode:'editor' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100};
  await page.evaluate(state=>window.supermdLoad?.(state),state);await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type(' appended');await expect.poll(()=>content).toContain('appended');
  await page.evaluate(state=>window.supermdLoad?.(state),{...state,mode:'reader',content});await expect(page.locator('.markdown-body')).toContainText('appended');
  await page.evaluate(()=>window.supermdHistory?.('undo'));await expect(page.locator('.markdown-body')).not.toContainText('appended');
  await page.evaluate(()=>window.supermdHistory?.('redo'));await expect(page.locator('.markdown-body')).toContainText('appended');
  await page.evaluate(()=>{window.supermdFind?.();});await page.getByRole('searchbox',{name:'Find in note'}).fill('Original');await page.getByRole('button',{name:'Replace in source',exact:true}).click();await page.getByRole('textbox',{name:'Replacement text'}).fill('Replacement');await page.getByRole('button',{name:'Replace all',exact:true}).click();await page.keyboard.press('Escape');
  await expect(page.locator('.markdown-body')).toContainText('Replacement');
  await page.evaluate(state=>window.supermdLoad?.(state),{...state,content,mode:'editor'});await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type(' again');
  await page.evaluate(state=>window.supermdLoad?.(state),{...state,content,mode:'reader'});await expect(page.locator('.markdown-body')).toContainText('again');
  await page.evaluate(()=>window.supermdHistory?.('undo'));await expect(page.locator('.markdown-body')).not.toContainText('again');await expect(page.locator('.markdown-body')).toContainText('Replacement');
  await page.evaluate(()=>window.supermdHistory?.('undo'));await expect(page.locator('.markdown-body')).toContainText('Original');
});
test('large notes bound mounted math, find offscreen text, jump headings and retain Live editing',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  const state={id:'huge-note',content:note,path:null,mode:'reader' as const,dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  await expect(page.locator('[data-windowed-mounted="true"]')).not.toHaveCount(0);
  expect(await page.locator('.katex').count()).toBeLessThan(80);
  await expect(page.locator('.markdown-body a').first()).toHaveAttribute('href','https://example.org');
  await page.evaluate(()=>window.supermdHeading?.('chapter-999'));
  await expect(page.getByRole('heading',{name:'Chapter 999',exact:true})).toBeVisible();
  await expect(page.locator('#chapter-0')).toHaveAttribute('aria-hidden','true');
  expect(await page.locator('.katex').count()).toBeLessThan(80);
  await page.evaluate(()=>window.supermdFind?.());await page.getByRole('searchbox',{name:'Find in note'}).fill('Unique-500');
  await expect(page.locator('.reading-search output')).toHaveText('0 / 1');
  await page.getByRole('button',{name:'Next match',exact:true}).click();
  await expect(page.locator('.reading-search output')).toHaveText('1 / 1');
  await expect(page.locator('[data-windowed-mounted="true"]').filter({hasText:'Unique-500'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.supermdHeading?.('chapter-500'));
  const heading=page.getByRole('heading',{name:'Chapter 500',exact:true});await expect(heading).toBeVisible();
  const rect=(await heading.boundingBox())!;const point={x:rect.x+rect.width*.35,y:rect.y+rect.height*.5};
  await page.evaluate(point=>window.supermdZoomBy?.(1.5,point),point);await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.5');
  const after=(await heading.boundingBox())!;expect(after.x+after.width*.35).toBeCloseTo(point.x,0);expect(after.y+after.height*.5).toBeCloseTo(point.y,0);
  await page.evaluate(state=>window.supermdLoad?.({...state,mode:'live',zoom:150}),state);
  await page.evaluate(()=>window.supermdHeading?.('chapter-500'));await expect(heading).toBeVisible();await heading.dblclick();
  const editor=page.getByLabel('Edit Markdown block');await expect(editor).toBeVisible();await editor.fill('## Edited chapter 500\n\n');await page.keyboard.press('Escape');
  await expect(page.getByRole('heading',{name:'Edited chapter 500'})).toBeVisible();
  expect(await page.locator('.katex').count()).toBeLessThan(80);
});

test('large-note zoom frames avoid document-wide style updates and unbounded DOM',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});await page.goto('/android-reader.html');
  await page.evaluate(content=>window.supermdLoad?.({id:'memory-note',content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100}),note);
  await expect(page.locator('.katex')).not.toHaveCount(0);
  const metrics=await page.evaluate(async()=>{
    const style=document.documentElement.getAttribute('style'),durations:number[]=[];
    for(let i=0;i<60;i++){const start=performance.now();window.supermdSetZoom?.(100+i);durations.push(performance.now()-start);await new Promise(requestAnimationFrame);}
    return {nodes:document.querySelectorAll('*').length,math:document.querySelectorAll('.katex').length,styleUnchanged:style===document.documentElement.getAttribute('style'),p95:durations.sort((a,b)=>a-b)[56]};
  });
  expect(metrics.styleUnchanged).toBe(true);expect(metrics.nodes).toBeLessThan(10_000);expect(metrics.math).toBeLessThan(80);
  await test.info().attach('large-note-metrics',{body:JSON.stringify({sourceBytes:Buffer.byteLength(note),...metrics}),contentType:'application/json'});
});
