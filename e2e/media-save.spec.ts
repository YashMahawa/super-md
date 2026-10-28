import {test,expect} from '@playwright/test';
test('media menu exports light PNG and original-colour SVG without editing the note',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).savedMedia=[];(window as any).noteChanges=[];
    window.SuperMD={post:(id,command,args)=>{
      const data=JSON.parse(args);
      if(command==='save_media_native')(window as any).savedMedia.push(data);
      if(command==='document_changed')(window as any).noteChanges.push(data);
      queueMicrotask(()=>window.supermdReply?.(id,command==='save_media_native'?{filename:data.filename}:true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  const content='# Diagram export\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400"><rect x="100" y="100" width="200" height="200" fill="#1688dd"/><path d="M400 100L700 300" stroke="#000" stroke-width="6"/></svg>\n```\n';
  await page.evaluate(content=>window.supermdLoad?.({id:'media-export',path:null,content,mode:'reader',dark:true,fullscreen:false,colors:{surface:'#171017',primary:'#ef99ad',text:'#fff'},font:'Manrope',size:16,zoom:100,svgAppearance:'monochrome'}),content);
  const diagram=page.locator('.svg-diagram');await expect(diagram).toBeVisible();
  await diagram.click({button:'right'});const menu=page.getByRole('menu',{name:'Save image or diagram'});await expect(menu).toBeVisible();
  await menu.getByRole('menuitem',{name:'Save as PNG'}).click();await expect.poll(()=>page.evaluate(()=>(window as any).savedMedia.length)).toBe(1);
  const result=await page.evaluate(async()=>{
    const saved=(window as any).savedMedia[0];const image=new Image();image.src='data:image/png;base64,'+saved.body;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    return {filename:saved.filename,mime:saved.mimeType,corner:[...context.getImageData(2,2,1,1).data],blue:[...context.getImageData(image.width*.25,image.height*.5,1,1).data],changes:(window as any).noteChanges};
  });
  expect(result.filename).toMatch(/\.png$/);expect(result.mime).toBe('image/png');expect(result.corner).toEqual([255,255,255,255]);expect(result.blue).toEqual([22,136,221,255]);expect(result.changes).toEqual([]);
  await page.keyboard.press('Escape');await diagram.click({button:'right'});await menu.getByRole('menuitem',{name:'Save as SVG',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).savedMedia.length)).toBe(2);
  const svg=await page.evaluate(()=>atob((window as any).savedMedia[1].body));expect(svg).toContain('#1688dd');expect(svg).not.toContain('#ef99ad');
  await page.keyboard.press('Escape');
  // Touch-and-hold uses the same menu without activating the image viewer.
  const box=(await diagram.boundingBox())!;
  await diagram.dispatchEvent('pointerdown',{pointerType:'touch',clientX:box.x+box.width/2,clientY:box.y+box.height/2});await page.waitForTimeout(600);await diagram.dispatchEvent('pointerup',{pointerType:'touch'});await expect(menu).toBeVisible();
  await expect(page.getByRole('dialog',{name:'Image viewer'})).toHaveCount(0);
});
