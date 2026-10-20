import {test,expect} from '@playwright/test';

// Authored colours, !important styles and edge halos are common in study notes.
// This is an independent fixture, not a copy of the user's private document.
const diagram=`%%{init: {"theme":"base","themeVariables":{"primaryColor":"#f8fafc","primaryTextColor":"#111827","lineColor":"#737373"},"themeCSS":".edgePaths path {stroke:#737373!important;filter:drop-shadow(1px 0 0 #ffffff)} body {background:#00ff00!important}","flowchart":{"htmlLabels":false}}}%%
flowchart LR
  A["Choose input"] -->|"Continue"| B{"Periodic?"}
  B --> C["Compute spectrum"]
  classDef default fill:#f8fafc,color:#111827,stroke:#374151,stroke-width:2px;
  classDef decision fill:#fef3c7,color:#78350f,stroke:#d97706,stroke-width:2px;
  class B decision;`;

test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:(id,command)=>queueMicrotask(()=>window.supermdReply?.(id,command==='run_python'?{ok:true,stdout:'done',stderr:'',images:['data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="white"/><path d="M5 5L75 35" stroke="black"/></svg>')]}:null,null))};});
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
});

test('Mermaid shares SVG appearance, isolates authored CSS, retains its geometry and opens at full vector quality',async({page})=>{
  const state={id:'diagram-appearance',content:`# An unchanged note\n\n![Photo](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4b8AAAAASUVORK5CYII=)\n\n\`\`\`mermaid\n${diagram}\n\`\`\``,path:null,mode:'reader' as const,dark:true,fullscreen:false,colors:{surface:'#191420',text:'#f3e4ed',primary:'#e3a8c7'},font:'Manrope',size:16,zoom:100,motion:false,imageAppearance:'original' as const,svgAppearance:'contrast' as const};
  await page.evaluate(state=>window.supermdLoad?.(state),state);
  const image=page.locator('.mermaid img'),photo=page.getByRole('img',{name:'Photo'});
  await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(i=>(i as HTMLImageElement).naturalWidth)).toBeGreaterThan(100);
  expect(await image.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
  expect(await image.evaluate(i=>getComputedStyle(i).outlineStyle)).toBe('solid');
  expect(await page.locator('body').evaluate(i=>getComputedStyle(i).backgroundColor)).not.toBe('rgb(0, 255, 0)');
  const original=await image.getAttribute('src');
  const decode=(uri:string)=>decodeURIComponent(uri.slice(uri.indexOf(',')+1));
  const originalRoot=decode(original!).match(/id="smd-diagram-\d+"/)?.[0];
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'auto'}),state);
  await expect(image).toHaveAttribute('data-media-adapted','true');
  const adapted=decode((await image.getAttribute('src'))!);
  expect(adapted).toContain(originalRoot!);expect(adapted).toContain('fill="#191420"');expect(adapted).toContain('stroke="#e3a8c7"');
  expect(adapted).toContain('filter: none');
  expect(await photo.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
  await image.click();await expect(page.getByRole('dialog',{name:'Image viewer'})).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('supermd-image-zoom',{detail:{factor:1.6}})));
  await expect(page.getByLabel('Image zoom')).toHaveText('160%');
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'monochrome'}),state);
  await expect(page.getByLabel('Image zoom')).toHaveText('160%');
  await expect.poll(()=>image.getAttribute('src')).not.toBe('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(adapted));
  expect(await image.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Image viewer'})).toHaveCount(0);
  await page.evaluate(state=>window.supermdLoad?.({...state,svgAppearance:'contrast'}),state);
  await expect(image).toHaveAttribute('src',original!);
});

test('Python SVG output uses diagrams setting while ordinary images remain independent',async({page})=>{
  await page.evaluate(()=>window.supermdLoad?.({id:'python-diagram',path:null,content:'```python\nprint("diagram")\n```',mode:'reader',dark:true,fullscreen:false,colors:{surface:'#191420',text:'#f3e4ed',primary:'#e3a8c7'},font:'Manrope',size:16,zoom:100,imageAppearance:'original',svgAppearance:'auto'}));
  await page.getByRole('button',{name:'Run',exact:true}).click();
  const image=page.getByRole('img',{name:'Python figure 1'});await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('data-media-kind','svg');await expect(image).toHaveAttribute('data-media-adapted','true');
  expect(decodeURIComponent((await image.getAttribute('src'))!)).toContain('stroke="#e3a8c7"');
  expect(await image.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
});

test('interactive charts share diagram colours while retaining selected slider geometry',async({page})=>{
  const spec={x:{min:-3,max:3},series:[{expression:'a*sin(x)'},{expression:'cos(x)',color:'#ff9090'}],sliders:[{name:'a',min:0,max:3,value:1}]};
  const state={id:'themed-chart',path:null,content:'```smd-chart\n'+JSON.stringify(spec)+'\n```',mode:'reader' as const,dark:true,fullscreen:false,colors:{surface:'#191420',text:'#f3e4ed',primary:'#e3a8c7'},font:'Manrope',size:16,zoom:100,motion:false,imageAppearance:'original' as const};
  await page.evaluate(s=>window.supermdLoad?.(s),{...state,svgAppearance:'auto' as const});
  const chart=page.locator('.interactive-chart svg'),curves=chart.locator('.chart-line');
  await expect(curves.first()).toHaveAttribute('stroke','#e3a8c7');await expect(curves.nth(1)).toHaveAttribute('stroke','#ff9090');
  const slider=page.locator('.chart-controls input');await slider.fill('1.68');await expect(slider).toHaveValue('1.68');
  const points=await curves.first().getAttribute('points');
  await page.evaluate(s=>window.supermdLoad?.(s),{...state,svgAppearance:'monochrome' as const});
  await expect(curves.nth(1)).toHaveAttribute('stroke','#e3a8c7');await expect(slider).toHaveValue('1.68');
  expect(await curves.first().getAttribute('points')).toBe(points);expect(await chart.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
  await page.evaluate(s=>window.supermdLoad?.(s),{...state,svgAppearance:'contrast' as const});
  await expect(chart).toHaveCSS('outline-style','solid');await expect(slider).toHaveValue('1.68');
});

for(const [kind,source]of Object.entries({
  sequence:'sequenceDiagram\nAlice->>Bob: Request\nBob-->>Alice: Response',
  state:'stateDiagram-v2\n[*] --> Reading\nReading --> Done: Finish\nDone --> [*]',
  entity:'erDiagram\nSTUDENT ||--o{ NOTE : writes\nNOTE {\n string title\n}',
  pie:'pie title Study time\n "Reading" : 60\n "Practice" : 40',
  mindmap:'mindmap\n  root((Study))\n    Notes\n    Practice',
}))test(`${kind} Mermaid remains a readable, zoomable vector in each appearance mode`,async({page})=>{
  const state={id:'mermaid-matrix',path:null,content:'```mermaid\n'+source+'\n```',mode:'reader' as const,dark:true,fullscreen:false,colors:{surface:'#191420',text:'#f3e4ed',primary:'#e3a8c7'},font:'Manrope',size:16,zoom:100,motion:false,imageAppearance:'original' as const};
  const roots=new Set<string>();
  for(const mode of ['original','auto','monochrome','contrast','invert-dark']as const){
    await page.evaluate(s=>window.supermdLoad?.(s),{...state,svgAppearance:mode});
    const image=page.locator('.mermaid img');await expect(image).toBeVisible();
    await expect(page.locator('.mermaid')).toHaveAttribute('data-render-dark',String(mode==='original'));
    await expect.poll(()=>image.evaluate(i=>(i as HTMLImageElement).naturalWidth)).toBeGreaterThan(50);
    await expect(page.locator('.render-error,.image-error')).toHaveCount(0);
    const source=decodeURIComponent((await image.getAttribute('src'))!.split(',').slice(1).join(','));
    expect(source).toContain('<text');expect(source).not.toContain('<foreignObject');
    if(mode!=='original')roots.add(source.match(/id="smd-diagram-\d+"/)![0]);
    if(mode==='auto'||mode==='monochrome'){
      expect(await image.evaluate(i=>getComputedStyle(i).filter)).toBe('none');
      expect(await image.evaluate(i=>getComputedStyle(i).backgroundColor)).toBe('rgb(25, 20, 32)');
      if(kind==='pie'){
        const fills=await image.evaluate(i=>{const xml=new DOMParser().parseFromString(decodeURIComponent((i as HTMLImageElement).src.split(',').slice(1).join(',')),'image/svg+xml');return {slices:Array.from(xml.querySelectorAll('path.pieCircle'),n=>n.getAttribute('fill')),labels:Array.from(xml.querySelectorAll('text.slice'),n=>n.getAttribute('fill'))};});
        expect(new Set(fills.slices).size).toBe(2);expect(new Set(fills.labels).size).toBe(2);
      }
      if(kind==='entity')expect(source).not.toContain('fill="hsl(0, 0%, 100%)"');
    }
  }
  // Display adjustments must reuse layout rather than invoke Mermaid again.
  expect(roots.size).toBe(1);
  await page.locator('.mermaid img').click();await expect(page.getByRole('dialog',{name:'Image viewer'})).toBeVisible();
});
