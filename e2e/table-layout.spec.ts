import {expect,test} from '@playwright/test';

const tableMarkdown=String.raw`| Test | Assumptions | Statistic | Degrees of freedom | Decision |
|---|---|---|---|---|
| Goodness-of-Fit (Counts) | $k$ categories, claimed $p_i$, all $E_i\ge5$ | $\chi^2=\sum\frac{(O_i-E_i)^2}{E_i}$ | $\chi^2_{k-1-m}$ | Right-tailed rejection only ($\chi^2>\chi^2_{df,1-\alpha}$) |
| **Independence (Contingency)** | $r\times c$ table, $E_{ij}=\frac{\text{Row}\times\text{Col}}{N}$ | $\chi^2=\sum\sum\dfrac{(O_{ij}-E_{ij})^2}{E_{ij}}$ | $\chi^2_{(r-1)(c-1)}$ | Right-tailed rejection only ($\chi^2>\chi^2_{df,1-\alpha}$) |`;

for(const mode of ['reader','live'] as const)for(const width of [375,520])test(`long labels and math stay inside their table cells in ${mode} at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(({mode,content})=>window.supermdLoad?.({id:`table-overlap-${mode}`,path:null,content,mode,dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100}),{mode,content:tableMarkdown});
  const table=page.locator('.markdown-body table');await expect(table).toBeVisible();
  await expect(table.locator('.katex')).toHaveCount(11);
  const overlaps=await table.evaluate(node=>{
    const offenders:{cell:string;text:string;spill:number}[]=[];
    for(const cell of Array.from(node.querySelectorAll('th,td'))){
      const box=cell.getBoundingClientRect(),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let text:Node|null;
      while((text=walker.nextNode())){
        if(text.parentElement?.closest('.katex-mathml'))continue;
        const range=document.createRange();range.selectNodeContents(text);
        for(const rect of Array.from(range.getClientRects()))if(rect.width>1&&rect.right>box.right+1)offenders.push({cell:cell.textContent?.trim()||'',text:text.textContent||'',spill:rect.right-box.right});
      }
    }
    return offenders;
  });
  expect(overlaps).toEqual([]);
});
