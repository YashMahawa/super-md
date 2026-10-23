// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {commitWindowedLayout} from './windowedSearch';
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
function fixture(placeholder=false){
  const root=document.createElement('main');root.className='android-reading';root.scrollTop=700;
  const before=document.createElement('section'),anchor=document.createElement('section');
  for(const node of [before,anchor])node.dataset.windowedBlock='';
  before.dataset.windowedMounted=String(!placeholder);anchor.dataset.windowedMounted='true';
  root.append(before,anchor);document.body.append(root);
  let height=120;
  vi.spyOn(root,'getBoundingClientRect').mockImplementation(()=>({top:0,left:0,width:800,height:600,bottom:600,right:800}) as DOMRect);
  vi.spyOn(anchor,'getBoundingClientRect').mockImplementation(()=>({top:height+800-root.scrollTop,height:90}) as DOMRect);
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
