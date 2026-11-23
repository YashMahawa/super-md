import {test,expect} from '@playwright/test';

const vector='<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160" viewBox="0 0 400 160"><rect width="400" height="160" fill="#e6edf6"/><path d="M20 130L110 80L220 110L380 20" fill="none" stroke="#3072b8" stroke-width="3"/><text x="35" y="35" font-size="18">A readable diagram</text></svg>';
const svgUri='data:image/svg+xml;base64,'+Buffer.from(vector).toString('base64');
const icon='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#3072b8"/></svg>').toString('base64');
const sizes=[
  {name:'desktop',width:1920,height:1080,zoom:100},
  {name:'tablet',width:1024,height:768,zoom:100},
  {name:'phone landscape',width:915,height:412,zoom:100},
  {name:'phone portrait',width:412,height:915,zoom:100},
  {name:'desktop magnified',width:1600,height:900,zoom:180},
  {name:'desktop reduced',width:1600,height:900,zoom:40},
];

for(const size of sizes)for(const mode of ['reader','live','split'] as const){
  test(`diagrams fill their column without stretching photos or inline icons: ${size.name}, ${mode}`,async({page})=>{
    await page.setViewportSize({width:size.width,height:size.height});
    await page.addInitScript(svg=>{
      const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;
      const ctx=canvas.getContext('2d')!;ctx.fillStyle='#b7d5c9';ctx.fillRect(0,0,80,40);
      const raster=canvas.toDataURL();
      (window as any).testRaster=raster;
      window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='run_python'?{ok:true,stdout:'',stderr:'',images:[svg,raster]}:null,null))};
    },svgUri);
    await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
    await page.evaluate(({vector,svgUri,icon,mode,size})=>{
      document.documentElement.dataset.platform=size.name.startsWith('phone')||size.name==='tablet'?'android':'desktop';
      document.documentElement.dataset.host=document.documentElement.dataset.platform==='android'?'android':'qt';
      const content=['# Readable figures','```svg\n'+vector+'\n```','![Linked vector]('+svgUri+')','```mermaid\nflowchart LR\nA[Read] --> B[Understand] --> C[Apply]\n```','![Photo]('+(window as any).testRaster+')','An inline icon ![Inline icon]('+icon+') stays small.','```python\nprint("fixture")\n```'].join('\n\n');
      window.supermdLoad?.({id:'responsive-diagrams',content,path:null,mode,dark:false,colors:{},font:'Manrope',size:16,zoom:size.zoom,restorePosition:false});
    },{vector,svgUri,icon,mode,size});
    await expect(page.locator('.mermaid img')).toBeVisible();
    await page.getByRole('button',{name:'Run',exact:true}).click();
    const diagrams=page.locator('.svg-figure img,.media-paragraph .note-image--diagram img,.cell-output > img');
    await expect(diagrams).toHaveCount(5);
    for(const diagram of await diagrams.all()){
      await expect.poll(()=>diagram.evaluate(node=>(node as HTMLImageElement).complete&&node.getBoundingClientRect().height>0)).toBe(true);
      const geometry=await diagram.evaluate(node=>{
        const image=node as HTMLImageElement,container=image.closest('.svg-figure,.media-paragraph,.cell-output')!;
        const box=image.getBoundingClientRect(),parent=container.getBoundingClientRect(),style=getComputedStyle(image),cs=getComputedStyle(container);
        const scale=Number(image.closest<HTMLElement>('.document-page')?.dataset.scale)||1;
        const horizontal=['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'] as const;
        const vertical=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'] as const;
        return {width:box.width,available:parent.width-horizontal.reduce((sum,key)=>sum+parseFloat(cs[key]),0)*scale,
          ratio:(box.width-horizontal.reduce((sum,key)=>sum+parseFloat(style[key]),0)*scale)/(box.height-vertical.reduce((sum,key)=>sum+parseFloat(style[key]),0)*scale),natural:image.naturalWidth/image.naturalHeight};
      });
      expect(Math.abs(geometry.width-geometry.available)).toBeLessThan(2);
      expect(geometry.ratio).toBeCloseTo(geometry.natural,1);
    }
    const photo=page.getByRole('img',{name:'Photo',exact:true}),inline=page.getByRole('img',{name:'Inline icon',exact:true});
    expect(await photo.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThan(85*size.zoom/100);
    expect(await inline.evaluate(node=>node.getBoundingClientRect().width)).toBeLessThan(29*size.zoom/100);
    await page.locator('.mermaid img').click();
    await expect(page.getByRole('dialog',{name:'Image viewer'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog',{name:'Image viewer'})).toHaveCount(0);
  });
}

test('diagram widths follow portrait/landscape changes without replacing the source or overflowing their column',async({page})=>{
  await page.setViewportSize({width:412,height:915});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(vector=>window.supermdLoad?.({id:'rotate-diagram',content:'```svg\n'+vector+'\n```',path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:16,zoom:100,restorePosition:false}),vector);
  const image=page.locator('.svg-diagram');await expect(image).toBeVisible();
  const source=await image.getAttribute('src');
  for(const viewport of [{width:915,height:412},{width:412,height:915}]){
    await page.setViewportSize(viewport);
    await expect.poll(()=>image.evaluate(node=>Math.abs(node.getBoundingClientRect().width-node.parentElement!.getBoundingClientRect().width))).toBeLessThan(2);
    await expect(image).toHaveAttribute('src',source!);
  }
});
