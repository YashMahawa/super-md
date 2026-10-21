import {test,expect} from '@playwright/test';

const rows=Array.from({length:1000},(_,i)=>`| ${i} | TABLE-END-${String(i).padStart(3,'0')} ${'generated table detail '.repeat(5)} |`).join('\n');
const tableNote=`# Large table\n\n| Index | Entry |\n| --- | --- |\n${rows}\n`;
const listNote=`# Large list\n\n${Array.from({length:1000},(_,i)=>`- LIST-END-${String(i).padStart(3,'0')} ${'generated list detail '.repeat(5)}`).join('\n')}\n`;
const pythonLines=Array.from({length:1000},(_,i)=>`# ${i===999?'PYTHON-END-999':`PYTHON-${String(i).padStart(3,'0')}`} ${'x'.repeat(70)}`);
const pythonSource=pythonLines.join('\n');
const pythonNote=`# Large Python source\n\n\`\`\`python\n${pythonSource}\n\`\`\`\n`;

async function loadSyntheticNote(page:any,id:string,content:string){
  await page.addInitScript(()=>{
    (window as any).pythonRuns=0;
    window.SuperMD={post:async(id:string,command:string,raw:string)=>{
      if(command==='run_python')(window as any).pythonRuns++;
      await (window as any).captureNativeReply(id,command,raw);
    }};
  });
  await page.exposeFunction('captureNativeReply',async(id:string,command:string,raw:string)=>{
    // Every bridge call is answered locally. The synthetic Python cell is never
    // executed; its cache lookup simply returns no prior result.
    const result=command==='load_python_output'?null:true;
    await page.evaluate(({id,result})=>(window as any).supermdReply?.(id,result,null),{id,result});
  });
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>(window as any).supermdLoad instanceof Function);
  await page.evaluate(state=>(window as any).supermdLoad?.(state),{
    id,content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100
  });
  await expect(page.locator('.markdown-body')).not.toBeEmpty();
}

async function changeThemeAndZoom(page:any,id:string,content:string){
  await page.evaluate(state=>(window as any).supermdLoad?.(state),{
    id,content,path:null,mode:'reader',dark:true,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.evaluate(()=>(window as any).supermdSetZoom?.(125));
  await expect(page.locator('.document-page')).toHaveAttribute('data-scale','1.25');
}

async function findDistantText(page:any,marker:string){
  await page.evaluate(()=>(window as any).supermdFind?.());
  await page.getByRole('searchbox',{name:'Find in note'}).fill(marker);
  await expect(page.locator('.reading-search output')).toHaveText('0 / 1');
  await page.getByRole('button',{name:'Next match',exact:true}).click();
  await expect(page.locator('.reading-search output')).toHaveText('1 / 1');
}

test('a single oversized table retains every row, semantics and distant search through theme and zoom',async({page})=>{
  expect(Buffer.byteLength(tableNote)).toBeGreaterThan(80_000);
  await loadSyntheticNote(page,'oversized-table',tableNote);
  const table=page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(1000);
  await expect(table.getByRole('row').last()).toContainText('TABLE-END-999');
  await changeThemeAndZoom(page,'oversized-table',tableNote);
  await expect(table.locator('tbody tr')).toHaveCount(1000);
  await findDistantText(page,'TABLE-END-999');
  await expect(table.getByRole('row').last()).toContainText('TABLE-END-999');
  await expect(table.getByRole('row').last()).toBeInViewport();
});

test('a single oversized list retains every list item, semantics and distant search through theme and zoom',async({page})=>{
  expect(Buffer.byteLength(listNote)).toBeGreaterThan(80_000);
  await loadSyntheticNote(page,'oversized-list',listNote);
  const list=page.getByRole('list');
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(1000);
  await expect(list.getByRole('listitem').last()).toContainText('LIST-END-999');
  await changeThemeAndZoom(page,'oversized-list',listNote);
  await expect(list.getByRole('listitem')).toHaveCount(1000);
  await findDistantText(page,'LIST-END-999');
  await expect(list.getByRole('listitem').last()).toContainText('LIST-END-999');
  await expect(list.getByRole('listitem').last()).toBeInViewport();
});

test('a single oversized Python block preserves its distant source and never executes during rendering',async({page})=>{
  expect(pythonSource.length).toBeGreaterThanOrEqual(80_000);
  await loadSyntheticNote(page,'oversized-python',pythonNote);
  const cell=page.locator('.python-cell'),source=cell.locator('pre[aria-label="Python source"]');
  await expect(cell).toHaveCount(1);
  await expect(source.locator('code')).toHaveText(pythonSource);
  await expect.poll(()=>page.evaluate(()=>(window as any).pythonRuns)).toBe(0);
  await changeThemeAndZoom(page,'oversized-python',pythonNote);
  await expect(source.locator('code')).toHaveText(pythonSource);
  await findDistantText(page,'PYTHON-END-999');
  await expect(source.locator('code')).toHaveText(pythonSource);
  expect(await source.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByText('PYTHON-END-999',{exact:false}).last()).toBeInViewport();
  await expect.poll(()=>page.evaluate(()=>(window as any).pythonRuns)).toBe(0);
});
