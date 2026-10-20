// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {canUsePele,resolvePeleSvg} from './peleRenderer';

it('routes supported plain diagrams to Pele but retains authored configuration, math and advanced behaviours',()=>{
  for(const source of ['%% A comment\nflowchart LR\n A[Read] --> B[Practice]','sequenceDiagram\nA->>B:Hi','stateDiagram-v2\n[*] --> Read','erDiagram\n A ||--o{ B : owns','pie\n"A":1','mindmap\n root((Study))'])expect(canUsePele(source)).toBe(true);
  for(const source of ['%%{init:{"theme":"dark"}}%%\nflowchart LR\nA-->B','---\ntitle: Authored\n---\nflowchart LR\nA-->B','flowchart LR\nA["$$x^2$$"]','flowchart LR\nA["<code>Type</code>"]','flowchart LR\nA-->B\nclick A "https://example.com"','architecture-beta\n service A(database)[DB]','gantt\n title Timeline'])expect(canUsePele(source)).toBe(false);
  expect(canUsePele('flowchart LR\n A["Two<br/>lines"] --> B')).toBe(true);
});
it('resolves nested variables and font fallbacks in attributes without changing literal label text',()=>{
  const source='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" style="--_bg:var(--pele-bg,#fff);--_fg:var(--pele-fg,#111);font-family:var(--pele-font,Arial, sans-serif)"><rect fill="var(--_bg)" width="100" height="50"/><text fill="var(--_fg)">var(--_fg) stays literal</text></svg>';
  const svg=resolvePeleSvg(source,true,'review'),xml=new DOMParser().parseFromString(svg,'image/svg+xml');
  expect(xml.querySelector('rect')!.getAttribute('fill')).toBe('#19171b');expect(xml.querySelector('text')!.getAttribute('fill')).toBe('#e9e2e8');
  expect(xml.querySelector('text')!.textContent).toBe('var(--_fg) stays literal');expect(xml.documentElement.getAttribute('style')).toContain('Arial, sans-serif');
  expect(xml.documentElement.getAttribute('style')).not.toContain('--_');expect(xml.documentElement.id).toBe('review');
});
it('rejects unresolved or cyclic SVG variables for automatic Mermaid fallback',()=>{
  for(const style of ['fill:var(--unknown)','--a:var(--b);--b:var(--a);fill:var(--a)'])expect(()=>resolvePeleSvg(`<svg xmlns="http://www.w3.org/2000/svg" style="${style}"/>`,false,'test')).toThrow();
});
