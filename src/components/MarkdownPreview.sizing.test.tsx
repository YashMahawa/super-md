// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {mediaAt,mediaBytes} from '../mediaExport';
import {preparePdf} from '../preparePdf';
import MarkdownPreview from './MarkdownPreview';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

it('classifies standalone SVGs at intrinsic dimensions in one parse without classifying inline icons, mutating src, or remounting unchanged image paragraphs on an edit',()=>{
  const portraitSvg='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="300" viewBox="0 0 140 300"><rect width="140" height="300" fill="#eef3f8"/></svg>';
  const uri='data:image/svg+xml;base64,'+btoa(portraitSvg);
  const iconUri='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>');
  const source=`- [ ] A task\n\n![Diagram](${uri})\n\nAn inline icon ![Icon](${iconUri}) stays inline.\n`;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const parseSpy=vi.spyOn(DOMParser.prototype,'parseFromString');
  try{
    parseSpy.mockClear();
    act(()=>root.render(<MarkdownPreview markdown={source} documentPath={null} python="" dark={false}/>));
    expect(parseSpy).toHaveBeenCalledTimes(2);
    const paragraph=host.querySelector('.media-paragraph')!;
    const wrapper=paragraph.querySelector<HTMLElement>('.note-image--diagram')!;
    const image=paragraph.querySelector<HTMLImageElement>('img')!;
    expect(wrapper).not.toBeNull();
    expect(host.querySelectorAll('.media-paragraph')).toHaveLength(1);
    expect(host.querySelectorAll('.note-image--diagram')).toHaveLength(2);
    expect(host.querySelector('p:not(.media-paragraph) .note-image--diagram')?.getAttribute('data-svg-sized')).toBeNull();
    act(()=>image.dispatchEvent(new Event('load')));
    expect(wrapper.getAttribute('data-svg-sized')).toBe('true');
    expect(wrapper.style.getPropertyValue('--svg-width')).toBe('140px');
    expect(wrapper.style.getPropertyValue('--svg-min-width')).toBe('0px');
    expect(image.getAttribute('src')).toBe(uri);
    parseSpy.mockClear();
    act(()=>root.render(<MarkdownPreview markdown={source.replace('[ ]','[x]')} documentPath={null} python="" dark={false}/>));
    expect(parseSpy).not.toHaveBeenCalled();
    expect(host.querySelector('.media-paragraph')).toBe(paragraph);
    expect(paragraph.querySelector('img')).toBe(image);
    expect(image.getAttribute('src')).toBe(uri);
    expect(paragraph.querySelector('[role=status]')).toBeNull();
  }finally{parseSpy.mockRestore();act(()=>root.unmount());host.remove();}
});

it('preserves full intrinsic vector markup for media export and PDF preparation across portrait and wide SVG figures',async()=>{
  const portrait='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="300" viewBox="0 0 140 300"><rect width="140" height="300" fill="#eef3f8"/><text x="16" y="36">Portrait</text></svg>';
  const wide='<svg xmlns="http://www.w3.org/2000/svg" width="1284" height="463" viewBox="0 0 1284 463" data-diagram-engine="pele"><rect width="1284" height="463" fill="#ffffff"/><text x="40" y="60">Sequence</text></svg>';
  const source=`\`\`\`svg\n${portrait}\n\`\`\`\n\n\`\`\`svg\n${wide}\n\`\`\`\n`;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{
    act(()=>root.render(<MarkdownPreview markdown={source} documentPath={null} python="" dark={false}/>));
    const figures=host.querySelectorAll<HTMLImageElement>('.svg-figure img.svg-diagram');
    expect(figures).toHaveLength(2);
    expect(figures[0].style.getPropertyValue('--svg-width')).toBe('140px');
    expect(figures[0].style.getPropertyValue('--svg-min-width')).toBe('0px');
    expect(figures[1].style.getPropertyValue('--svg-width')).toBe('1284px');
    expect(figures[1].style.getPropertyValue('--svg-min-width')).toBe('1027px');

    const exportedPortrait=await mediaBytes(mediaAt(figures[0])!,'svg');
    const exportedWide=await mediaBytes(mediaAt(figures[1])!,'svg');
    expect(atob(exportedPortrait.body)).toContain('width="140"');
    expect(atob(exportedPortrait.body)).toContain('height="300"');
    expect(atob(exportedWide.body)).toContain('width="1284"');
    expect(atob(exportedWide.body)).toContain('height="463"');

    const pdf=await preparePdf(source,null);
    const svgAssets=Object.entries(pdf.assets).filter(([name])=>name.endsWith('.svg'));
    expect(svgAssets).toHaveLength(2);
    expect(atob(svgAssets[0][1])).toContain('width="140"');
    expect(atob(svgAssets[1][1])).toContain('width="1284"');
  }finally{act(()=>root.unmount());host.remove();}
});

