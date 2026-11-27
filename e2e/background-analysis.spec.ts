import {expect,test} from '@playwright/test';

const largeNote=Array.from({length:75},(_,i)=>`## Chapter ${i}\n\n${i===0?'- [ ] Review proof step\n\n':''}${'Readable study paragraph with **emphasis** and `inline_code` for background worker analysis. '.repeat(14)}\n\n`).join('');

test('Split mode reuses one warm background worker, persists edits immediately, and aligns pinned checkbox toggles',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).__docWorkers=0;
    (window as any).__holdWorker=false;
    (window as any).__heldJobs=[] as Array<()=>void>;
    (window as any).__releaseWorker=()=>{
      (window as any).__holdWorker=false;
      const jobs=(window as any).__heldJobs.splice(0);
      for(const run of jobs)run();
    };
    (window as any).__changed=[];
    (window as any).__flushed=[];
    (window as any).__outlines=[];
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(String(url).includes('documentAnalysis')){
          (window as any).__docWorkers++;
          const origPost=this.postMessage.bind(this);
          this.postMessage=(message:any,transfer?:any)=>{
            if((window as any).__holdWorker){
              (window as any).__heldJobs.push(()=>origPost(message,transfer));
            }else{
              origPost(message,transfer);
            }
          };
        }
      }
    };
    window.SuperMD={
      post:(id,command,raw)=>{
        const parsed=raw?JSON.parse(raw):null;
        if(command==='document_changed')(window as any).__changed.push(parsed.content);
        if(command==='document_flushed')(window as any).__flushed.push(parsed.content);
        if(command==='document_outline')(window as any).__outlines.push(parsed);
        queueMicrotask(()=>window.supermdReply?.(id,true,null));
      },
    };
  });

  await page.setViewportSize({width:1280,height:860});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');

  expect(largeNote.length).toBeGreaterThan(85_000);
  const state={
    id:'split-bg-worker',
    path:null,
    content:largeNote,
    mode:'split' as const,
    dark:false,
    fullscreen:false,
    colors:{},
    font:'Manrope',
    size:17,
    zoom:100,
  };
  await page.evaluate(s=>window.supermdLoad?.(s),state);

  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator('.markdown-body')).toContainText('Chapter 0');
  await expect.poll(()=>page.evaluate(()=>(window as any).__outlines.length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(1);

  // Deterministically hold background worker delivery while typing & toggling a pinned checkbox!
  await page.evaluate(()=>{(window as any).__holdWorker=true;});
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('# Live Split Header\n\n');

  // Authoritative state & flush MUST contain the typed text immediately (0ms) before worker finishes!
  await page.evaluate(()=>window.supermdFlush?.({action:'check',target:'split-bg-worker',token:'t1'}));
  const immediateState=await page.evaluate(()=>({
    flushed:(window as any).__flushed.at(-1) as string,
    changed:(window as any).__changed.at(-1) as string,
    previewHasHeader:document.querySelector('.markdown-body')?.textContent?.includes('Live Split Header')??false,
  }));
  expect(immediateState.changed).toContain('# Live Split Header');
  expect(immediateState.flushed).toContain('# Live Split Header');
  expect(immediateState.previewHasHeader).toBe(false);

  // Toggle the task checkbox in the still-pinned preview while worker analysis is in flight!
  const checkbox=page.locator('.markdown-body input[type="checkbox"]').first();
  await checkbox.click();

  // Release background worker and verify BOTH the typed header AND the aligned task toggle are preserved on 1 warm worker.
  await page.evaluate(()=>(window as any).__releaseWorker());
  await expect(page.locator('.markdown-body')).toContainText('Live Split Header');
  await expect(checkbox).toBeChecked();

  const settled=await page.evaluate(()=>({
    workers:(window as any).__docWorkers as number,
    latest:(window as any).__changed.at(-1) as string,
    outlineTitles:(window as any).__outlines.at(-1)?.headings?.slice(0,2).map((h:any)=>h.title),
  }));
  expect(settled.workers).toBe(1);
  expect(settled.latest).toContain('# Live Split Header');
  expect(settled.latest).toContain('- [x] Review proof step');
  expect(settled.outlineTitles).toEqual(['Live Split Header','Chapter 0']);
});

test('large notes preserve reading scroll position across Reader, Source, Split, and Live mode switches after async analysis',async({page})=>{
  await page.addInitScript(()=>{
    window.SuperMD={
      post:(id)=>queueMicrotask(()=>window.supermdReply?.(id,true,null)),
    };
  });

  await page.setViewportSize({width:1280,height:860});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');

  const base={
    id:'mode-scroll-note',
    path:'/notes/large-mode-switch.md',
    content:largeNote,
    mode:'reader' as const,
    dark:false,
    fullscreen:false,
    colors:{},
    font:'Manrope',
    size:17,
    zoom:100,
    restorePosition:true,
  };
  await page.evaluate(s=>window.supermdLoad?.(s),base);
  await expect(page.locator('.android-reading')).toHaveAttribute('data-measured','true');

  await page.evaluate(()=>window.supermdHeading?.('chapter-45'));
  await expect(page.getByRole('heading',{name:'Chapter 45',exact:true})).toBeVisible();
  const readerScroll=await page.locator('.android-reading').evaluate(el=>el.scrollTop);
  expect(readerScroll).toBeGreaterThan(3000);

  for(const mode of ['editor','split','live','reader'] as const){
    await page.evaluate(({s,m})=>window.supermdLoad?.({...s,mode:m}),{s:base,m:mode});
    if(mode==='editor'){
      await expect(page.locator('.cm-scroller')).toBeVisible();
      await expect.poll(()=>page.locator('.cm-scroller').evaluate(el=>el.scrollTop)).toBeGreaterThan(1500);
    }else{
      await expect(page.locator('.android-reading')).toHaveAttribute('data-measured','true');
      await expect.poll(()=>page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBeGreaterThan(2500);
    }
  }
});

test('standalone workspace shares background outline navigation, restores scroll across modes, and falls back when Worker is unavailable',async({page,browser})=>{
  await page.setViewportSize({width:1360,height:880});
  await page.addInitScript(content=>{
    localStorage.setItem('setup.complete','true');
    localStorage.setItem('workspace.tabs.browser',JSON.stringify({
      tabs:[{id:'standalone-large',path:'/notes/standalone-large.md',content,savedContent:content,name:'standalone-large.md'}],
      activeId:'standalone-large',
      recentlyClosed:[],
    }));
  },largeNote);

  await page.goto('/');
  await expect(page.getByRole('tab',{name:'standalone-large.md'})).toBeVisible();

  // Open sidebar and jump to offscreen Chapter 50 via background-analyzed Document outline!
  await page.getByRole('button',{name:'Toggle folder sidebar'}).click();
  const outlineNav=page.getByRole('navigation',{name:'Document outline'});
  await expect(outlineNav).toBeVisible();
  const chapter50Button=outlineNav.getByRole('button',{name:'Chapter 50',exact:true});
  await chapter50Button.scrollIntoViewIfNeeded();
  await chapter50Button.click();

  const readingScroll=page.locator('.preview-pane .reading-scroll');
  await expect.poll(()=>readingScroll.evaluate(el=>el.scrollTop)).toBeGreaterThan(3000);
  await expect(page.locator('.preview-pane').getByRole('heading',{name:'Chapter 50',exact:true})).toBeVisible();

  // Switch across Reader -> Source -> Live -> Split and verify reading position survives!
  await page.getByRole('button',{name:'reader view',exact:true}).click();
  await expect.poll(()=>page.locator('.preview-pane .reading-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(3000);

  await page.getByRole('button',{name:'editor view',exact:true}).click();
  await expect.poll(()=>page.locator('.cm-scroller').evaluate(el=>el.scrollTop)).toBeGreaterThan(1500);

  await page.getByRole('button',{name:'live view',exact:true}).click();
  await expect.poll(()=>page.locator('.live-pane .reading-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(2500);

  await page.getByRole('button',{name:'split view',exact:true}).click();
  await expect.poll(()=>page.locator('.preview-pane .reading-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(2500);

  // Verify clean synchronous fallback when window.Worker is unavailable!
  const noWorkerContext=await browser.newContext({viewport:{width:1280,height:800}});
  const noWorkerPage=await noWorkerContext.newPage();
  await noWorkerPage.addInitScript(()=>{
    localStorage.setItem('setup.complete','true');
    // @ts-expect-error Simulate constrained environment without Web Workers
    delete window.Worker;
  });
  await noWorkerPage.goto('/');
  await expect(noWorkerPage.locator('.preview-pane .markdown-body')).toContainText('Super MD');
  await noWorkerPage.getByRole('button',{name:'Toggle folder sidebar'}).click();
  await expect(noWorkerPage.getByRole('navigation',{name:'Document outline'})).toContainText('Math that stays on the page');
  await noWorkerContext.close();
});
