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
  const snapshotCompute:any=await page.evaluate(({content,tabId,expectedRevision})=>new Promise((resolve,reject)=>{
    const compute=(window as any).supermdAgentCompute;if(typeof compute!=='function'){reject(new Error('Snapshot compute hook is unavailable'));return;}
    compute({action:'patch_tab',content,tabId,expectedRevision,operations:[{type:'replace',old:'Tail text.',new:'Snapshot edit.'}]},(result:unknown,error:string)=>error?reject(new Error(error)):resolve(result));
  }),{content,tabId:'inactive-snapshot',expectedRevision:context.revision});
  expect(snapshotCompute).toMatchObject({changed:true,applied:1,patchedContent:content.replace('Tail text.','Snapshot edit.')});
  expect(await page.evaluate(()=>(window as any).__agentNative.content)).toBe(content);
  const sourceCheckLength=Math.min(6000,context.visibleSource.end-context.visibleSource.start);
  const rangeRead:any=await agent(page,{action:'read_tab',tabId:state.id,offset:context.visibleSource.start,
    limit:sourceCheckLength,view:'source',requestId:'context-source-check'});
  expect(rangeRead.text).toBe(Array.from(content).slice(context.visibleSource.start,context.visibleSource.start+sourceCheckLength).join(''));
  expect(context.visibleSource.text.toLowerCase()).not.toContain('<path id=');
  expect(context.visibleSource.text.includes('flowchart LR')||context.visibleSource.text.includes('[SVG omitted:')).toBe(true);

  const diagrams:any=await agent(page,{action:'list_diagrams',tabId:state.id,requestId:'diagrams'});
  expect(diagrams.diagrams.map((item:any)=>item.kind)).toEqual(['mermaid','svg']);
  const firstDiagramPage:any=await agent(page,{action:'list_diagrams',tabId:state.id,offset:0,limit:1,requestId:'diagrams-page-1'});
  expect(firstDiagramPage).toMatchObject({total:2,nextOffset:1,truncated:true});
  const secondDiagramPage:any=await agent(page,{action:'list_diagrams',tabId:state.id,offset:firstDiagramPage.nextOffset,limit:1,requestId:'diagrams-page-2'});
  expect(secondDiagramPage).toMatchObject({total:2,nextOffset:null,truncated:false});
  expect(secondDiagramPage.diagrams[0].id).toBe(diagrams.diagrams[1].id);
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
  expect(patched.changed).toBe(true);expect(patched.applied).toBe(1);expect(patched.operations).toMatchObject([{operationIndex:0,type:'replace',deltaChars:1}]);
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

test('visible context keeps full document cursors and exact partial selections',async({page})=>{
  const opening='It calculates silhouette only on retained observations.';
  const paragraphs=Array.from({length:55},(_,i)=>`Paragraph ${i}: a separate page of notes with Unicode 🧭 and useful context.`).join('\n\n');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32">'+('<path d="M0 0L1 1"/>'.repeat(20000))+'</svg>';
  const content=`# Start 🧭\n\n${opening}\n\n${paragraphs}\n\n## Artwork\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n## Ending\n\nEnd of document.`;
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(value=>window.supermdLoad?.(value),{id:'agent-context-page',path:null,content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.getByRole('heading',{name:'Start 🧭',exact:true})).toBeVisible();
  await settleReadingScroll(page);
  const selected=await page.getByText(opening,{exact:true}).evaluate(element=>{
    const node=element.firstChild!,range=document.createRange();range.setStart(node,7);range.setEnd(node,24);
    const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);return selection.toString();
  });
  expect(selected).toBe(opening.slice(7,24));
  const context:any=await agent(page,{action:'get_context',tabId:'agent-context-page'});
  const total=Array.from(content).length;
  expect(context.sourceLength).toBe(total);
  expect(context.visibleSource.total_chars).toBe(total);
  expect(context.visibleSource.end).toBeLessThan(total);
  expect(context.visibleSource.next_offset).toBe(context.visibleSource.end);
  expect(context.visibleSource.truncated).toBe(true);
  expect(context.selection.text).toBe(selected);
  const next:any=await agent(page,{action:'read_tab',tabId:'agent-context-page',view:'source',offset:context.visibleSource.next_offset,limit:120});
  expect(next.start).toBe(context.visibleSource.end);
  expect(next.text).toBe(Array.from(content).slice(next.start,next.end).join(''));
  await page.evaluate(()=>{window.getSelection()?.removeAllRanges();window.supermdHeading?.('ending');});
  const endingHeading=page.getByRole('heading',{name:'Ending',exact:true});
  await expect(endingHeading).toBeVisible();
  await expect(endingHeading).toBeInViewport();
  await expect(page.getByText('End of document.',{exact:true})).toBeInViewport();
  await settleReadingScroll(page);
  const end:any=await agent(page,{action:'get_context',tabId:'agent-context-page'});
  expect(end.visibleSource.total_chars).toBe(total);
  expect(end.visibleSource.end).toBe(total);
  expect(end.visibleSource.next_offset).toBeNull();
  expect(end.visibleSource.truncated).toBe(false);
  expect(end.visibleSource.text).toContain('End of document.');
});

test('heading navigation realigns after delayed layout growth beyond a windowed SVG',async({page})=>{
  const paragraphs=Array.from({length:65},(_,index)=>`Paragraph ${index}: notes before the oversized drawing.\n\n`).join(''),
    svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32">'+('<path d="M0 0L1 1"/>'.repeat(10_000))+'</svg>',
    content=`# Start\n\n${paragraphs}## Artwork\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n## Ending\n\nFinal paragraph.`;
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(value=>window.supermdLoad?.(value),{id:'delayed-svg-heading-navigation',path:null,content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.getByRole('heading',{name:'Start',exact:true})).toBeVisible();
  const ending=page.getByRole('heading',{name:'Ending',exact:true});
  await page.evaluate(()=>window.supermdHeading?.('ending'));
  await expect(ending).toBeInViewport();
  // Simulate a late media/layout resize after the first heading alignment.
  // Keep it outside the old short settle window so the navigation observer
  // must still be active when the page grows.
  await page.waitForTimeout(1500);
  await page.locator('#artwork').evaluate(element=>{(element as HTMLElement).style.marginBottom='1400px';});
  await expect(ending).toBeInViewport({timeout:5000});
  await expect(page.getByText('Final paragraph.',{exact:true})).toBeInViewport();
});

test('slow mouse drags keep selecting source, reader and live text after a prior selection',async({page})=>{
  // Performs 9 full /android-reader.html navigations and 18 multi-step mouse drags across modes and zoom levels.
  test.setTimeout(180_000);
  const first='The first realistic mouse drag should select this complete sentence.',
    second='A later drag must keep extending selection instead of stopping after a character.',
    paragraphs=Array.from({length:78},(_,index)=>index===2?first:index===6?second:`Paragraph ${index}: mixed Markdown with **bold**, a [link](https://example.org), inline $x^2$, and enough useful words to fill a realistic note.`),
    content=`# Mouse selection 🧭\n\n${paragraphs.join('\n\n')}\n\n\`\`\`ts\nconst source = "selection spans CodeMirror text";\n\`\`\`\n`;
  await page.setViewportSize({width:2182,height:1164});
  await page.addInitScript(()=>{document.documentElement.dataset.host='qt';});
  for(const mode of ['editor','reader','live'] as const)for(const zoom of [40,95.59963715447921,300]){
    await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
    await page.evaluate(({content,mode,zoom})=>window.supermdLoad?.({id:`mouse-selection-${mode}-${zoom}`,path:null,content,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false}),{content,mode,zoom});
    const editor=page.locator('.cm-editor'),source=page.locator('.android-source');
    const rendered=page.locator('.android-reading .markdown-body');
    if(mode==='editor')await expect(editor).toBeVisible();else await expect(rendered).toBeVisible();
    await page.evaluate(zoom=>window.supermdSetZoom?.(zoom),zoom);
    if(mode==='editor')await expect.poll(()=>source.evaluate(element=>getComputedStyle(element).getPropertyValue('--workspace-scale').trim())).toBe(String(zoom/100));
    else await expect.poll(()=>page.locator('.document-page').getAttribute('data-scale')).toBe(String(zoom/100));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const dragSelect=async(text:string)=>{
      const lineElement=mode==='editor'?page.locator('.cm-line').filter({hasText:text}).first():rendered.locator('p').filter({hasText:text}).first();
      await expect(lineElement).toBeVisible();await lineElement.scrollIntoViewIfNeeded();
      const points=await lineElement.evaluate((element,text)=>{
        const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
        while(node=walker.nextNode()){
          const value=node.textContent??'',from=value.indexOf(text);if(from<0)continue;
          const aRange=document.createRange(),bRange=document.createRange();aRange.setStart(node,from);aRange.setEnd(node,from+1);bRange.setStart(node,from+text.length-1);bRange.setEnd(node,from+text.length);
          const a=aRange.getBoundingClientRect(),b=bRange.getBoundingClientRect();return {start:{x:a.left+a.width/2,y:a.top+a.height/2},end:{x:b.right+1,y:b.top+b.height/2}};
        }
        return null;
      },text);
      expect(points,`text hit coordinates for ${mode} at ${zoom}%`).not.toBeNull();
      await page.mouse.move(points!.start.x,points!.start.y);await page.mouse.down();
      for(let step=1;step<=18;step++){
        const fraction=step/18;await page.mouse.move(points!.start.x+(points!.end.x-points!.start.x)*fraction,points!.start.y+(points!.end.y-points!.start.y)*fraction);
        await page.waitForTimeout(18);
      }
      await page.mouse.up();await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain(text);
    };
    await dragSelect(first);
    // Keep the first selection when beginning the second physical drag; a
    // stale selection must not turn the new gesture into a text drag operation.
    await dragSelect(second);
  }
});

test('long-held outside release keeps later mouse selections active at fractional zoom',async({page})=>{
  // Performs 4 full /android-reader.html navigations plus ~19.4s of intentional hold/step delays across 4 modes.
  test.setTimeout(180_000);
  const first='The first drag waits before moving and must still select this whole sentence.',
    second='The next drag releases outside the window before another selection starts.',
    third='The final drag checks that native release cleanup did not strand the pointer.',
    paragraphs=Array.from({length:70},(_,index)=>index===2?third:index===4?second:index===6?first:`Paragraph ${index}: realistic mixed Markdown with **bold**, a [link](https://example.org), inline $x^2$, and useful note text.`),
    content=`# Gesture lifecycle 🧭\n\n${paragraphs.join('\n\n')}\n\n\`\`\`ts\nconst source = "selection remains available";\n\`\`\`\n`,
    zoom=95.59963715447921;
  await page.setViewportSize({width:2182,height:1164});await page.addInitScript(()=>{document.documentElement.dataset.host='qt';});
  for(const mode of ['editor','reader','split','live'] as const){
    await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
    const state={id:`gesture-lifecycle-${mode}`,path:null,content,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false};
    await page.evaluate(value=>window.supermdLoad?.(value),state);
    const editor=page.locator('.cm-editor'),source=page.locator('.android-source'),rendered=page.locator('.android-reading .markdown-body');
    if(mode==='editor')await expect(editor).toBeVisible();else await expect(rendered).toBeVisible();
    await page.evaluate(value=>window.supermdSetZoom?.(value),zoom);
    if(mode==='editor')await expect.poll(()=>source.evaluate(element=>getComputedStyle(element).getPropertyValue('--workspace-scale').trim())).toBe(String(zoom/100));
    else await expect.poll(()=>page.locator('.document-page').getAttribute('data-scale')).toBe(String(zoom/100));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const pointsFor=async(text:string)=>{
      const locator=mode==='editor'?page.locator('.cm-line').filter({hasText:text}).first():rendered.locator('p').filter({hasText:text}).first();
      await expect(locator).toBeVisible();await locator.scrollIntoViewIfNeeded();
      const points=await locator.evaluate((element,text)=>{
        const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
        while(node=walker.nextNode()){
          const value=node.textContent??'',from=value.indexOf(text);if(from<0)continue;
          const aRange=document.createRange(),bRange=document.createRange();aRange.setStart(node,from);aRange.setEnd(node,from+1);bRange.setStart(node,from+text.length-1);bRange.setEnd(node,from+text.length);
          const a=aRange.getBoundingClientRect(),b=bRange.getBoundingClientRect();return {start:{x:a.left+a.width/2,y:a.top+a.height/2},end:{x:b.right+1,y:b.top+b.height/2}};
        }
        return null;
      },text);
      expect(points,`text hit coordinates for ${mode}`).not.toBeNull();return points!;
    };
    const slowDrag=async(points:{start:{x:number;y:number};end:{x:number;y:number}},holdMs=0,releaseOutside=false)=>{
      await page.mouse.move(points.start.x,points.start.y);await page.mouse.down();if(holdMs)await page.waitForTimeout(holdMs);
      // A same-document native snapshot echo while the mouse is held must not
      // remount the editor or replace the reader selection target.
      await page.evaluate(value=>window.supermdLoad?.({...value,contentUnchanged:true}),state);
      for(let step=1;step<=30;step++){
        const fraction=step/30;await page.mouse.move(points.start.x+(points.end.x-points.start.x)*fraction,points.start.y+(points.end.y-points.start.y)*fraction);await page.waitForTimeout(40);
      }
      // Exit horizontally at the current row. A diagonal move into the
      // bottom-right browser edge triggers native page auto-scroll and pushes
      // the next target against the top edge, conflating two gestures.
      if(releaseOutside){await page.mouse.move(await page.evaluate(()=>window.innerWidth+8),points.end.y);await page.waitForTimeout(50);}
      await page.mouse.up();
    };
    await slowDrag(await pointsFor(first),1200);
    await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain(first);
    const outsidePoints=await pointsFor(second);
    // A click outside the old selection makes this a fresh text drag rather
    // than the platform's native selected-text move gesture.
    await page.mouse.click(outsidePoints.start.x,outsidePoints.start.y);await page.evaluate(()=>window.getSelection()?.removeAllRanges());
    await slowDrag(outsidePoints,0,true);await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain(second);
    // The final target is before the range extended by the outside release.
    await slowDrag(await pointsFor(third));await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain(third);
  }
});

test('mode switches after fractional zoom still allow a fresh drag selection',async({page})=>{
  const sentence='Mouse selection remains available after switching reader modes.',
    content=`# Mode switch check\n\n${sentence}\n\n\`\`\`ts\nconst source = "mode switch";\n\`\`\`\n`,zoom=95.59963715447921;
  await page.setViewportSize({width:2182,height:1164});await page.addInitScript(()=>{document.documentElement.dataset.host='qt';});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  for(const mode of ['editor','reader','split','live'] as const){
    const state={id:'mode-switch-selection',path:null,content,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false};
    await page.evaluate(value=>window.supermdLoad?.(value),state);await page.evaluate(value=>window.supermdSetZoom?.(value),zoom);
    const rendered=page.locator('.android-reading .markdown-body');
    const locator=mode==='editor'?page.locator('.cm-line').filter({hasText:sentence}).first():rendered.locator('p').filter({hasText:sentence}).first();
    await expect(locator).toBeVisible();await locator.scrollIntoViewIfNeeded();
    const points=await locator.evaluate((element,text)=>{
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
      while(node=walker.nextNode()){
        const value=node.textContent??'',from=value.indexOf(text);if(from<0)continue;
        const aRange=document.createRange(),bRange=document.createRange();aRange.setStart(node,from);aRange.setEnd(node,from+1);bRange.setStart(node,from+text.length-1);bRange.setEnd(node,from+text.length);
        const a=aRange.getBoundingClientRect(),b=bRange.getBoundingClientRect();return {start:{x:a.left+a.width/2,y:a.top+a.height/2},end:{x:b.right+1,y:b.top+b.height/2}};
      }
      return null;
    },sentence);
    expect(points).not.toBeNull();await page.mouse.move(points!.start.x,points!.start.y);await page.mouse.down();
    for(let step=1;step<=24;step++){
      const fraction=step/24;await page.mouse.move(points!.start.x+(points!.end.x-points!.start.x)*fraction,points!.start.y+(points!.end.y-points!.start.y)*fraction);await page.waitForTimeout(20);
    }
    await page.mouse.up();await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString()??'')).toContain(sentence);
    await page.evaluate(()=>window.getSelection()?.removeAllRanges());
  }
});

test('reader hook paginates outline pages and repeated selected-section source pages',async({page})=>{
  const body='Long selected body 🧭 continues across source pages.\n'.repeat(360),
    trailing=Array.from({length:84},(_,index)=>`# Appendix ${index}\nAppendix text ${index}.\n`).join('\n'),
    content=`# Introduction\n\n## Long Section\n${body}\n## Following Section\nDo not leak this text.\n\n${trailing}`;
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(value=>window.supermdLoad?.(value),{id:'agent-section-page-e2e',path:null,content,mode:'editor',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.locator('.cm-content')).toBeVisible();
  const outline:any=await agent(page,{action:'outline_tab',tabId:'agent-section-page-e2e',offset:0,limit:80});
  expect(outline).toMatchObject({offset:0,total:87,nextOffset:80,truncated:true,documentLength:Array.from(content).length});
  expect(outline.headings).toHaveLength(80);
  const outlineEnd:any=await agent(page,{action:'outline_tab',tabId:'agent-section-page-e2e',offset:outline.nextOffset,limit:80});
  expect(outlineEnd).toMatchObject({offset:80,total:87,nextOffset:null,truncated:false});
  expect(outlineEnd.headings.map((heading:any)=>heading.title)).toEqual(['Appendix 77','Appendix 78','Appendix 79','Appendix 80','Appendix 81','Appendix 82','Appendix 83']);
  let pageResult:any=await agent(page,{action:'read_tab',tabId:'agent-section-page-e2e',heading:'Long Section',view:'source',offset:0,limit:12000});
  expect(pageResult).toMatchObject({sectionStart:Array.from(content.slice(0,content.indexOf('## Long Section'))).length,documentLength:Array.from(content).length,truncated:true});
  let combined=pageResult.text;
  while(pageResult.next_offset!==null){pageResult=await agent(page,{action:'read_tab',tabId:'agent-section-page-e2e',heading:'Long Section',view:'source',offset:pageResult.next_offset,limit:12000});combined+=pageResult.text;}
  expect(combined).toBe(Array.from(content).slice(outline.headings[1].sectionStart,outline.headings[2].sectionStart).join(''));
  expect(combined).toContain('Long selected body 🧭');expect(combined).not.toContain('Do not leak this text.');
});

test('section export prepares MD, SMD and PDF with only selected text and needed external references',async({page})=>{
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a44kAAAAASUVORK5CYII=';
  const content='[photo]: https://example.test/photo.png\n[spec]: https://example.test/spec\n[unused]: https://example.test/unused.png\n\n# Selected Section\n\nThis text belongs in the export.\n\n![selected photo][photo]\n\n[Read the specification][spec].\n\n# Following Section\n\nThis text must stay out.\n\n'+('A long paragraph that remains in the original note only.\n\n'.repeat(30));
  await page.addInitScript(({initial,imageData})=>{
    const native={content:initial,revision:0,exports:[] as any[],fetches:[] as any[]};(window as any).__agentNative=native;
    window.SuperMD={post:(id:string,command:string,raw:string)=>{
      const args=JSON.parse(raw);let result:any=true;
      if(command==='document_sync')result={accepted:args.content===native.content,revision:native.revision};
      else if(command==='document_resync'){native.content=args.content;native.revision=0;result={accepted:true,revision:0};}
      else if(command==='fetch_resource'){native.fetches.push(args);result={body:imageData};}
      else if(command==='load_asset')result=imageData;
      else if(command==='agent_export_native'){native.exports.push(args);result={accepted:true,jobId:String(args.requestId)};}
      window.setTimeout(()=>window.supermdReply?.(id,result,null),0);
    }};
  },{initial:content,imageData:image});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(value=>window.supermdLoad?.(value),{id:'agent-section-export-e2e',path:'/tmp/section-export.md',content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.getByRole('heading',{name:'Selected Section',exact:true})).toBeVisible();
  const before=await agent(page,{action:'get_context',tabId:'agent-section-export-e2e'});
  const reading=page.locator('.android-reading');await reading.evaluate(element=>{element.scrollTop=100;});
  await page.waitForTimeout(50);
  const scrollBefore=await reading.evaluate(element=>element.scrollTop),focusBefore=await page.evaluate(()=>document.activeElement?.tagName||null);
  for(const format of ['md','smd','pdf'] as const){
    const result:any=await agent(page,{action:'export_document',tabId:'agent-section-export-e2e',format,filename:`selected.${format}`,requestId:`export-${format}`,
      options:{section:'Selected Section',pageSize:'a4',fontSize:12,margin:10}});
    expect(result).toMatchObject({accepted:true,jobId:`export-${format}`,sectionStart:Array.from(content.slice(0,content.indexOf('# Selected Section'))).length,documentLength:Array.from(content).length});
    const call=await page.evaluate(format=>(window as any).__agentNative.exports.find((entry:any)=>entry.format===format),format);
    expect(call).toMatchObject({id:'agent-section-export-e2e',expectedRevision:(before as any).revision,format,filename:`selected.${format}`,requestId:`export-${format}`,options:{pageSize:'a4',fontSize:12,margin:10}});
    expect(call.options).not.toHaveProperty('section');
    expect(call.content).toContain('This text belongs in the export.');expect(call.content).toContain('Read the specification');
    expect(call.content).not.toContain('This text must stay out.');
    if(format==='md'){
      expect(call.content).toContain('![selected photo][photo]');expect(call.content).toContain('[photo]: https://example.test/photo.png');
      expect(call.content).toContain('[spec]: https://example.test/spec');expect(call.content).not.toContain('[unused]:');
    }else{
      expect(call.content).toContain('[spec]: https://example.test/spec');expect(call.content).not.toContain('[unused]:');
      expect(call.content).toContain('[photo]:');
      expect(Object.keys(call.assets||{}),`${format} should package only the referenced section image`).toHaveLength(1);
      if(format==='pdf')expect(call.content).toMatch(/!\[selected photo\]\(asset-1\.png\)/);
    }
  }
  expect(await page.evaluate(()=>(window as any).__agentNative.content)).toBe(content);
  expect(await reading.evaluate(element=>element.scrollTop)).toBe(scrollBefore);
  expect(await page.evaluate(()=>document.activeElement?.tagName||null)).toBe(focusBefore);
  expect(await page.evaluate(()=>(window as any).__agentNative.fetches.length)).toBe(2);
});

test('FIFO reader queue resolves 8 concurrent agent requests in order and rejects beyond 16 queued items',async({page})=>{
  const content='# Queue concurrency\n\nParagraph zero.\n\n## Section One\n\nParagraph one.\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="8"/></svg>\n```\n';
  await page.addInitScript(initial=>{
    const native={content:initial,revision:0};
    window.SuperMD={post:(id:string,command:string,raw:string)=>{
      const args=JSON.parse(raw);
      let result:any=true,delay=12;
      if(command==='document_sync')result={accepted:args.content===native.content,revision:native.revision};
      else if(command==='document_flushed')delay=18;
      window.setTimeout(()=>window.supermdReply?.(id,result,null),delay);
    }};
  },content);
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const tabId='fifo-queue-e2e';
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:null,content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,editProtocol:1,restorePosition:false});
  await expect(page.getByRole('heading',{name:'Queue concurrency',exact:true})).toBeVisible();

  // Trigger a pending flush boundary via a non-empty edit check, then fire 8 concurrent requests.
  const eightOrder=await page.evaluate(async(id:string)=>{
    const settledOrder:number[]=[];
    const requests=Array.from({length:8},(_,index)=>new Promise<number>((resolve,reject)=>{
      const actions=['get_context','read_tab','outline_tab','list_diagrams'] as const;
      const action=actions[index%actions.length];
      (window as any).supermdAgentRequest({action,tabId:id,requestId:`req-${index}`,...(action==='read_tab'?{offset:0,limit:40}:{})},(result:unknown,error:string)=>{
        if(error){reject(new Error(error));return;}
        if(!result)reject(new Error('Missing result'));
        settledOrder.push(index);
        resolve(index);
      });
    }));
    await Promise.all(requests);
    return settledOrder;
  },tabId);
  expect(eightOrder).toEqual([0,1,2,3,4,5,6,7]);

  // Verify saturation beyond 16 queued items (1 active + 16 queued = 17 accepted, #18 & #19 rejected).
  const saturation=await page.evaluate(async(id:string)=>{
    const outcomes=await Promise.all(Array.from({length:19},(_,index)=>new Promise<{index:number;ok:boolean;error:string}>(resolve=>{
      (window as any).supermdAgentRequest({action:'get_context',tabId:id,requestId:`sat-${index}`},(result:unknown,error:string)=>{
        resolve({index,ok:!error&&!!result,error:error||''});
      });
    })));
    return outcomes;
  },tabId);
  expect(saturation.slice(0,17).every(item=>item.ok)).toBe(true);
  expect(saturation.slice(17).every(item=>!item.ok&&/queue is full/i.test(item.error))).toBe(true);
});

test('executed PythonCell exposes cached SVG/PNG figures and bounded stdout/stderr without running unexecuted cells',async({page})=>{
  const png1x1='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAwMAAAA8B/7k4Z7QAAAAASUVORK5CYII=';
  const svgFig='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#2c6bed"/></svg>').toString('base64');
  const content='# Notebook analysis\n\n```python\nimport matplotlib.pyplot as plt\nprint("epoch=3 loss=0.125")\n```\n\n```python\nraise RuntimeError("unrun cell must never execute")\n```\n';
  await page.addInitScript(({svgData,pngData})=>{
    const tracker={runCalls:[] as string[]};
    (window as any).__pyTracker=tracker;
    window.SuperMD={post:(id:string,command:string,raw:string)=>{
      const args=JSON.parse(raw);
      if(command==='run_python'){
        tracker.runCalls.push(args.code);
        window.setTimeout(()=>window.supermdReply?.(id,{
          ok:true,
          stdout:'epoch=3 loss=0.125\n',
          stderr:'UserWarning: cached stderr detail\n',
          images:[svgData,pngData],
          provenance:{verified:true,document:'/tmp/notebook.md',cell:'0',interpreter:'embedded'},
        },null),10);
        return;
      }
      if(command==='load_python_output'){
        window.setTimeout(()=>window.supermdReply?.(id,null,null),0);
        return;
      }
      if(command==='cache_python_output'){
        window.setTimeout(()=>window.supermdReply?.(id,true,null),0);
        return;
      }
      window.setTimeout(()=>window.supermdReply?.(id,true,null),0);
    }};
  },{svgData:svgFig,pngData:png1x1});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const tabId='python-figures-e2e';
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:'/tmp/notebook.md',content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.getByRole('heading',{name:'Notebook analysis',exact:true})).toBeVisible();

  // Before running any cell, inspection must not execute Python and returns 0 figures.
  const beforeRun:any=await agent(page,{action:'list_diagrams',tabId});
  expect(beforeRun.diagrams).toEqual([]);
  expect(await page.evaluate(()=>(window as any).__pyTracker.runCalls)).toEqual([]);

  // Run only the first PythonCell.
  await page.locator('.python-cell .python-run').first().click();
  await expect(page.locator('.python-cell .cell-output').first()).toContainText('epoch=3 loss=0.125');

  const listed:any=await agent(page,{action:'list_diagrams',tabId});
  expect(listed.diagrams.map((d:any)=>d.id)).toEqual(['diagram:python:21:0','diagram:python:21:1']);
  expect(listed.diagrams.map((d:any)=>d.kind)).toEqual(['python-figure','python-figure']);
  expect(JSON.stringify(listed.diagrams)).not.toContain('base64,');

  const svgRendered:any=await agent(page,{action:'get_diagram_image',tabId,diagramId:'diagram:python:21:0',expectedRevision:listed.revision,width:400});
  expect(svgRendered.mime_type).toBe('image/png');
  expect(svgRendered.width).toBeGreaterThan(0);

  const pngRendered:any=await agent(page,{action:'get_diagram_image',tabId,diagramId:'diagram:python:21:1',expectedRevision:listed.revision,width:400});
  expect(pngRendered.mime_type).toBe('image/png');
  expect(pngRendered.width).toBeGreaterThan(0);

  const ctx:any=await agent(page,{action:'get_context',tabId});
  expect(ctx.pythonCells).toHaveLength(1);
  expect(ctx.pythonCells[0]).toMatchObject({
    ordinal:0,
    ok:true,
    stdout:'epoch=3 loss=0.125\n',
    stderr:'UserWarning: cached stderr detail\n',
    figureIds:['diagram:python:21:0','diagram:python:21:1'],
  });
  expect(ctx.diagrams.map((d:any)=>d.id)).toEqual(['diagram:python:21:0','diagram:python:21:1']);
  // Confirm the second unrun cell was NEVER executed by any inspection call!
  expect(await page.evaluate(()=>(window as any).__pyTracker.runCalls)).toEqual(['import matplotlib.pyplot as plt\nprint("epoch=3 loss=0.125")']);
});

test('StepCards step 3 and portaled .step-viewer report activeStep, stepIndex 2, and visible slide notes',async({page})=>{
  const deck={
    title:'Gradient Descent',
    steps:[
      {label:'Initialize weights',diagram:{width:180,height:100,nodes:[{id:'w0',label:'w0',x:90,y:50}],edges:[]},markdown:'Start at random initial parameters.'},
      {label:'Compute gradient',diagram:{width:180,height:100,nodes:[{id:'g',label:'grad',x:90,y:50}],edges:[]},markdown:'Evaluate the local slope of the loss.'},
      {label:'Converge at minimum',diagram:{width:180,height:100,nodes:[{id:'min',label:'w*',x:90,y:50}],edges:[]},markdown:'Step size shrinks as gradients approach zero.'},
    ],
  };
  const content=`# Optimization Deck\n\n\`\`\`smd-steps\n${JSON.stringify(deck)}\n\`\`\`\n`;
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const tabId='step-viewer-portal-e2e';
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:null,content,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.locator('.step-cards')).toBeVisible();

  // Advance to step 3 (0-based stepIndex: 2).
  await page.getByRole('button',{name:'Next step'}).click();
  await page.getByRole('button',{name:'Next step'}).click();
  await expect(page.locator('.step-cards')).toHaveAttribute('data-deck-title','Gradient Descent');
  await expect(page.locator('.step-cards')).toHaveAttribute('data-step-index','2');
  await expect(page.locator('.step-cards')).toHaveAttribute('data-step-label','Converge at minimum');

  // Open enlarged .step-viewer portal on document.body.
  await page.getByRole('button',{name:'Enlarge slide'}).click();
  await expect(page.locator('.step-viewer')).toBeVisible();

  const ctx:any=await agent(page,{action:'get_context',tabId});
  expect(ctx.activeStep).toMatchObject({
    deckTitle:'Gradient Descent',
    stepLabel:'Converge at minimum',
    stepIndex:2,
    stepCount:3,
    activeStep:true,
    expanded:true,
  });
  const activeDiagram=ctx.diagrams.find((d:any)=>d.activeStep===true);
  expect(activeDiagram).toMatchObject({
    deckTitle:'Gradient Descent',
    stepLabel:'Converge at minimum',
    stepIndex:2,
    stepCount:3,
    activeStep:true,
  });
  expect(ctx.reading.visibleText).toContain('Converge at minimum');
  expect(ctx.reading.visibleText).toContain('Step size shrinks as gradients approach zero.');
});

test('get_context reads visible text, reading.offset, and active selection across editor, split, and live textarea modes',async({page})=>{
  const content='# Architecture Guide\n\nFirst paragraph in the guide.\n\n## Core Pipeline\n\nTarget phrase for mode-aware selection checks.\n\nFinal summary paragraph.\n';
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const tabId='mode-aware-context-e2e';

  // 1. Source (editor) mode
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:null,content,mode:'editor',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.locator('.cm-content')).toBeVisible();
  const targetStart=content.indexOf('mode-aware selection'),targetEnd=targetStart+'mode-aware selection'.length;
  await page.evaluate(({from,to})=>{
    window.dispatchEvent(new CustomEvent('supermd-editor-goto',{detail:from}));
    // Select exact range via editorFindRange-compatible dispatch on focused editor
    const cmContent=document.querySelector('.cm-content') as HTMLElement|null;
    cmContent?.focus();
    const walker=document.createTreeWalker(cmContent!,NodeFilter.SHOW_TEXT);
    let node:Node|null;
    while(node=walker.nextNode()){
      const txt=node.textContent??'',idx=txt.indexOf('mode-aware selection');
      if(idx>=0){
        const r=document.createRange();r.setStart(node,idx);r.setEnd(node,idx+'mode-aware selection'.length);
        const sel=window.getSelection()!;sel.removeAllRanges();sel.addRange(r);
        break;
      }
    }
    void to;
  },{from:targetStart,to:targetEnd});
  await page.waitForTimeout(50);
  const editorCtx:any=await agent(page,{action:'get_context',tabId});
  expect(editorCtx.mode).toBe('editor');
  expect(editorCtx.reading.visibleText.length).toBeGreaterThan(0);
  expect(editorCtx.reading.visibleText).toContain('Core Pipeline');
  expect(editorCtx.reading.offset).toBeGreaterThanOrEqual(0);
  expect(editorCtx.selection.text).toBe('mode-aware selection');

  // 2. Split mode: reads .android-reading prose AND CodeMirror selection
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:null,content,mode:'split',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  await expect(page.locator('.android-reading .markdown-body')).toBeVisible();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.evaluate(()=>{
    const cmContent=document.querySelector('.cm-content') as HTMLElement|null;
    cmContent?.focus();
    const walker=document.createTreeWalker(cmContent!,NodeFilter.SHOW_TEXT);
    let node:Node|null;
    while(node=walker.nextNode()){
      const txt=node.textContent??'',idx=txt.indexOf('Core Pipeline');
      if(idx>=0){
        const r=document.createRange();r.setStart(node,idx);r.setEnd(node,idx+'Core Pipeline'.length);
        const sel=window.getSelection()!;sel.removeAllRanges();sel.addRange(r);
        break;
      }
    }
  });
  await page.waitForTimeout(50);
  const splitCtx:any=await agent(page,{action:'get_context',tabId});
  expect(splitCtx.mode).toBe('split');
  expect(splitCtx.reading.visibleText).toContain('Target phrase for mode-aware selection checks.');
  expect(splitCtx.selection.text).toBe('Core Pipeline');

  // 3. Live mode with mounted <textarea> selection
  await page.evaluate(value=>window.supermdLoad?.(value),{id:tabId,path:null,content,mode:'live',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false});
  const liveParagraph=page.locator('.live-block').filter({hasText:'Target phrase for mode-aware selection checks.'}).first();
  await expect(liveParagraph).toBeVisible();
  await liveParagraph.dblclick();
  const textarea=page.locator('.live-active-block textarea');
  await expect(textarea).toBeVisible();
  await textarea.evaluate(el=>{
    const ta=el as HTMLTextAreaElement;
    const from=ta.value.indexOf('Target phrase'),to=from+'Target phrase'.length;
    ta.focus();
    ta.setSelectionRange(from,to);
  });
  const liveCtx:any=await agent(page,{action:'get_context',tabId});
  expect(liveCtx.mode).toBe('live');
  expect(liveCtx.reading.visibleText).toContain('Target phrase for mode-aware selection checks.');
  expect(liveCtx.reading.offset).toBe(Array.from(content.slice(0,content.indexOf('Target phrase'))).length);
  expect(liveCtx.selection.text).toBe('Target phrase');
});
