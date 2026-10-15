import {expect,it} from 'vitest';
import {mediaFilter,mediaTone,mediaContrast} from './mediaAppearance';
it('preserves original appearance unless explicitly opted in',()=>{
  expect(mediaFilter(undefined,true)).toBe('none');expect(mediaFilter('original',false)).toBe('none');
  expect(mediaFilter('invert-dark',false)).toBe('none');expect(mediaFilter('invert-dark',true)).toContain('invert(1)');
  expect(mediaFilter('auto',true)).toBe('url("#supermd-media-tone")');expect(mediaFilter('contrast',false,99)).toBe('none');
});
it('derives legible ink from the actual accent and page, not just dark/light',()=>{
  for(const surface of ['#000000','#17131b','#e8d4c6','#ffffff'])for(const primary of ['#17131b','#e8d4c6','#aaccff','#cc5599']){
    const tone=mediaTone({surface,primary},false);expect(mediaContrast(tone.ink,tone.paper)).toBeGreaterThanOrEqual(4.5);
    expect(tone.channels).toHaveLength(3);
  }
  expect(mediaTone({surface:'#f1dfd4',primary:'#774477'},false).ink).not.toBe(mediaTone({surface:'#f1dfd4',primary:'#335588'},false).ink);
  expect(mediaTone({primary:'url(https://bad.example)'},true).ink).toMatch(/^#[0-9a-f]{6}$/i);
});
