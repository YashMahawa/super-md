import {test,expect} from '@playwright/test';

type AgentRequest=Record<string,unknown>;

async function agent(page:any,request:AgentRequest){
  return page.evaluate((value:AgentRequest)=>new Promise((resolve,reject)=>{
    const requestFn=(window as any).supermdAgentRequest;
    if(typeof requestFn!=='function'){reject(new Error('Reader agent hook is unavailable'));return;}
    requestFn(value,(result:unknown,error:string)=>error?reject(new Error(error)):resolve(result));
  }),request);
}

async function settleReadingScroll(page:any){
  await page.waitForFunction(()=>new Promise(resolve=>{
    let previous=(document.querySelector('.android-reading') as HTMLElement|null)?.scrollTop??0,stable=0;
    const sample=()=>{
      const current=(document.querySelector('.android-reading') as HTMLElement|null)?.scrollTop??0;
      stable=Math.abs(current-previous)<0.5?stable+1:0;previous=current;
      if(stable>=8)resolve(true);else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }),null,{timeout:10000});
}

test('live reader serves bounded exact diagram source, visible context and revision-guarded edits',async({page})=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32">\n'+
    Array.from({length:12000},(_,index)=>`<path id="path-${index}" d="M${index%64} 0L${index%64} 32" stroke="#245"/>`).join('\n')+
    '\n</svg>';
  const mermaid='flowchart LR\n  A["Start"] --> B{"Current view?"}\n  B -->|yes| C["Exact source"]';
  const content=`# Reader hook check 🧭\n\nOpening paragraph visible to the reader.\n\n## Flow\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n## Appendix\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n## Footer\n\nTail text.\n`;
  await page.addInitScript(initial=>{
    const native={content:initial,revision:0,patches:[] as unknown[],flushes:[] as unknown[]};
    (window as any).__agentNative=native;
    window.SuperMD={post:(id:string,command:string,raw:string)=>{
      const args=JSON.parse(raw);let result:any=true,delay=0;
      if(command==='document_sync'){
        result={accepted:args.content===native.content,revision:native.revision};
      }else if(command==='document_patch'){
        delay=70;
        if(args.baseRevision!==native.revision)result={accepted:false,revision:native.revision};
        else{
          for(const change of [...args.changes].reverse())native.content=native.content.slice(0,change.from)+change.insert+native.content.slice(change.to);
          native.revision=args.revision;native.patches.push(args);result={accepted:true,revision:native.revision};
        }
      }else if(command==='document_resync'){
        native.content=args.content;native.revision=0;result={accepted:true,revision:0};
      }else if(command==='document_flushed')native.flushes.push(args);
      window.setTimeout(()=>window.supermdReply?.(id,result,null),delay);
    }};
  },content);
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const state={id:'agent-reader-e2e',path:null,content,mode:'reader' as const,dark:false,fullscreen:false,
    colors:{},font:'Manrope',size:16,zoom:100,editProtocol:1,restorePosition:false};
  await page.evaluate(value=>window.supermdLoad?.(value),state);
  await expect(page.getByRole('heading',{name:'Reader hook check 🧭',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Flow',exact:true})).toBeVisible();
  await expect.poll(()=>page.locator('.mermaid img').evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(50);
  await settleReadingScroll(page); // allow the large diagram's intrinsic dimensions to settle
  const before=await page.locator('.android-reading').evaluate(element=>element.scrollTop);

  const context:any=await agent(page,{action:'get_context',tabId:state.id,requestId:'context'});
  expect(context.mode).toBe('reader');
  expect(context.visibleSource).toMatchObject({start:expect.any(Number),end:expect.any(Number)});
  expect(context.reading.offset).toBe(context.visibleSource.start);
  // Prose can consume a large SVG range in one step, while the returned
  // text stays bounded and exposes the exact omitted source span.
  expect(context.visibleSource.returned_chars).toBeLessThanOrEqual(7000);
  const sourceCheckLength=Math.min(6000,context.visibleSource.end-context.visibleSource.start);
  const rangeRead:any=await agent(page,{action:'read_tab',tabId:state.id,offset:context.visibleSource.start,
    limit:sourceCheckLength,view:'source',requestId:'context-source-check'});
  expect(rangeRead.text).toBe(Array.from(content).slice(context.visibleSource.start,context.visibleSource.start+sourceCheckLength).join(''));
  expect(context.visibleSource.text.toLowerCase()).not.toContain('<path id=');
  expect(context.visibleSource.text.includes('flowchart LR')||context.visibleSource.text.includes('[SVG omitted:')).toBe(true);

  const diagrams:any=await agent(page,{action:'list_diagrams',tabId:state.id,requestId:'diagrams'});
  expect(diagrams.diagrams.map((item:any)=>item.kind)).toEqual(['mermaid','svg']);
  const flow=diagrams.diagrams[0],svgInfo=diagrams.diagrams[1];
  const prose:any=await agent(page,{action:'read_tab',tabId:state.id,offset:svgInfo.sourceStart,limit:12000,view:'prose'});
  expect(prose.text.toLowerCase()).not.toContain('<path id=');
  expect(prose.svg_omissions).toHaveLength(1);
  const exact:any=await agent(page,{action:'read_tab',tabId:state.id,offset:svgInfo.sourceStart,limit:300,view:'source'});
  expect(exact.text).toContain('<svg');
  expect(exact.text).toContain('path-0');

  const flowSource:any=await agent(page,{action:'get_diagram',tabId:state.id,diagramId:flow.id,
    expectedRevision:context.revision,offset:0,limit:12000});
  expect(flowSource.text).toBe(mermaid);
  const flowImage:any=await agent(page,{action:'get_diagram_image',tabId:state.id,diagramId:flow.id,
    expectedRevision:context.revision});
  expect(flowImage.mime_type).toBe('image/png');
  expect(flowImage.width).toBeGreaterThan(0);expect(flowImage.height).toBeGreaterThan(0);
  expect(Buffer.from(flowImage.data,'base64').subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  const flowJpeg:any=await agent(page,{action:'get_diagram_image',tabId:state.id,diagramId:flow.id,
    expectedRevision:context.revision,imageFormat:'jpeg',width:640});
  expect(flowJpeg.mime_type).toBe('image/jpeg');
  expect(flowJpeg.width).toBeGreaterThan(0);expect(flowJpeg.height).toBeGreaterThan(0);
  expect(Math.max(flowJpeg.width,flowJpeg.height)).toBeLessThanOrEqual(640);
  const jpeg=Buffer.from(flowJpeg.data,'base64');expect(jpeg.subarray(0,3)).toEqual(Buffer.from([0xff,0xd8,0xff]));
  const decodedJpeg=await page.evaluate(async body=>{const image=new Image();image.src='data:image/jpeg;base64,'+body;await image.decode();return [image.naturalWidth,image.naturalHeight];},flowJpeg.data);
  expect(decodedJpeg).toEqual([flowJpeg.width,flowJpeg.height]);
  const sourceAfterImage:any=await agent(page,{action:'get_diagram',tabId:state.id,diagramId:flow.id,
    expectedRevision:context.revision,offset:0,limit:12000});
  expect(sourceAfterImage.text).toBe(mermaid);
  expect(await page.locator('.android-reading').evaluate(element=>element.scrollTop)).toBe(before);

  // Let a real CodeMirror keystroke enter the native edit queue, then ask the
  // reader hook to flush that pending transaction before it calculates a new
  // revision and applies the separate agent patch.
  await page.evaluate(value=>window.supermdLoad?.({...value,mode:'editor'}),state);
  const editor=page.locator('.cm-content');await expect(editor).toBeVisible();
  await editor.click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' typed 🧪');
  const typedContent=content+' typed 🧪';
  const afterTyping:any=await agent(page,{action:'read_tab',tabId:state.id,offset:0,limit:100,view:'source',requestId:'flush-pending'});
  expect(afterTyping.text).toBe(Array.from(typedContent).slice(0,100).join(''));
  const patched:any=await agent(page,{action:'patch_tab',tabId:state.id,expectedRevision:afterTyping.revision,
    operations:[{type:'replace',old:'Tail text.',new:'Agent edit.'}],requestId:'agent-patch'});
  expect(patched.changed).toBe(true);
  await expect.poll(()=>page.evaluate(()=>(window as any).__agentNative.content)).toBe(typedContent.replace('Tail text.','Agent edit.'));
  await page.evaluate(()=>window.supermdHistory?.('undo'));
  const onceUndone:any=await agent(page,{action:'read_tab',tabId:state.id,
    offset:Array.from(typedContent).length-40,limit:12000,view:'source',requestId:'undo-agent-edit'});
  expect(onceUndone.text).toBe(Array.from(typedContent).slice(-40).join(''));
  await page.evaluate(()=>window.supermdHistory?.('undo'));
  const twiceUndone:any=await agent(page,{action:'read_tab',tabId:state.id,
    offset:Array.from(content).length-40,limit:12000,view:'source',requestId:'undo-typing'});
  expect(twiceUndone.text).toBe(Array.from(content).slice(-40).join(''));
  expect(await page.evaluate(()=>(window as any).__agentNative.patches.length)).toBeGreaterThanOrEqual(4);
});
