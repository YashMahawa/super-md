import {test,expect} from '@playwright/test';

const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="140" viewBox="0 0 320 140"><rect x="6" y="6" width="308" height="128" rx="12" fill="#153d4b" stroke="#73e3e0" stroke-width="6"/><text x="160" y="82" text-anchor="middle" fill="white" font-family="sans-serif" font-size="36">Large visual</text></svg>').toString('base64');
const deck={title:'Shared filter',steps:[{label:'First position',image},{label:'Second position',image},{label:'Result',image,markdown:'**Output**\n\n$$y=3$$'}]};
async function load(page:import('@playwright/test').Page,value=deck){
 await page.addInitScript(()=>{window.SuperMD={post:id=>queueMicrotask(()=>window.supermdReply?.(id,true,null))};});
 await page.goto('/android-reader.html');await page.waitForFunction(()=>!!window.supermdLoad);
 await page.evaluate(content=>window.supermdLoad?.({id:'fit',content,path:null,mode:'reader',dark:false,colors:{},font:'Manrope',size:18,zoom:100}),'```smd-steps\n'+JSON.stringify(value)+'\n```');
 await expect(page.locator('.step-cards-figure.is-current img')).toBeVisible();
}
for(const [width,height] of [[2448,1378],[1600,1000],[915,412],[412,915]])test(`visual fills its fitted card and expands with arrow navigation ${width}`,async({page})=>{
 await page.setViewportSize({width,height});await load(page);
 const card=page.locator('.step-cards');
 await expect.poll(async()=>card.locator('.step-cards-figure-stack').evaluate(el=>Math.abs(el.clientWidth/el.clientHeight-320/140))).toBeLessThan(.03);
 const picture=(await card.locator('.step-cards-figure.is-current img').boundingBox())!;
 const stage=(await card.locator('.step-cards-figure-stack').boundingBox())!;
 expect(picture.width).toBeGreaterThan(stage.width*.98);
 expect(picture.height).toBeGreaterThan(stage.height*.98);
 const bounds=(await card.boundingBox())!;
 expect(bounds.height-stage.height).toBeLessThan(width>700?90:130);
 await expect(card.locator('.step-cards-controls')).not.toContainText('First position');
 await expect(page.locator('.image-options')).toHaveCount(0);
 await card.locator('.step-cards-figure.is-current img').click();
 const viewer=page.getByRole('dialog',{name:'Slide viewer'});await expect(viewer).toBeVisible();
 await page.keyboard.press('ArrowRight');await expect(viewer.locator('.step-cards-step-title')).toHaveText('Second position');
 await page.keyboard.press('ArrowRight');await expect(viewer.locator('.katex')).toBeVisible();
 await expect(viewer.locator('.step-cards-step-title')).toHaveText('Result');
 await page.keyboard.press('ArrowLeft');await expect(viewer.locator('.step-cards-step-title')).toHaveText('Second position');
 await page.screenshot({path:test.info().outputPath(`expanded-${width}.png`)});
 await page.keyboard.press('Escape');await expect(viewer).toHaveCount(0);
 await expect(card.locator('.step-cards-step-title')).toHaveText('Second position');
 await expect(page.locator('.image-edit-tools')).toHaveCount(0);
});

test('expanded rich slide scrolls its text without moving visual or navigation',async({page})=>{
 await page.setViewportSize({width:1400,height:900});
 const rich={title:'Mean update',steps:[{label:'Calculate',image,markdown:Array.from({length:50},(_,i)=>`Paragraph ${i}. **Mean** is $3$.`).join('\n\n')},{label:'Final',image}]};
 await load(page,rich);await page.locator('.step-cards-figure.is-current img').click();
 const viewer=page.getByRole('dialog',{name:'Slide viewer'}),notes=viewer.locator('.step-cards-notes');
 await expect.poll(()=>notes.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 const picture=(await viewer.locator('.step-cards-stage').boundingBox())!,controls=(await viewer.locator('.step-cards-controls').boundingBox())!;
 const textBounds=(await notes.boundingBox())!;
 await page.keyboard.press('Control+=');await page.keyboard.press('Control+=');
 await expect(viewer.getByLabel('Slide image zoom')).toHaveText('120%');
 await expect(viewer.locator('.step-cards-figure.is-current')).toHaveCSS('transform',/matrix\(1\.2,/);
 expect((await notes.boundingBox())!.x).toBe(textBounds.x);
 expect(await notes.evaluate(el=>el.contains(document.elementFromPoint(el.getBoundingClientRect().x+20,el.getBoundingClientRect().y+20)))).toBe(true);
 await page.mouse.move(picture.x+picture.width/2,picture.y+picture.height/2);
 await page.mouse.down();await page.mouse.move(picture.x+picture.width/2+90,picture.y+picture.height/2+20,{steps:6});await page.mouse.up();
 await page.evaluate(()=>window.supermdZoomBy?.(2,{x:300,y:300}));
 await expect(viewer.getByLabel('Slide image zoom')).toHaveText('240%');
 await notes.evaluate(el=>el.scrollTop=el.scrollHeight);
 expect((await viewer.locator('.step-cards-stage').boundingBox())!.y).toBe(picture.y);
 expect((await viewer.locator('.step-cards-controls').boundingBox())!.y).toBe(controls.y);
 await page.screenshot({path:test.info().outputPath('zoom-clips-before-text.png')});
 await viewer.getByRole('button',{name:'Fit slide image'}).click();
 await expect(viewer.getByLabel('Slide image zoom')).toHaveText('100%');
 await page.keyboard.press('ArrowRight');await expect(viewer.locator('.step-cards-step-title')).toHaveText('Final');
});
