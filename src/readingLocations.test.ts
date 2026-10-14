// @vitest-environment jsdom
import {beforeEach,expect,it} from 'vitest';
import {loadReadingLocation,saveReadingLocation} from './readingLocations';
beforeEach(()=>localStorage.clear());
it('retains a bounded index and replaces the same document without storing content',()=>{
  for(let i=0;i<220;i++)saveReadingLocation(`/note ${i}.md`,{top:i*10,offset:i,zoom:150,mode:'reader'});
  expect(loadReadingLocation('/note 0.md')).toBeUndefined();
  saveReadingLocation('/note 219.md',{top:900,offset:123,zoom:120,mode:'live'});
  expect(loadReadingLocation('/note 219.md')?.top).toBe(900);
  expect(JSON.parse(localStorage.getItem('supermd.reading-locations.v1')!).length).toBe(200);
});
it('ignores corrupt and invalid state',()=>{
  localStorage.setItem('supermd.reading-locations.v1','broken');expect(loadReadingLocation('/note')).toBeUndefined();
  saveReadingLocation('/note',{top:-1,offset:0,zoom:100,mode:'reader'});expect(loadReadingLocation('/note')).toBeUndefined();
});
