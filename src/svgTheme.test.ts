// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {adaptSvg,adaptSvgData} from './svgTheme';
import {mediaContrast} from './mediaAppearance';
const light={surface:'#f0e1d0',primary:'#80502d'},dark={surface:'#211d2d',primary:'#dfb1e0'};
const parse=(s:string)=>new DOMParser().parseFromString(s,'image/svg+xml');
it('preserves colourful nodes and makes labels readable against their own node, not the page',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 160"><circle cx="90" cy="70" r="35" fill="#153d4b" stroke="#73e3e0"/><text id="inside" x="90" y="70" fill="#f2f7fc">Root</text><text id="outside" x="180" y="70" fill="#a0bad8">Height</text></svg>';
  for(const colors of [light,dark]){
    const xml=parse(adaptSvg(source,colors,colors===dark));
    const fill=xml.querySelector('circle')!.getAttribute('fill')!;
    if(colors===light)expect(fill).toBe('#153d4b');
    else expect(mediaContrast(fill,colors.surface)).toBeGreaterThanOrEqual(3);
    expect(mediaContrast(xml.querySelector('#inside')!.getAttribute('fill')!,fill)).toBeGreaterThanOrEqual(4.5);
    expect(mediaContrast(xml.querySelector('#outside')!.getAttribute('fill')!,colors.surface)).toBeGreaterThanOrEqual(4.5);
  }
  expect(source).toContain('fill="#f2f7fc"');
});
it('adapts paper and neutral paths but keeps well-contrasted blue and red series',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path id="paper" d="M 0 0 L 300 0 L 300 200 L 0 200 z" fill="white"/><path id="axis" d="M10 10L10 180" stroke="black"/><path id="blue" d="M10 100L200 20" fill="none" stroke="#1d4ed8"/><path id="red" d="M10 20L200 100" fill="none" stroke="#b91c1c"/><defs><path id="glyph" d="M0 0L1 1"/></defs><g id="text_1" transform="translate(30 150)"><use href="#glyph"/></g></svg>';
  const xml=parse(adaptSvg(source,light,false));
  expect(xml.querySelector('#paper')!.getAttribute('fill')).toBe(light.surface);
  expect(xml.querySelector('#axis')!.getAttribute('stroke')).toBe(light.primary);
  expect(xml.querySelector('#blue')!.getAttribute('stroke')).toBe('#1d4ed8');
  expect(xml.querySelector('#red')!.getAttribute('stroke')).toBe('#b91c1c');
  expect(mediaContrast(xml.querySelector('use')!.getAttribute('fill')!,light.surface)).toBeGreaterThanOrEqual(7);
});
it('handles inline paint precedence, nested transforms and white edge halos',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><g transform="translate(20 20)"><rect width="100" height="80" style="fill:#153d4b"/><text x="50" y="40" style="fill:white">A</text></g><path d="M 0 0L200 100" stroke="white" stroke-width="6"/></svg>';
  const xml=parse(adaptSvg(source,light,false));
  expect((xml.querySelector('rect') as unknown as SVGElement).style.fill).toBe('#153d4b');
  const label=(xml.querySelector('text') as unknown as SVGElement).style.fill;
  expect(mediaContrast(label,'#153d4b')).toBeGreaterThanOrEqual(4.5);
  expect(xml.querySelector('path')!.getAttribute('stroke')).toBe(light.surface);
});
it('keeps a solid black mark accent-coloured and rejects active or external SVG payloads',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="black"/></svg>';
  expect(parse(adaptSvg(source,dark,true)).querySelector('rect')!.getAttribute('fill')).toBe(dark.primary);
  expect(()=>adaptSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',light,false)).toThrow();
  expect(adaptSvgData('data:image/png;base64,AAAA',light,false)).toBe('data:image/png;base64,AAAA');
});
it('resolves embedded paint styles without mounting CSS and keeps muted labels strongly contrasted',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><style>.node{fill:#153d4b!important}.label{fill:#111827}.label.colour{fill:#14532d}</style><rect class="node" width="100" height="80"/><text class="label" x="50" y="40">Root</text><text class="label colour" x="180" y="40">Leaf</text></svg>';
  const xml=parse(adaptSvg(source,dark,true)),rect=xml.querySelector('rect')!,labels=xml.querySelectorAll('text');
  const fill=(el:Element)=>el.getAttribute('fill')!;
  // Some coloured node backgrounds cannot reach 7:1 with any text colour.
  // In that case use the maximum physically achievable contrast, never less
  // than the normal 4.5:1 text requirement.
  const maximum=Math.max(mediaContrast('#000000',fill(rect)),mediaContrast('#ffffff',fill(rect)));
  expect(mediaContrast(fill(labels[0]),fill(rect))).toBeGreaterThanOrEqual(Math.min(7,maximum)-.001);
  expect(mediaContrast(fill(labels[0]),fill(rect))).toBeGreaterThanOrEqual(4.5);
  expect(mediaContrast(fill(labels[1]),dark.surface)).toBeGreaterThanOrEqual(7);
  expect((rect as unknown as SVGElement).style.getPropertyValue('fill')).toBe(fill(rect));
  expect((rect as unknown as SVGElement).style.getPropertyPriority('fill')).toBe('important');
  expect(source).toContain('.node{fill:#153d4b!important}');
});
