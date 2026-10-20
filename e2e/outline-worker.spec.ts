import {test,expect} from '@playwright/test';

test('large Source notes publish the current compact outline from the real worker',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).__outlines=[];
    (window as any).__outlineWorkers=0;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(url:string|URL,options?:WorkerOptions){super(url,options);(window as any).__outlineWorkers++;}
    };
    window.SuperMD={post:(id,command,raw)=>{
      if(command==='document_outline')(window as any).__outlines.push(JSON.parse(raw));
      queueMicrotask(()=>window.supermdReply?.(id,true,null));
    }};
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(()=>window.supermdLoad?.({id:'worker-outline',path:'worker-outline',content:'# Repeated café\n\n# Repeated café\n\n'+'Synthetic Source content. '.repeat(5000),mode:'editor',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100}));
  await expect.poll(()=>page.evaluate(()=>(window as any).__outlines.some((value:any)=>value.id==='worker-outline'))).toBe(true);
  const result=await page.evaluate(()=>({workers:(window as any).__outlineWorkers,outlines:(window as any).__outlines}));
  expect(result.workers).toBe(1);
  expect(result.outlines.find((value:any)=>value.id==='worker-outline').headings.map((heading:any)=>heading.id)).toEqual(['repeated-café','repeated-café-1']);
});
