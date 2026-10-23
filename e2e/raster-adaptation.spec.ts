import {test,expect} from '@playwright/test';

test('auto adaptation removes white-matte fringes while retaining colour hue and source alpha',async({page})=>{
  await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;
    const c=canvas.getContext('2d')!;c.fillStyle='white';c.fillRect(0,0,40,40);
    // Pale blue anti-aliasing around an authored blue plot line on white paper.
    c.fillStyle='rgb(235,243,250)';c.fillRect(20,0,1,40);
    c.fillStyle='rgb(35,102,178)';c.fillRect(21,0,3,40);
    c.fillStyle='rgba(35,102,178,.5)';c.fillRect(60,0,10,40);
    window.supermdLoad!({id:'raster-edges',path:null,content:`![Plot](${canvas.toDataURL()})`,mode:'reader',dark:true,colors:{surface:'#190e08',text:'#f9e1d2',primary:'#ffb17c'},font:'Manrope',size:16,zoom:100,imageAppearance:'auto'});
  });
  const image=page.getByRole('img',{name:'Plot'});
  await expect(image).toBeVisible();await image.evaluate(async(i)=>{
    const img=i as HTMLImageElement;await img.decode();
    img.style.cssText+=';width:80px;height:40px;max-width:none;min-width:0;border:0;border-radius:0;box-shadow:none;outline:none;margin:0;';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  });
  const bytes=await image.screenshot();
  await test.info().attach('raster-filter-pixels',{body:bytes,contentType:'image/png'});
  const pixels=await page.evaluate(async base64=>{
    const source=await createImageBitmap(await(await fetch('data:image/png;base64,'+base64)).blob());
    const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
    const c=canvas.getContext('2d')!;c.drawImage(source,0,0);
    return [10,20,22,50,65].map(x=>Array.from(c.getImageData(x,20,1,1).data));
  },bytes.toString('base64'));
  for(const [i,value] of [25,14,8].entries())expect(Math.abs(pixels[0][i]-value)).toBeLessThanOrEqual(1);
  expect(Math.max(...pixels[1].slice(0,3))).toBeLessThan(160);
  // Dark-paper adaptation lifts luminance like invert+hue-rotate, retaining
  // channel differences/hue rather than flattening blue into the accent.
  for(const [i,value] of [104,171,247].entries())expect(Math.abs(pixels[2][i]-value)).toBeLessThanOrEqual(2);
  // Transparent source stays transparent; half-alpha source is composited only
  // once instead of gaining an opaque matte or losing coverage a second time.
  for(const [i,value] of [25,14,8].entries())expect(Math.abs(pixels[3][i]-value)).toBeLessThanOrEqual(1);
  for(const [i,value] of [64,93,128].entries())expect(Math.abs(pixels[4][i]-value)).toBeLessThanOrEqual(3);
});
