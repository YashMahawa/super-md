import {expect,it} from 'vitest';
import {mediaFilter} from './mediaAppearance';
it('preserves original appearance unless explicitly opted in',()=>{
  expect(mediaFilter(undefined,true)).toBe('none');expect(mediaFilter('original',false)).toBe('none');
  expect(mediaFilter('invert-dark',false)).toBe('none');expect(mediaFilter('invert-dark',true)).toContain('invert(1)');
  expect(mediaFilter('auto',true)).toContain('sepia');expect(mediaFilter('contrast',false,99)).toBe('contrast(2)');
});
