// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import WritingSuggestions from './WritingSuggestions';
import {checkWriting,type WritingIssue} from '../proofreading';
vi.mock('../proofreading',()=>({checkWriting:vi.fn()}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let host:HTMLDivElement,root:Root;
const issue:WritingIssue={from:3,to:6,kind:'spelling',message:'typo',replacements:['right']};
beforeEach(()=>{vi.useFakeTimers();vi.mocked(checkWriting).mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();});
const render=(text:string,onChange=vi.fn())=>act(()=>root.render(<WritingSuggestions text={text} spellCheck onChange={onChange}/>));
const check=()=>act(async()=>{await vi.advanceTimersByTimeAsync(600);});
it('applies a checked UTF-16 range once, even with rapid repeated clicks',async()=>{
  vi.mocked(checkWriting).mockResolvedValue([issue]);const change=vi.fn();render('😀 teh word',change);await check();
  const button=host.querySelector('button')!;
  act(()=>{button.click();button.click();});
  expect(change).toHaveBeenCalledExactlyOnceWith('😀 right word');expect(host.textContent).toBe('');
});
it('hides stale suggestions immediately on edit rather than guessing a repeated-word location',async()=>{
  vi.mocked(checkWriting).mockResolvedValue([issue]);const change=vi.fn();render('aa teh teh',change);await check();
  expect(host.querySelector('button')).not.toBeNull();render('prefix aa teh teh',change);
  expect(host.querySelector('button')).toBeNull();expect(change).not.toHaveBeenCalled();
});
it('keeps non-overlapping suggestions usable after a length-changing correction without waiting for another check',async()=>{
  vi.mocked(checkWriting).mockResolvedValue([issue,{...issue,from:7,to:10,replacements:['other']}]);
  const change=vi.fn((text:string)=>root.render(<WritingSuggestions text={text} spellCheck onChange={change}/>));
  render('😀 teh teh',change);await check();
  act(()=>host.querySelector('button')!.click());expect(change).toHaveBeenLastCalledWith('😀 right teh');
  expect(host.querySelector('button')?.textContent).toBe('other');
  act(()=>host.querySelector('button')!.click());expect(change).toHaveBeenLastCalledWith('😀 right other');
  expect(checkWriting).toHaveBeenCalledTimes(1);
});
it('ignores a late result after the document changes',async()=>{
  let resolve!:(issues:WritingIssue[])=>void;
  vi.mocked(checkWriting).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValue([]);
  render('aa teh');await check();render('another document');
  await act(async()=>resolve([issue]));expect(host.querySelector('button')).toBeNull();
});
it('safely clears a failed check and a result after unmount',async()=>{
  vi.mocked(checkWriting).mockRejectedValue(new Error('worker failed'));render('aa teh');await check();expect(host.textContent).toBe('');
  let resolve!:(issues:WritingIssue[])=>void;vi.mocked(checkWriting).mockReturnValue(new Promise(r=>{resolve=r;}));
  render('bb teh');await check();act(()=>root.render(null));await act(async()=>resolve([issue]));expect(host.textContent).toBe('');
});
