// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {validArtwork} from './themeArtwork';
import {applyCustomStyle} from './customTheme';
import fixtures from '../test-fixtures/theme-artwork.json';
const image=(body:string)=>'data:image/svg+xml;base64,'+btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">${body}</svg>`);
it('accepts only bounded embedded static art, never active markup or resources',()=>{
  expect(validArtwork(image('<path d="M0 0L100 100" stroke="#123456"/>'))).toBe(true);
  for(const body of ['<script>alert(1)</script>','<image href="https://example.com/image.png"/>','<rect onclick="x()"/>','<rect style="fill:red"/>','<animate attributeName="x"/>','<foreignObject/>','<path fill="url(#safe) url(https://example.com)"/>'])expect(validArtwork(image(body)),body).toBe(false);
  expect(validArtwork('url(https://example.com)')).toBe(false);
  expect(validArtwork(image('<path/>'.repeat(5000)))).toBe(false);
  expect(validArtwork('data:image/svg+xml;base64,'+'A'.repeat(180000))).toBe(false);
});
it('accepts real PNG, JPEG and WebP and rejects MIME spoofing, animations and excessive dimensions',()=>{
  for(const uri of Object.values(fixtures))expect(validArtwork(uri)).toBe(true);
  expect(validArtwork(fixtures.jpeg.replace('image/jpeg','image/png'))).toBe(false);
  const png=Uint8Array.from(atob(fixtures.png.split(',')[1]),c=>c.charCodeAt(0));
  new DataView(png.buffer).setUint32(16,100000);
  expect(validArtwork('data:image/png;base64,'+btoa(String.fromCharCode(...png)))).toBe(false);
  const webp=Uint8Array.from(atob(fixtures.webp.split(',')[1]),c=>c.charCodeAt(0));webp[20]|=2;
  expect(validArtwork('data:image/webp;base64,'+btoa(String.fromCharCode(...webp)))).toBe(false);
});
it('updates art visibility without changing layout metrics and completely clears on reset',()=>{
  const root=document.documentElement,art=image('<circle cx="100" cy="100" r="60" fill="#bd4354"/>');
  const base={surface:'#eddcda',text:'#38272c'};
  const a=applyCustomStyle(root,{artwork:{reader:{image:art,opacity:.10,fit:'cover',position:'right'}},background:{pattern:'grid',color:'#8c384d',spacing:32}},base);
  expect(root.dataset.customTheme).toBe('true');expect(root.style.getPropertyValue('--custom-background')).toContain(art);
  expect(root.style.getPropertyValue('--custom-background-position')).toBe('0 0,0 0,center,right center');
  expect(root.style.getPropertyValue('--custom-background-size')).toBe('32px 32px,32px 32px,cover,cover');
  const b=applyCustomStyle(root,{artwork:{reader:{image:art,opacity:0,fit:'contain'}}},base);
  expect(a).toBe(b);expect(root.style.getPropertyValue('--custom-art-veil')).toContain('100%');
  applyCustomStyle(root,undefined,base);expect(root.style.getPropertyValue('--custom-background')).toBe('');expect(root.style.getPropertyValue('--custom-art')).toBe('');
});
