import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';

async function setup(page:Page,mode:'editor'|'live'|'reader',latexAutofix?:boolean,content='Start here.'){
  await page.addInitScript(mode=>{
    (window as any).pastedDocument='';(window as any).copiedGuide='';
    if(mode==='reader')Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Exercise native clipboard fallback');}}});
    window.SuperMD={post:(id,command,raw)=>{
      const args=JSON.parse(raw);
      if(command==='document_changed')(window as any).pastedDocument=args.content;
      if(command==='copy_text')(window as any).copiedGuide=args.text;
      queueMicrotask(()=>window.supermdReply?.(id,true,null));
    }};
  },mode);
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(({mode,latexAutofix,content})=>window.supermdLoad?.({id:'paste-test',path:null,content,mode,latexAutofix,dark:true,colors:{surface:'#251c31',text:'#f5eaff',primary:'#e5b0d2'},font:'Manrope',size:16,zoom:100,restorePosition:false}),{mode,latexAutofix,content});
}
async function paste(page:Page,text:string){
  if(await page.evaluate(()=>document.activeElement instanceof HTMLTextAreaElement)){
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    await page.evaluate(text=>navigator.clipboard.writeText(text),text);await page.keyboard.press('Control+v');return;
  }
  await page.evaluate(text=>{const data=new DataTransfer();data.setData('text/plain',text);document.activeElement!.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},text);
}

test('Source paste is unchanged by default; enabling in-place repairs a single undoable paste',async({page})=>{
  await setup(page,'editor');const content=page.locator('.cm-content');await content.click();await page.keyboard.press('Control+End');
  const raw=String.raw`\frac{a}{b}`;
  await paste(page,raw);await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('Start here.'+raw);
  await page.keyboard.press('Control+z');await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('Start here.');
  await page.evaluate(()=>window.supermdLoad?.({id:'paste-test',path:null,content:'Start here.',mode:'editor',latexAutofix:true,dark:true,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false}));
  await paste(page,raw);await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('Start here.$'+raw+'$');
  await page.keyboard.press('Control+z');await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('Start here.');
  await page.keyboard.press('Control+y');await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('Start here.$'+raw+'$');
});

for(const mode of ['editor','live'] as const)test(`paste preserves existing code and math contexts: ${mode}`,async({page})=>{
  const text='```python\nvalue = ""\n```';await setup(page,mode,true,text);
  if(mode==='live'){await page.locator('.live-block').first().dblclick();await page.getByRole('textbox',{name:'Edit Markdown block'}).focus();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('End');}
  else {await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('End');}
  const raw=String.raw`\frac{a}{b}`;
  await paste(page,raw);
  await expect.poll(()=>page.evaluate(()=>(window as any).pastedDocument)).toBe('```python\nvalue = ""'+raw+'\n```');
});

test('Live autofix preserves native textarea undo and renders the repaired formula',async({page})=>{
  await setup(page,'live',true);await page.locator('.live-block').first().dblclick();const area=page.getByRole('textbox',{name:'Edit Markdown block'});await area.focus();await area.press('Control+End');
  const raw=String.raw`\frac{a}{b}`;await paste(page,raw);
  await expect(area).toHaveValue('Start here.$'+raw+'$');
  await area.press('Control+z');await expect(area).toHaveValue('Start here.');
  await area.press('Control+y');await expect(area).toHaveValue('Start here.$'+raw+'$');
  await area.press('Escape');await expect(page.locator('.katex')).toHaveCount(1);
});

test('theme guide renders offline with the active palette, copies all source and owns scrolling/back',async({page})=>{
  await page.setViewportSize({width:1600,height:1000});await setup(page,'reader',false,'# My note\n\n'+('Keep this reading position.\n\n').repeat(150));
  await page.locator('.android-reading').evaluate(el=>el.scrollTop=500);const before=await page.locator('.android-reading').evaluate(el=>el.scrollTop);
  await page.evaluate(()=>window.supermdThemeGuide?.());
  const dialog=page.getByRole('dialog',{name:'Theme styling guide'});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading',{name:'Custom themes',exact:true})).toBeVisible();
  await expect(dialog.locator('table').first()).toBeAttached();await expect(dialog.locator('pre').first()).toBeAttached();
  expect(await dialog.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(37, 28, 49)');
  await page.screenshot({path:'/tmp/supermd-theme-guide-dark.png'});
  await dialog.getByRole('button',{name:'Copy guide',exact:true}).click();
  const guide=readFileSync(new URL('../docs/THEMING.md',import.meta.url),'utf8');
  await expect.poll(()=>page.evaluate(()=>(window as any).copiedGuide)).toBe(guide);
  const scroller=dialog.getByLabel('Theme guide content');
  await scroller.evaluate(el=>{const r=el.getBoundingClientRect();window.supermdNativeWheel?.(0,300,{x:r.left+r.width/2,y:r.top+50},false);});
  await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBeGreaterThan(200);
  expect(await page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBe(before);
  await page.evaluate(()=>window.supermdDismiss?.());await expect(dialog).toHaveCount(0);
  expect(await page.locator('.android-reading').evaluate(el=>el.scrollTop)).toBe(before);
  await page.evaluate(()=>window.supermdThemeGuide?.());await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});

test('theme guide fits a phone in light colours and image drops cannot edit the note',async({page})=>{
  await page.setViewportSize({width:390,height:844});await setup(page,'reader');
  await page.evaluate(()=>window.supermdLoad?.({id:'paste-test',path:null,content:'Start here.',mode:'reader',dark:false,colors:{surface:'#fff8eb',text:'#33232b',primary:'#a33c57'},font:'Manrope',size:16,zoom:100,restorePosition:false}));
  await page.evaluate(()=>window.supermdThemeGuide?.());const dialog=page.getByRole('dialog',{name:'Theme styling guide'});
  await expect(dialog.getByRole('heading',{name:'Custom themes',exact:true})).toBeVisible();
  const bounds=(await dialog.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(390);expect(bounds.y+bounds.height).toBeLessThanOrEqual(844);
  await dialog.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['fake image'],'dropped.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});
  expect(await page.evaluate(()=>(window as any).pastedDocument)).toBe('');
  await page.screenshot({path:'/tmp/supermd-theme-guide-light-phone.png'});
  await dialog.getByRole('button',{name:'Close theme guide'}).click();await expect(dialog).toHaveCount(0);
});
