// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
vi.mock('./nativeBridge',()=>({invoke:vi.fn().mockResolvedValue({filename:'Saved.svg'})}));
import {registerMedia,mediaAt,mediaBytes,neutralChartSvg,installMediaMenu} from './mediaExport';
import {dismissReaderOverlay} from './readerOverlays';
describe('original media export',()=>{
  it('saves authored SVG instead of the themed display variant without storing it in the DOM',async()=>{
    const element=document.createElement('img');element.src='data:image/svg+xml,themed';
    const original='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path stroke="#1688dd" d="M0 0L20 20"/></svg>';
    const cleanup=registerMedia(element,{label:'Blue graph',svg:()=>original});
    const output=await mediaBytes(mediaAt(element)!,'svg');
    expect(output.mimeType).toBe('image/svg+xml');expect(atob(output.body)).toContain('#1688dd');expect(atob(output.body)).not.toContain('themed');
    expect(element.attributes.length).toBe(1);cleanup();expect(mediaAt(element)).toBeUndefined();
  });
  it('returns actual Mermaid source and rejects executable artwork',async()=>{
    const output=await mediaBytes({label:'Flow',source:{text:'graph TD; A-->B',extension:'mmd'}},'source');expect(atob(output.body)).toBe('graph TD; A-->B');expect(output.filename).toBe('Flow.mmd');
    await expect(mediaBytes({label:'bad',svg:()=>'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'},'svg')).rejects.toThrow();
  });
  it('exports readable neutral chart axes and removes the cursor probe',()=>{
    const xml=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><line class="chart-axis"/><text class="chart-tick">5</text><circle class="graph-probe-marker"/></svg>','image/svg+xml');
    const output=neutralChartSvg(xml.documentElement as unknown as SVGSVGElement);expect(output).toContain('#667085');expect(output).toContain('#20252d');expect(output).not.toContain('graph-probe-marker');
  });
  it('shows one bounded opaque menu and leaves the document source intact',()=>{
    const image=document.createElement('img');document.body.append(image);
    const descriptor={label:'diagram',svg:()=>'<svg xmlns="http://www.w3.org/2000/svg"/>'};const unreg=registerMedia(image,descriptor);
    const original=document.elementFromPoint;document.elementFromPoint=vi.fn().mockReturnValue(image);const cleanup1=installMediaMenu(),cleanup2=installMediaMenu();
    expect(window.supermdMediaMenuAt?.(20,30)).toBe(true);expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Save as SVG');
    cleanup1();expect(window.supermdMediaMenuAt).toBeDefined();cleanup2();expect(document.querySelector('[role="menu"]')).toBeNull();expect(window.supermdMediaMenuAt).toBeUndefined();unreg();image.remove();document.elementFromPoint=original;
  });
  it('appends Replace image and Remove image for editable note images outside step-cards and theme-guide-dialog',()=>{
    const container=document.createElement('div');container.className='android-document';
    container.innerHTML=`
      <span class="note-image" data-note-image-source="assets/photo.png"><img class="editable-img" alt="Photo"/></span>
      <section class="step-cards"><span class="note-image" data-note-image-source="assets/slide.png"><img class="step-img" alt="Slide"/></span></section>
      <section class="theme-guide-dialog"><span class="note-image" data-note-image-source="assets/guide.png"><img class="guide-img" alt="Guide"/></span></section>
      <span class="note-image" data-note-image-source="assets/ro.png" data-note-image-readonly="true"><img class="ro-img" alt="Readonly"/></span>
    `;
    document.body.append(container);
    const editableImg=container.querySelector('.editable-img')!;
    const stepImg=container.querySelector('.step-img')!;
    const guideImg=container.querySelector('.guide-img')!;
    const roImg=container.querySelector('.ro-img')!;
    const unregs=[editableImg,stepImg,guideImg,roImg].map(el=>registerMedia(el,{label:'img',uri:()=>'data:image/png;base64,eA=='}));
    const original=document.elementFromPoint;
    let targetEl:Element=editableImg;
    document.elementFromPoint=vi.fn(()=>targetEl);
    const cleanup=installMediaMenu();
    const events:Array<{action:string;image:HTMLElement}>=[];
    const onEdit=(e:Event)=>events.push((e as CustomEvent).detail);
    window.addEventListener('supermd-image-edit',onEdit);

    expect(window.supermdMediaMenuAt?.(20,30)).toBe(true);
    const items=Array.from(document.querySelectorAll('[role="menuitem"]')).map(el=>el.textContent);
    expect(items).toEqual(['Copy image','Save as PNG','Save original image','Replace image','Remove image']);
    (Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b=>b.textContent==='Replace image'))!.click();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(events).toEqual([{action:'replace',image:editableImg.closest('[data-note-image-source]')!}]);

    for(const excluded of [stepImg,guideImg,roImg]){
      targetEl=excluded;
      expect(window.supermdMediaMenuAt?.(20,30)).toBe(true);
      const excludedItems=Array.from(document.querySelectorAll('[role="menuitem"]')).map(el=>el.textContent);
      expect(excludedItems).not.toContain('Replace image');
      expect(excludedItems).not.toContain('Remove image');
    }

    window.removeEventListener('supermd-image-edit',onEdit);
    cleanup();unregs.forEach(fn=>fn());container.remove();document.elementFromPoint=original;
  });
  it('opens Replace and Remove on broken editable images via supermdMediaMenuAt and touch long-press even without mediaAt',()=>{
    vi.useFakeTimers();
    const container=document.createElement('div');container.className='android-document';
    container.innerHTML='<span class="image-error" data-note-image-source="assets/missing.png"><span class="err-label">Image unavailable</span></span>';
    document.body.append(container);
    const brokenLabel=container.querySelector('.err-label')!;
    expect(mediaAt(brokenLabel)).toBeUndefined();
    const original=document.elementFromPoint;
    document.elementFromPoint=vi.fn(()=>brokenLabel);
    const cleanup=installMediaMenu();

    expect(window.supermdMediaMenuAt?.(25,35)).toBe(true);
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map(el=>el.textContent)).toEqual(['Replace image','Remove image']);

    let bubbleReached=false;
    const bubble=()=>bubbleReached=true;
    document.addEventListener('keydown',bubble);
    window.supermdDismiss=dismissReaderOverlay;
    expect(window.supermdDismiss()).toBe(true);
    expect(bubbleReached).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(window.supermdDismiss()).toBe(false);
    document.removeEventListener('keydown',bubble);

    const down=new Event('pointerdown',{bubbles:true,cancelable:true});
    Object.assign(down,{pointerType:'touch',clientX:40,clientY:50});
    brokenLabel.dispatchEvent(down);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    vi.advanceTimersByTime(550);
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map(el=>el.textContent)).toEqual(['Replace image','Remove image']);

    const events:Array<{action:string;image:HTMLElement}>=[];
    const onEdit=(e:Event)=>events.push((e as CustomEvent).detail);
    window.addEventListener('supermd-image-edit',onEdit);
    (Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b=>b.textContent==='Remove image'))!.click();
    expect(events).toEqual([{action:'remove',image:container.querySelector('.image-error')!}]);

    window.removeEventListener('supermd-image-edit',onEdit);
    cleanup();container.remove();document.elementFromPoint=original;vi.useRealTimers();
  });
});
