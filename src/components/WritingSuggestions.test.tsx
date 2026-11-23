// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import WritingSuggestions,{findAlignedRange} from './WritingSuggestions';
import {checkWriting,type WritingIssue} from '../proofreading';
vi.mock('../proofreading',()=>({checkWriting:vi.fn()}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let host:HTMLDivElement,root:Root;
const issue:WritingIssue={from:3,to:6,kind:'spelling',message:'typo',replacements:['right'],originalText:'teh'};
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
it('validates exact originalText alignment and rejects mismatched, empty, out-of-bounds or split-surrogate ranges',()=>{
  expect(findAlignedRange('😀 teh word',issue)).toEqual({from:3,to:6});
  expect(findAlignedRange('😀 the word',issue)).toBeNull();
  expect(findAlignedRange('😀 teh word',{...issue,originalText:''})).toBeNull();
  expect(findAlignedRange('😀 teh word',{...issue,from:-1,to:2})).toBeNull();
  expect(findAlignedRange('😀 teh word',{...issue,from:3,to:99})).toBeNull();
  expect(findAlignedRange('😀teh',{...issue,from:1,to:4,originalText:'😀teh'.slice(1,4)})).toBeNull();
});
it('suppresses suggestions whose offsets do not match originalText without corrupting text',async()=>{
  const stale:WritingIssue={from:0,to:3,kind:'spelling',message:'stale',replacements:['bad'],originalText:'teh'};
  vi.mocked(checkWriting).mockResolvedValueOnce([stale]).mockResolvedValueOnce([stale,issue]);
  const change=vi.fn();
  render('aa teh word',change);await check();
  expect(host.querySelector('aside')).toBeNull();expect(change).not.toHaveBeenCalled();
  render('bb teh word',change);await check();
  const buttons=Array.from(host.querySelectorAll('button'));
  expect(buttons.map(btn=>btn.textContent)).toEqual(['right']);
  act(()=>buttons[0].click());
  expect(change).toHaveBeenCalledExactlyOnceWith('bb right word');
});
it('changes note text only at the exact accepted suggestion while leaving identical surrounding words, code and emojis untouched',async()=>{
  const initialNote='teh keep `teh` 😀 teh middle teh end';
  const secondFrom=initialNote.indexOf('😀 ')+3,thirdFrom=initialNote.lastIndexOf('teh');
  expect(initialNote.slice(secondFrom,secondFrom+3)).toBe('teh');
  expect(initialNote.slice(thirdFrom,thirdFrom+3)).toBe('teh');
  vi.mocked(checkWriting).mockResolvedValue([
    {from:0,to:3,kind:'spelling',message:'first typo',replacements:['First'],originalText:'teh'},
    {from:secondFrom,to:secondFrom+3,kind:'spelling',message:'middle typo',replacements:['exact'],originalText:'teh'},
    {from:thirdFrom,to:thirdFrom+3,kind:'spelling',message:'last typo',replacements:['last'],originalText:'teh'},
  ]);
  let current=initialNote;
  const change=vi.fn((next:string)=>{current=next;root.render(<WritingSuggestions text={current} spellCheck onChange={change}/>);});
  render(current,change);await check();
  const exactBtn=Array.from(host.querySelectorAll('button')).find(btn=>btn.textContent==='exact')!;
  act(()=>exactBtn.click());
  expect(current.slice(0,secondFrom)).toBe(initialNote.slice(0,secondFrom));
  expect(current.slice(secondFrom,secondFrom+'exact'.length)).toBe('exact');
  expect(current.slice(secondFrom+'exact'.length)).toBe(initialNote.slice(secondFrom+3));
  expect(current).toBe('teh keep `teh` 😀 exact middle teh end');

  const afterFirst=current,shiftedThirdFrom=thirdFrom+('exact'.length-3);
  const lastBtn=Array.from(host.querySelectorAll('button')).find(btn=>btn.textContent==='last')!;
  act(()=>lastBtn.click());
  expect(current.slice(0,shiftedThirdFrom)).toBe(afterFirst.slice(0,shiftedThirdFrom));
  expect(current.slice(shiftedThirdFrom,shiftedThirdFrom+'last'.length)).toBe('last');
  expect(current.slice(shiftedThirdFrom+'last'.length)).toBe(afterFirst.slice(shiftedThirdFrom+3));
  expect(current).toBe('teh keep `teh` 😀 exact middle last end');
});
it('invalidates overlapping suggestions on accept while shifting subsequent non-overlapping issues',async()=>{
  vi.mocked(checkWriting).mockResolvedValue([
    {from:0,to:7,kind:'grammar',message:'article',replacements:['an apple'],originalText:'a apple'},
    {from:2,to:7,kind:'spelling',message:'overlap',replacements:['apples'],originalText:'apple'},
    {from:12,to:19,kind:'grammar',message:'repeated',replacements:['the'],originalText:'the the'},
  ]);
  let current='a apple and the the word';
  const change=vi.fn((next:string)=>{current=next;root.render(<WritingSuggestions text={current} spellCheck grammarCheck onChange={change}/>);});
  act(()=>root.render(<WritingSuggestions text={current} spellCheck grammarCheck onChange={change}/>));await check();
  expect(Array.from(host.querySelectorAll('button')).map(btn=>btn.textContent)).toEqual(['an apple','apples','the']);
  act(()=>host.querySelector('button')!.click());
  expect(current).toBe('an apple and the the word');
  expect(Array.from(host.querySelectorAll('button')).map(btn=>btn.textContent)).toEqual(['the']);
  act(()=>host.querySelector('button')!.click());
  expect(current).toBe('an apple and the word');
  expect(host.querySelector('aside')).toBeNull();
});
