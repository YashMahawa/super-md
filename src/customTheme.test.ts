// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {applyCustomStyle} from './customTheme';
import {componentContrast,componentRoles,componentMetrics} from './themeComponents';
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
it('keeps component surfaces independent, fixes contrast and resets all component overrides',()=>{
  const root=document.documentElement;
  const key=applyCustomStyle(root,{colors:{'code-bg':'#fafafa','python-bg':'#162735','python-text':'#162735','python-header-bg':'#243b46','python-run-bg':'#8bc4b3','python-output-bg':'#e4f0e9','python-error-bg':'#642c36','table-bg':'#eee6da','table-border':'#816948','table-header-bg':'#33493d','syntax-keyword':'#283b42'},metrics:{tableBorderWidth:2,pythonRadius:18,pythonSourceMaxHeight:24}},base);
  const prop=(k:string)=>root.style.getPropertyValue('--custom-'+k);
  expect(prop('table-border')).toBe('#816948');expect(prop('table-border-width')).toBe('2px');
  expect(prop('python-radius')).toBe('18px');expect(prop('python-height')).toBe('24em');
  for(const [role,bg] of [['python-text','#162735'],['python-header-text','#243b46'],['python-run-text','#8bc4b3'],['python-output-text','#e4f0e9'],['python-error-text','#642c36'],['table-header-text','#33493d'],['syntax-keyword','#fafafa'],['python-syntax-keyword','#162735']])expect(componentContrast(prop(role),bg)).toBeGreaterThanOrEqual(4.5);
  const next=applyCustomStyle(root,{colors:{'python-bg':'#e4f0e9'},metrics:{tableBorderWidth:2,pythonRadius:18,pythonSourceMaxHeight:24}},base);expect(next).toBe(key);
  applyCustomStyle(root,undefined,base);
  for(const role of [...componentRoles,'python-syntax-keyword',...Object.values(componentMetrics).map(v=>v[0])]){expect(prop(role)).toBe('');expect(root.hasAttribute('data-custom-'+role)).toBe(false);}
});
it('keeps striped tables legible and ignores invalid component injections and bounds',()=>{
  const root=document.documentElement;
  applyCustomStyle(root,{colors:{'table-bg':'#ffffff','table-row-alt-bg':'#000000','table-text':'#eeeeee','python-bg':'url(file:///secret)','python-text':'red'},metrics:{pythonRadius:33,tableCellPadding:3,codeFontScale:Infinity,pythonSourceMaxHeight:61}},base);
  expect(root.style.getPropertyValue('--custom-table-row-alt-bg')).toBe('#ffffff');
  expect(componentContrast(root.style.getPropertyValue('--custom-table-text'),'#ffffff')).toBeGreaterThanOrEqual(4.5);
  for(const role of ['python-bg','python-text','python-radius','table-padding','code-scale','python-height'])expect(root.style.getPropertyValue('--custom-'+role)).toBe('');
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
