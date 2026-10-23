// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import React, {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {writingIssues, type WritingIssue} from './proofreadingCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeWorker {
  static instances:FakeWorker[]=[];
  onmessage:((event:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null;
  sent:Array<{id:number}>=[];
  terminate=vi.fn();
  constructor(){FakeWorker.instances.push(this);}
  postMessage(value:{id:number}){this.sent.push(value);}
  reply(index:number,issues:unknown[]=[]){this.onmessage?.({data:{id:this.sent[index].id,issues}});}
}

describe('proofreading worker ownership and idle eviction',()=>{
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();FakeWorker.instances=[];vi.stubGlobal('Worker',FakeWorker);});
  afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

  it('does not load a worker when assistance is disabled',async()=>{
    const {checkWriting}=await import('./proofreading');
    expect(await checkWriting('Text',{})).toEqual([]);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('lets cold startup finish after the idle interval, then evicts only after actual idle time',async()=>{
    const {checkWriting}=await import('./proofreading');
    const result=checkWriting('sentnce',{spellCheck:true});
    const owner=FakeWorker.instances[0];
    let completed=false;void result.then(()=>{completed=true;});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.terminate).not.toHaveBeenCalled();expect(completed).toBe(false);
    const issues=[{from:0,to:7,message:'Possible spelling error',kind:'spelling',replacements:['sentence'],originalText:'sentnce'}];
    owner.reply(0,issues);expect(await result).toEqual(issues);
    await vi.advanceTimersByTimeAsync(44_999);expect(owner.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(owner.terminate).toHaveBeenCalledOnce();
  });

  it('does not evict with queued work and cancels an idle deadline for a new request',async()=>{
    const {checkWriting}=await import('./proofreading');
    const first=checkWriting('a apple',{grammarCheck:true});
    const second=checkWriting('the the',{grammarCheck:true});
    const owner=FakeWorker.instances[0];owner.reply(0);await first;
    await vi.advanceTimersByTimeAsync(60_000);expect(owner.terminate).not.toHaveBeenCalled();
    owner.reply(1);await second;
    await vi.advanceTimersByTimeAsync(40_000);
    const third=checkWriting('another check',{grammarCheck:true});
    await vi.advanceTimersByTimeAsync(20_000);expect(owner.terminate).not.toHaveBeenCalled();
    owner.reply(2);await third;
    await vi.advanceTimersByTimeAsync(45_000);expect(owner.terminate).toHaveBeenCalledOnce();
  });

  it('releases failed requests and ignores callbacks from a retired worker',async()=>{
    const {checkWriting}=await import('./proofreading');
    const first=checkWriting('old',{spellCheck:true});
    const old=FakeWorker.instances[0];old.onerror?.();expect(await first).toEqual([]);
    const next=checkWriting('new',{spellCheck:true});
    const current=FakeWorker.instances[1];old.onerror?.();old.reply(0);
    expect(current.terminate).not.toHaveBeenCalled();current.reply(0);expect(await next).toEqual([]);
  });
});

describe('WritingSuggestions target validation and offset tracking', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    if (container) {
      container.remove();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('includes originalText in writingIssues output', () => {
    const issues = writingIssues('This is a apple and the the example.', { grammarCheck: true });
    expect(issues.map(i => i.originalText)).toEqual(['a', 'the the']);
  });

  it('findAlignedRange matches exact, drifted, or missing targets', async () => {
    const { findAlignedRange } = await import('./components/WritingSuggestions');
    const issue: WritingIssue = {
      from: 5,
      to: 12,
      message: 'Spelling',
      kind: 'spelling',
      replacements: ['sentence'],
      originalText: 'sentnce',
    };
    // Exact match
    expect(findAlignedRange('This sentnce is good', issue)).toEqual({ from: 5, to: 12 });
    // Drifted match (5 characters added at start)
    expect(findAlignedRange('01234This sentnce is good', issue)).toEqual({ from: 10, to: 17 });
    // Deleted match
    expect(findAlignedRange('This sentence is good', issue)).toBeNull();
  });

  it('applies sequential suggestions quickly without corrupting document text', async () => {
    const { default: WritingSuggestions } = await import('./components/WritingSuggestions');
    const initialText = 'This sentnce has a apple and the the word.';
    let currentText = initialText;
    const handleChange = vi.fn((newText: string) => {
      currentText = newText;
    });

    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
          grammarCheck: true,
        })
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const owner = FakeWorker.instances[0];
    const issues: WritingIssue[] = [
      { from: 5, to: 12, message: 'Spelling error', kind: 'spelling', replacements: ['sentence'], originalText: 'sentnce' },
      { from: 17, to: 24, message: 'Grammar error', kind: 'grammar', replacements: ['an apple'], originalText: 'a apple' },
      { from: 29, to: 36, message: 'Repeated word', kind: 'grammar', replacements: ['the'], originalText: 'the the' },
    ];

    await act(async () => {
      owner.reply(0, issues);
    });

    // 1. Click first replacement: "sentence"
    const buttons = container?.querySelectorAll('button');
    expect(buttons?.length).toBeGreaterThan(0);

    await act(async () => {
      buttons?.[0].click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('This sentence has a apple and the the word.');

    // Re-render component with new text
    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
          grammarCheck: true,
        })
      );
    });

    // 2. Click second replacement: "an apple"
    const buttons2 = Array.from(container?.querySelectorAll('button') || []);
    const appleBtn = buttons2.find(b => b.textContent === 'an apple');
    expect(appleBtn).toBeDefined();

    await act(async () => {
      appleBtn?.click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('This sentence has an apple and the the word.');

    // Re-render component with new text
    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
          grammarCheck: true,
        })
      );
    });

    // 3. Click third replacement: "the"
    const buttons3 = Array.from(container?.querySelectorAll('button') || []);
    const theBtn = buttons3.find(b => b.textContent === 'the');
    expect(theBtn).toBeDefined();

    await act(async () => {
      theBtn?.click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('This sentence has an apple and the word.');
  });

  it('invalidates overlapping suggestions when one is accepted', async () => {
    const { default: WritingSuggestions } = await import('./components/WritingSuggestions');
    let currentText = 'a apple';
    const handleChange = vi.fn((newText: string) => {
      currentText = newText;
    });

    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
          grammarCheck: true,
        })
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const owner = FakeWorker.instances[0];
    const issues: WritingIssue[] = [
      { from: 0, to: 7, message: 'Grammar', kind: 'grammar', replacements: ['an apple'], originalText: 'a apple' },
      { from: 2, to: 7, message: 'Spelling', kind: 'spelling', replacements: ['apples'], originalText: 'apple' },
    ];

    await act(async () => {
      owner.reply(0, issues);
    });

    const buttons = Array.from(container?.querySelectorAll('button') || []);
    expect(buttons).toHaveLength(2);

    // Accept "an apple"
    await act(async () => {
      buttons[0].click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('an apple');

    // Re-render with new text
    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
          grammarCheck: true,
        })
      );
    });

    // Overlapping "apples" suggestion should be removed/invalidated
    const remainingButtons = container?.querySelectorAll('button');
    expect(remainingButtons?.length).toBe(0);
  });

  it('re-aligns suggestion position if document was edited prior to suggestion click', async () => {
    const { default: WritingSuggestions } = await import('./components/WritingSuggestions');
    let currentText = 'This sentnce is test.';
    const handleChange = vi.fn((newText: string) => { currentText = newText; });

    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
        })
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const owner = FakeWorker.instances[0];
    const issues: WritingIssue[] = [
      { from: 5, to: 12, message: 'Spelling', kind: 'spelling', replacements: ['sentence'], originalText: 'sentnce' },
    ];

    await act(async () => {
      owner.reply(0, issues);
    });

    // User edits text by prepending "Prefix " (7 chars) before clicking suggestion
    currentText = 'Prefix This sentnce is test.';
    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
        })
      );
    });

    const button = container?.querySelector('button');
    expect(button?.textContent).toBe('sentence');

    await act(async () => {
      button?.click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('Prefix This sentence is test.');
  });

  it('safely suppresses suggestion when target text was deleted', async () => {
    const { default: WritingSuggestions } = await import('./components/WritingSuggestions');
    let currentText = 'This sentnce is test.';
    const handleChange = vi.fn((newText: string) => { currentText = newText; });

    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
        })
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const owner = FakeWorker.instances[0];
    const issues: WritingIssue[] = [
      { from: 5, to: 12, message: 'Spelling', kind: 'spelling', replacements: ['sentence'], originalText: 'sentnce' },
    ];

    await act(async () => {
      owner.reply(0, issues);
    });

    // User deletes target text "sentnce"
    currentText = 'This is test.';
    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
        })
      );
    });

    const aside = container?.querySelector('aside');
    expect(aside).toBeNull();
  });

  it('handles UTF-16 surrogate pairs (emojis) correctly', async () => {
    const { default: WritingSuggestions } = await import('./components/WritingSuggestions');
    let currentText = '😀 sentnce 😀';
    const handleChange = vi.fn((newText: string) => { currentText = newText; });

    await act(async () => {
      root?.render(
        React.createElement(WritingSuggestions, {
          text: currentText,
          onChange: handleChange,
          spellCheck: true,
        })
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    const owner = FakeWorker.instances[0];
    const issues: WritingIssue[] = [
      { from: 3, to: 10, message: 'Spelling', kind: 'spelling', replacements: ['sentence'], originalText: 'sentnce' },
    ];

    await act(async () => {
      owner.reply(0, issues);
    });

    const button = container?.querySelector('button');
    await act(async () => {
      button?.click();
    });

    expect(handleChange).toHaveBeenLastCalledWith('😀 sentence 😀');
  });
});
