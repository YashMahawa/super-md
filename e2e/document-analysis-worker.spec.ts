import {expect,test} from '@playwright/test';

const largeNote=Array.from(
  {length:75},
  (_,i)=>`## Chapter ${i}\n\n${'Readable study paragraph with **emphasis** and `inline_code` for background worker analysis. '.repeat(14)}\n\n`,
).join('');

test('renders <= 80k notes synchronously with zero workers, reuses one warm worker above 80k, and ignores stale worker revisions after shrinking below 80k',async({page})=>{
  expect(largeNote.length).toBeGreaterThan(85_000);

  await page.addInitScript(content=>{
    localStorage.setItem('setup.complete','true');
    localStorage.setItem('workspace.tabs.browser',JSON.stringify({
      tabs:[
        {id:'slice1-small',path:'/notes/slice1-small.md',content:'# Small Synchronous Note\n\nRenders immediately below 80k.',savedContent:'# Small Synchronous Note\n\nRenders immediately below 80k.',name:'slice1-small.md'},
        {id:'slice1-large',path:'/notes/slice1-large.md',content,savedContent:content,name:'slice1-large.md'},
      ],
      activeId:'slice1-small',
      recentlyClosed:[],
    }));

    (window as any).__docWorkers=0;
    (window as any).__postedSources=[] as string[];
    (window as any).__holdWorker=false;
    (window as any).__heldJobs=[] as Array<()=>void>;
    (window as any).__releaseWorker=()=>{
      (window as any).__holdWorker=false;
      const jobs=(window as any).__heldJobs.splice(0);
      for(const run of jobs)run();
    };
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(url:string|URL,options?:WorkerOptions){
        super(url,options);
        if(String(url).includes('documentAnalysis')){
          (window as any).__docWorkers++;
          const origPost=this.postMessage.bind(this);
          this.postMessage=(message:any,transfer?:any)=>{
            if(typeof message?.source==='string'){
              (window as any).__postedSources.push(message.source.slice(0,48));
            }
            if((window as any).__holdWorker){
              (window as any).__heldJobs.push(()=>origPost(message,transfer));
            }else{
              origPost(message,transfer);
            }
          };
        }
      }
    };
  },largeNote);

  await page.setViewportSize({width:1360,height:880});
  await page.goto('/');

  // Small note (<= 80k chars) renders synchronously with zero documentAnalysis workers spawned.
  await expect(page.locator('.editor-pane .cm-editor')).toBeVisible();
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Small Synchronous Note');
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(0);

  // Switching to the >80k tab lazily spawns exactly one warm documentAnalysis worker.
  await page.getByText('slice1-large.md',{exact:true}).click();
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Chapter 0');
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(1);

  // Hold background worker responses while typing in Split mode: editor stays immediate and preview stays pinned.
  await page.evaluate(()=>{(window as any).__holdWorker=true;});
  await page.locator('.editor-pane .cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('# Live Split Header\n\n');

  await expect(page.locator('.editor-pane .cm-content')).toContainText('# Live Split Header');
  await expect(page.locator('.preview-pane .markdown-body')).not.toContainText('Live Split Header');
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(1);

  // Release worker: coalesced revision updates preview on the same single warm worker.
  await page.evaluate(()=>(window as any).__releaseWorker());
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Live Split Header');
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(1);

  // Hold worker again, trigger an in-flight >80k edit, then shrink below 80k synchronously before releasing!
  await page.evaluate(()=>{(window as any).__holdWorker=true;});
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('# Stale Large Revision\n\n');
  await expect.poll(()=>page.evaluate(()=>(window as any).__heldJobs.length)).toBeGreaterThan(0);

  await page.keyboard.press('Control+A');
  await page.keyboard.type('# Crisp Synchronous Final\n\nSettled under 80k without waiting on stale worker output.');

  // Synchronous fallback updates preview immediately while the >80k worker job is still held.
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Crisp Synchronous Final');

  // Releasing the stale >80k worker job must NOT overwrite the newer synchronous revision!
  await page.evaluate(()=>(window as any).__releaseWorker());
  await page.waitForTimeout(150);
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Crisp Synchronous Final');
  await expect(page.locator('.preview-pane .markdown-body')).not.toContainText('Stale Large Revision');
  expect(await page.evaluate(()=>(window as any).__docWorkers)).toBe(1);
});

test('Worker-disabled environments fall back cleanly to synchronous document analysis',async({page})=>{
  await page.addInitScript(()=>{
    localStorage.setItem('setup.complete','true');
    // @ts-expect-error Simulate constrained runtime without Web Workers
    delete window.Worker;
  });

  await page.setViewportSize({width:1280,height:820});
  await page.goto('/');
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Super MD');
  await page.getByRole('button',{name:'reader view',exact:true}).click();
  await expect(page.locator('.preview-pane .markdown-body')).toContainText('Math that stays on the page');
});
