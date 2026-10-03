// Run against `npm run dev`. Uses temporary browser contexts and a generated
// note; never reads or rewrites personal notes or the installed app's state.
import {chromium} from 'playwright';
const content=Array.from({length:1000},(_,i)=>`## Chapter ${i}\n\n${'Readable **study text** with a reference. '.repeat(4)} $x_${i}=\\frac{a+b}{c+d}$\n\n$$\\int_0^1 x^2 dx=\\frac13$$\n\n`).join('');
const browser=await chromium.launch();
try {
  for(const windowed of [false,true]) {
    const context=await browser.newContext({viewport:{width:1200,height:900}}),page=await context.newPage();
    await page.addInitScript(windowed=>{window.SuperMD={post:()=>{}};if(!windowed)window.IntersectionObserver=undefined;},windowed);
    await page.goto('http://127.0.0.1:1420/android-reader.html');const client=await context.newCDPSession(page);await client.send('Performance.enable');
    const start=performance.now();await page.evaluate(content=>window.supermdLoad({id:'benchmark',content,path:null,mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100}),content);
    await page.locator('.katex').first().waitFor();await page.evaluate(()=>document.fonts.ready);const firstPaintMs=performance.now()-start;
    await client.send('HeapProfiler.collectGarbage');
    const metrics=await client.send('Performance.getMetrics'),dom=await client.send('Memory.getDOMCounters');
    const zoom=await page.evaluate(async()=>{const times=[];for(let i=0;i<60;i++){const t=performance.now();window.supermdSetZoom(100+i);times.push(performance.now()-t);await new Promise(requestAnimationFrame);}return times.sort((a,b)=>a-b)[56];});
    console.log(JSON.stringify({windowed,sourceBytes:Buffer.byteLength(content),firstPaintMs:Math.round(firstPaintMs),math:await page.locator('.katex').count(),domNodes:dom.nodes,jsHeapBytes:metrics.metrics.find(m=>m.name==='JSHeapUsedSize').value,zoomCallP95Ms:Number(zoom.toFixed(2))}));
    await context.close();
  }
} finally {await browser.close();}
