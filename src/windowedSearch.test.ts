// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {commitWindowedLayout,captureWindowedScrollAnchor,rememberWindowedScrollSource} from './windowedSearch';
import {markScrollInput} from './scrollAnchor';
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();Reflect.deleteProperty(Range.prototype,'getBoundingClientRect');Reflect.deleteProperty(document,'caretRangeFromPoint');});
function fixture(placeholder=false){
  const root=document.createElement('main');root.className='android-reading';root.scrollTop=700;
  const before=document.createElement('section'),anchor=document.createElement('section');
  for(const node of [before,anchor])node.dataset.windowedBlock='';
  before.dataset.windowedMounted=String(!placeholder);anchor.dataset.windowedMounted='true';
  root.append(before,anchor);document.body.append(root);
  let height=120;
  vi.spyOn(root,'getBoundingClientRect').mockImplementation(()=>({top:0,left:0,width:800,height:600,bottom:600,right:800}) as DOMRect);
  vi.spyOn(anchor,'getBoundingClientRect').mockImplementation(()=>new DOMRect(0,height+800-root.scrollTop,800,90));
  Object.defineProperty(document,'elementFromPoint',{configurable:true,value:vi.fn(()=>placeholder?before:anchor)});
  return {root,anchor,grow:()=>{height=420;}};
}
it('commits estimated block changes against the current viewport without delaying restoration',()=>{
  const {root,anchor,grow}=fixture();const top=anchor.getBoundingClientRect().top;
  commitWindowedLayout(root,grow);
  expect(root.scrollTop).toBe(1000);expect(anchor.getBoundingClientRect().top).toBe(top);
});
it('anchors an already-mounted neighbour instead of an expanding placeholder',()=>{
  const {root,anchor,grow}=fixture(true);const top=anchor.getBoundingClientRect().top;
  // A new input has already moved the scroller before the observer delivery.
  root.scrollTop+=80;
  commitWindowedLayout(root,grow);
  expect(root.scrollTop).toBe(1080);expect(anchor.getBoundingClientRect().top).toBe(top-80);
});
it('a loading block uses visible source after it rather than anchoring its own unchanged top',()=>{
  const {root,anchor,grow}=fixture(true),loading=anchor.previousElementSibling as HTMLElement;
  loading.dataset.windowedMounted='true';const top=anchor.getBoundingClientRect().top;
  const restore=captureWindowedScrollAnchor(root,loading);grow();restore();
  expect(root.scrollTop).toBe(1000);expect(anchor.getBoundingClientRect().top).toBe(top);
});
it('finds a viewport anchor when the preferred point is in a paragraph margin',()=>{
  const {root,anchor,grow}=fixture();
  vi.mocked(document.elementFromPoint).mockReturnValueOnce(root).mockReturnValue(anchor);
  const top=anchor.getBoundingClientRect().top;commitWindowedLayout(root,grow);
  expect(root.scrollTop).toBe(1000);expect(anchor.getBoundingClientRect().top).toBe(top);
});
it('leaves an explicit heading navigation in control',()=>{
  const {root,grow}=fixture();root.dataset.navigating='true';commitWindowedLayout(root,grow);expect(root.scrollTop).toBe(700);
});
it('does not restore an anchor after its document has been detached',()=>{
  const {root,grow}=fixture();commitWindowedLayout(root,()=>{grow();root.remove();});expect(root.scrollTop).toBe(700);
});
function sourceFixture(delta:number){
  const {root,anchor,grow}=fixture(),text=document.createTextNode('Surviving source text');anchor.append(text);
  const range=document.createRange();range.setStart(text,0);range.setEnd(text,1);
  Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>anchor.getBoundingClientRect()});
  Object.defineProperty(document,'caretRangeFromPoint',{configurable:true,value:vi.fn(()=>range)});
  markScrollInput();rememberWindowedScrollSource(root,delta);
  root.scrollTop+=delta;
  return {root,anchor,text,grow};
}
it.each([-80,80])('keeps the latest surviving text across media growth after a %ipx input',delta=>{
  const {root,anchor,grow}=sourceFixture(delta),top=anchor.getBoundingClientRect().top;
  // The normal probe now hits another mounted block before the changing image.
  const earlier=anchor.previousElementSibling as HTMLElement;
  vi.mocked(document.elementFromPoint).mockReturnValue(earlier);
  vi.spyOn(earlier,'getBoundingClientRect').mockReturnValue(new DOMRect(0,50,800,50));
  const restore=captureWindowedScrollAnchor(root,earlier);grow();restore();
  expect(root.scrollTop).toBe(1000+delta);expect(anchor.getBoundingClientRect().top).toBe(top);
});
it('does not replay the input position or keep a source after a newer interaction',()=>{
  const {root,anchor,grow}=sourceFixture(-80);
  root.scrollTop-=20;const top=anchor.getBoundingClientRect().top;
  const restore=captureWindowedScrollAnchor(root);grow();markScrollInput();restore();
  expect(root.scrollTop).toBe(600);expect(anchor.getBoundingClientRect().top).toBe(top+300);
});
it('rejects a source Range retargeted to its parent after unmounting',()=>{
  const {root,text}=sourceFixture(-80),restore=captureWindowedScrollAnchor(root);
  text.remove();restore();expect(root.scrollTop).toBe(620);
});
it('clears the retained source when a document is replaced',()=>{
  const {root,grow}=sourceFixture(-80);rememberWindowedScrollSource(root,0);
  const earlier=root.firstElementChild as HTMLElement;
  vi.mocked(document.elementFromPoint).mockReturnValue(earlier);
  vi.spyOn(earlier,'getBoundingClientRect').mockReturnValue(new DOMRect(0,50,800,50));
  const restore=captureWindowedScrollAnchor(root);grow();restore();expect(root.scrollTop).toBe(620);
});
