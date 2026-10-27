// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
vi.mock('./nativeBridge',()=>({invoke:vi.fn().mockResolvedValue({filename:'Saved.svg'})}));
import {registerMedia,mediaAt,mediaBytes,neutralChartSvg,installMediaMenu} from './mediaExport';
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
});
