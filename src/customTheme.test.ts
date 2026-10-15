// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {applyCustomStyle} from './customTheme';
const base={surface:'#efe0db','surface-low':'#e8d8d0',text:'#30221b',primary:'#824322'};
it('applies bounded values and removes every override when reset',()=>{
  const root=document.documentElement;
  const key=applyCustomStyle(root,{colors:{link:'#6e3555','code-bg':'#171219'},metrics:{contentRadius:8,headingWeight:800},background:{pattern:'dots',color:'#aa6699',spacing:28,opacity:.06}},base);
  expect(root.style.getPropertyValue('--custom-radius')).toBe('8px');expect(key).toContain('800');expect(root.style.getPropertyValue('--custom-pattern')).toContain('radial-gradient');expect(root.style.getPropertyValue('--custom-code-text')).toBe('#f9f9f9');
  applyCustomStyle(root,undefined,base);expect(root.dataset.customTheme).toBe('false');expect(root.style.getPropertyValue('--custom-radius')).toBe('');expect(root.style.getPropertyValue('--custom-pattern')).toBe('');expect(root.style.getPropertyValue('--custom-code-text')).toBe('');
});
it('ignores CSS injection, unknown metrics, invalid numbers and unsafe patterns',()=>{
  const root=document.documentElement;
  const key=applyCustomStyle(root,{colors:{link:'url(https://example.com)'},metrics:{contentRadius:999,headingWeight:NaN,unknown:4,constructor:4},background:{pattern:'url(https://example.com)',color:'#123456'}},base);
  expect(key).toBe('{}');expect(root.style.getPropertyValue('--custom-undefined')).toBe('');
  expect(root.style.getPropertyValue('--custom-link')).toBe('');expect(root.style.getPropertyValue('--custom-radius')).toBe('');expect(root.style.getPropertyValue('--custom-heading-weight')).toBe('');expect(root.style.getPropertyValue('--custom-pattern')).toBe('');
});
it('palette-only updates have identical layout keys',()=>{
  const root=document.documentElement;
  const a=applyCustomStyle(root,{colors:{heading:'#332244'},metrics:{headingWeight:700}},base);
  const b=applyCustomStyle(root,{colors:{heading:'#225544'},metrics:{headingWeight:700}},base);
  expect(a).toBe(b);
});
it('renders safe paw tiles with independently adjustable size, opacity and spacing without layout changes',()=>{
  const root=document.documentElement;
  const first=applyCustomStyle(root,{background:{pattern:'paws',color:'#97674b',opacity:.12,spacing:96,size:28,angle:342}},base);
  const uri=root.style.getPropertyValue('--custom-pattern');
  expect(uri).toContain('data:image/svg+xml');
  const svg=decodeURIComponent(uri.slice(uri.indexOf(',')+1,uri.lastIndexOf('"')));
  expect(svg).toContain('opacity="0.12"');expect(svg).toContain('rotate(342)');expect(svg).toContain('scale(0.875)');
  expect(root.style.getPropertyValue('--custom-pattern-size')).toBe('96px 96px');
  const second=applyCustomStyle(root,{background:{pattern:'paws',color:'#97674b',opacity:0,spacing:144,size:40}},base);
  expect(first).toBe(second);expect(decodeURIComponent(root.style.getPropertyValue('--custom-pattern'))).toContain('opacity="0"');
  applyCustomStyle(root,undefined,base);expect(root.style.getPropertyValue('--custom-pattern')).toBe('');
});
