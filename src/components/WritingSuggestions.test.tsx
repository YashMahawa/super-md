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
it('shows visible-of-total counts above 6 issues, omits blank replacement pills, and advances queued rows on Dismiss',async()=>{
  localStorage.clear();
  const text=Array.from({length:8},(_,i)=>`err${i}`).join(' ');
  const issues:WritingIssue[]=Array.from({length:8},(_,i)=>({
    from:i*5,
    to:i*5+4,
    kind:i===0?'grammar':'spelling',
    message:`Issue ${i+1}`,
    replacements:i===0?['','   ']:[`fix${i+1}`]
  }));
  vi.mocked(checkWriting).mockResolvedValue(issues);
  render(text);
  await check();
  expect(host.querySelector('header')?.textContent).toContain('English · 6 of 8');
  const firstRowButtons=[...host.querySelectorAll<HTMLButtonElement>('.writing-suggestions > div:first-of-type button')];
  expect(firstRowButtons.map(b=>b.textContent)).toEqual(['Dismiss']);
  expect(host.textContent).not.toContain('Issue 7');
  act(()=>firstRowButtons[0].click());
  expect(host.querySelector('header')?.textContent).toContain('English · 6 of 7');
  expect(host.textContent).toContain('Issue 7');
});
it('saves flagged words to the personal dictionary and immediately clears matching warnings case-insensitively',async()=>{
  localStorage.clear();
  const text='Eigenmode and eigenmode with teh typo';
  vi.mocked(checkWriting).mockResolvedValue([
    {from:0,to:9,kind:'spelling',message:'Possible spelling error: Eigenmode',replacements:[]},
    {from:14,to:23,kind:'spelling',message:'Possible spelling error: eigenmode',replacements:[]},
    {from:29,to:32,kind:'spelling',message:'Possible spelling error: teh',replacements:['the']}
  ]);
  render(text);
  await check();
  expect(host.querySelectorAll('.writing-suggestions > div')).toHaveLength(3);
  const saveButton=[...host.querySelectorAll('button')].find(b=>b.textContent==='Add to dictionary')!;
  act(()=>saveButton.click());
  expect(host.querySelectorAll('.writing-suggestions > div')).toHaveLength(1);
  expect(host.textContent).toContain('Possible spelling error: teh');
  expect(JSON.parse(localStorage.getItem('supermd.personal-dictionary.v1')||'[]')).toContain('eigenmode');
  localStorage.clear();
});
it('centers a 12,000-character check window on the cursor and renders a range badge for blocks exceeding 12,000 characters',async()=>{
  localStorage.clear();
  const filler='Valid prose line with low-pass filters.\n'.repeat(410);
  const longText=`${filler}Downstream tehir typo at end.`;
  expect(longText.length).toBeGreaterThan(16_000);
  vi.mocked(checkWriting).mockImplementation(async slice=>{
    const idx=slice.indexOf('tehir');
    return idx===-1?[]:[{from:idx,to:idx+5,kind:'spelling',message:'Possible spelling error: tehir',replacements:['their']}];
  });
  const onChange=vi.fn();
  act(()=>root.render(<WritingSuggestions text={longText} caret={longText.length} spellCheck onChange={onChange}/>));
  expect(host.querySelector('.proofreading-range-badge')?.textContent).toContain('12,000-character range');
  await check();
  const theirButton=[...host.querySelectorAll('button')].find(b=>b.textContent==='their')!;
  expect(theirButton).toBeDefined();
  act(()=>theirButton.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(`${filler}Downstream their typo at end.`);
  expect(host.querySelector('.proofreading-range-badge')?.textContent).toContain('12,000-character range');
});
