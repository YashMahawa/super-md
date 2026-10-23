// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import MermaidDiagram from './MermaidDiagram';
import {cachedMermaid,renderMermaid} from '../mermaidRenderer';
vi.mock('../mermaidRenderer',()=>({cachedMermaid:vi.fn(),renderMermaid:vi.fn()}));
vi.mock('../peleRenderer',()=>({canUsePele:()=>false}));
vi.mock('./SvgDiagram',()=>({default:({source,dark}:{source:string;dark:boolean})=><span data-dark={String(dark)}>{source}</span>}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.useFakeTimers();vi.mocked(cachedMermaid).mockReset();vi.mocked(renderMermaid).mockReset();host=document.createElement('div');root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());vi.useRealTimers();});
const render=(source='graph TD;A-->B',dark=false)=>act(()=>root.render(<MermaidDiagram source={source} dark={dark}/>));
it('switches to a cached matching-theme SVG without waiting for the edit debounce',async()=>{
  vi.mocked(cachedMermaid).mockImplementation((_,dark)=>dark?'dark-svg':'light-svg');
  vi.mocked(renderMermaid).mockImplementation(async(_,dark)=>dark?'dark-svg':'light-svg');
  await act(async()=>render());expect(host.textContent).toBe('light-svg');
  await act(async()=>render(undefined,true));expect(host.textContent).toBe('dark-svg');
  expect(host.querySelector('[data-dark]')?.getAttribute('data-dark')).toBe('true');
  expect(renderMermaid).toHaveBeenCalledTimes(2);
});
it('debounces source edits but starts an uncached theme-only render immediately',async()=>{
  vi.mocked(renderMermaid).mockResolvedValue('svg');render();expect(renderMermaid).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(220);});expect(renderMermaid).toHaveBeenCalledTimes(1);
  await act(async()=>render(undefined,true));expect(renderMermaid).toHaveBeenCalledTimes(2);
  render('graph TD;C-->D',true);expect(renderMermaid).toHaveBeenCalledTimes(2);
  await act(async()=>{await vi.advanceTimersByTimeAsync(220);});expect(renderMermaid).toHaveBeenCalledTimes(3);
});
it('recovers from a failed source and aborts its previous subscriber',async()=>{
  vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('bad diagram')).mockResolvedValue('fixed-svg');
  render('bad');await act(async()=>{await vi.advanceTimersByTimeAsync(220);});expect(host.textContent).toContain('bad diagram');
  const oldSignal=vi.mocked(renderMermaid).mock.calls[0][2]!;render('fixed');expect(oldSignal.aborted).toBe(true);expect(host.textContent).not.toContain('bad diagram');
  await act(async()=>{await vi.advanceTimersByTimeAsync(220);});expect(host.textContent).toBe('fixed-svg');
});
