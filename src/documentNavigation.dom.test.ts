// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cancelHeadingNavigation,isLocalHref,navigateToHeading,parseRelativeNoteLink,readingKeyboardScrollDelta} from './documentNavigation';

afterEach(()=>{
  document.documentElement.style.removeProperty('--native-visible-chrome-inset');
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('classifies local anchors and parses relative note links with optional headings',()=>{
  expect(isLocalHref('#bayes')).toBe(true);
  expect(isLocalHref('lecture-2.md')).toBe(true);
  expect(isLocalHref('Lecture%202.md#bayes-law')).toBe(true);
  expect(isLocalHref('study.smd')).toBe(true);
  expect(isLocalHref('../outside.md')).toBe(true);
  expect(isLocalHref('https://example.org/note.md')).toBe(false);
  expect(isLocalHref('http://example.org')).toBe(false);
  expect(isLocalHref('mailto:author@example.org')).toBe(false);
  expect(isLocalHref('//example.org/note.md')).toBe(false);

  expect(parseRelativeNoteLink('lecture-2.md')).toEqual({target:'lecture-2.md'});
  expect(parseRelativeNoteLink('study.smd')).toEqual({target:'study.smd'});
  expect(parseRelativeNoteLink('legacy.fmd')).toEqual({target:'legacy.fmd'});
  expect(parseRelativeNoteLink('guide.markdown#overview')).toEqual({target:'guide.markdown',heading:'overview'});
  expect(parseRelativeNoteLink('Lecture%202.md#bayes-law')).toEqual({target:'Lecture%202.md',heading:'bayes-law'});
  expect(parseRelativeNoteLink('Lecture%202.md#Bayes%20Law')).toEqual({target:'Lecture%202.md',heading:'Bayes Law'});
  expect(parseRelativeNoteLink('../outside.md')).toEqual({target:'../outside.md'});
  expect(parseRelativeNoteLink('#bayes')).toBeNull();
  expect(parseRelativeNoteLink('https://example.org/lecture-2.md')).toBeNull();
  expect(parseRelativeNoteLink('mailto:user@example.org')).toBeNull();
  expect(parseRelativeNoteLink('assets/diagram.png')).toBeNull();
});

it.each([[undefined,16],['209.5px',225.5],['0px',16],['-30px',16],['invalid',16],['9999px',496]] as const)(
  'places a heading below the visible native overlay (%s)',(inset,gap)=>{
    // Rendering viewport and note geometry are unchanged: only the navigation
    // destination avoids controls the native host says are currently visible.
    vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));
    vi.stubGlobal('cancelAnimationFrame',vi.fn());
    vi.stubGlobal('ResizeObserver',undefined);
    const root=document.createElement('section');
    root.className='android-reading';
    root.innerHTML='<h2 id="destination" data-heading-key="destination">Destination</h2>';
    const heading=root.firstElementChild as HTMLElement;
    document.body.append(root);
    root.getBoundingClientRect=()=>({top:0,left:0,width:400,height:700,bottom:700,right:400,x:0,y:0,toJSON(){}});
    heading.getBoundingClientRect=()=>({top:1000-root.scrollTop,left:16,width:300,height:30,bottom:1030-root.scrollTop,right:316,x:16,y:1000-root.scrollTop,toJSON(){}});
    if(inset!==undefined)document.documentElement.style.setProperty('--native-visible-chrome-inset',inset);
    try{
      expect(navigateToHeading(root,'destination')).toBe(true);
      expect(root.scrollTop).toBe(1000-gap);
      expect(heading.getBoundingClientRect().top).toBe(gap);
    }finally{cancelHeadingNavigation(root);}
  },
);

it('cancels active heading-lock settling on vertical keyboard scroll keys without snapping back on ResizeObserver',()=>{
  let resizeCallback:ResizeObserverCallback|undefined;
  class FakeResizeObserver {
    disconnected=false;
    static last:FakeResizeObserver|undefined;
    constructor(cb:ResizeObserverCallback){resizeCallback=cb;FakeResizeObserver.last=this;}
    observe(){}
    disconnect(){this.disconnected=true;}
  }
  const frames:FrameRequestCallback[]=[];
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.push(cb);return frames.length;});
  vi.stubGlobal('cancelAnimationFrame',vi.fn());
  vi.stubGlobal('ResizeObserver',FakeResizeObserver);

  const root=document.createElement('section');
  root.className='android-reading';
  Object.defineProperty(root,'clientHeight',{configurable:true,value:800});
  const page=document.createElement('div');
  page.className='document-page';
  page.dataset.scale='1';
  const heading=document.createElement('h2');
  heading.id='chapter-500';
  heading.dataset.headingKey='chapter-500';
  heading.textContent='Chapter 500';
  page.append(heading);
  root.append(page);
  document.body.append(root);

  let headingLayoutTop=4200;
  root.getBoundingClientRect=()=>({top:0,left:0,width:800,height:800,bottom:800,right:800,x:0,y:0,toJSON(){}});
  heading.getBoundingClientRect=()=>({top:headingLayoutTop-root.scrollTop,left:16,width:600,height:32,bottom:headingLayoutTop+32-root.scrollTop,right:616,x:16,y:headingLayoutTop-root.scrollTop,toJSON(){}});

  for(const keyEvent of [
    new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}),
    new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}),
    new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}),
    new KeyboardEvent('keydown',{key:' ',shiftKey:true,bubbles:true}),
    new KeyboardEvent('keydown',{key:'End',bubbles:true}),
  ]){
    headingLayoutTop=4200;
    root.scrollTop=0;
    frames.length=0;
    expect(navigateToHeading(root,'chapter-500')).toBe(true);
    expect(root.dataset.navigating).toBe('true');
    expect(root.scrollTop).toBe(4184);

    // Non-scroll keys and modified shortcuts leave heading navigation intact.
    heading.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));
    heading.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',ctrlKey:true,bubbles:true}));
    heading.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}));
    expect(root.dataset.navigating).toBe('true');

    // Vertical scroll key immediately cancels heading lock and disconnects ResizeObserver.
    heading.dispatchEvent(keyEvent);
    expect(root.dataset.navigating).toBeUndefined();
    expect(FakeResizeObserver.last?.disconnected).toBe(true);

    // Simulate user scroll + lazy block height growth above the viewport.
    root.scrollTop=4900;
    headingLayoutTop=4500;
    resizeCallback?.([],FakeResizeObserver.last as unknown as ResizeObserver);
    while(frames.length)frames.shift()!(16);
    expect(root.scrollTop).toBe(4900);
  }
});

it('ignores editable controls, buttons, and open modal overlays in readingKeyboardScrollDelta',()=>{
  const root=document.createElement('div');
  root.className='reading-scroll';
  Object.defineProperty(root,'clientHeight',{configurable:true,value:800});
  const input=document.createElement('input');
  const button=document.createElement('button');
  const editable=document.createElement('div');
  editable.contentEditable='true';
  Object.defineProperty(editable,'isContentEditable',{configurable:true,value:true});
  const paragraph=document.createElement('p');
  root.append(input,button,editable,paragraph);
  document.body.append(root);

  const down=()=>new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true});
  input.dispatchEvent(down());
  expect(readingKeyboardScrollDelta(Object.assign(down(),{}),root)).toBe(700);

  const fromTarget=(el:Element,init:KeyboardEventInit={key:'PageDown',bubbles:true,cancelable:true})=>{
    let captured!:KeyboardEvent;
    docListener:{
      const fn=(e:KeyboardEvent)=>{captured=e;};
      document.addEventListener('keydown',fn,{once:true});
      el.dispatchEvent(new KeyboardEvent('keydown',init));
      break docListener;
    }
    return readingKeyboardScrollDelta(captured,root);
  };

  expect(fromTarget(paragraph,{key:'PageDown',bubbles:true})).toBe(700);
  expect(fromTarget(paragraph,{key:'PageUp',bubbles:true})).toBe(-700);
  expect(fromTarget(paragraph,{key:' ',bubbles:true})).toBe(700);
  expect(fromTarget(paragraph,{key:' ',shiftKey:true,bubbles:true})).toBe(-700);
  expect(fromTarget(paragraph,{key:'Home',bubbles:true})).toBe(0);
  expect(fromTarget(input,{key:'PageDown',bubbles:true})).toBeNull();
  expect(fromTarget(button,{key:' ',bubbles:true})).toBeNull();
  expect(fromTarget(editable,{key:'ArrowDown',bubbles:true})).toBeNull();

  const overlay=document.createElement('div');
  overlay.className='reading-search';
  document.body.append(overlay);
  expect(fromTarget(document.body,{key:'PageDown',bubbles:true})).toBeNull();
  overlay.remove();
  expect(fromTarget(document.body,{key:'PageDown',bubbles:true})).toBe(700);
});
