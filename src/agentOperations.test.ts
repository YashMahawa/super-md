import {describe,it,expect} from 'vitest';
import {applyAgentPatches,agentRead,agentSearch,agentOutline} from './agentOperations';
describe('live agent document operations',()=>{
  it('uses Unicode code points without splitting emoji',()=>{
    expect(agentRead('α😀z',1,1).text).toBe('😀');
    expect(agentSearch('😀 prefix\nword 😀 word','word',2,0).matches.map(match=>[match.offset,match.line])).toEqual([[9,2],[16,2]]);
  });
  it('elides fenced SVG in prose reads while keeping exact Unicode source offsets available',()=>{
    const svg='<svg>😀'+('<path/>'.repeat(20_000))+'</svg>';
    const source='# Figure\n```svg\n'+svg+'\n```\nAfter\n';
    const prose=agentRead(source,0,12_000);
    expect(prose.text).not.toContain('<svg>');
    expect(prose.text.length).toBeLessThan(200);
    expect(prose.start).toBe(0);
    expect(prose.end).toBe(Array.from(source).length);
    expect(prose.next_offset).toBeNull();
    expect(prose.text).toContain('After');
    expect(prose.svg_omissions[0]).toMatchObject({source_start:16,line_start:3,line_end:3});
    const exact=agentRead(source,0,12_000,undefined,'source');
    expect(exact.text).toContain('<svg>');
    expect(exact.text).toBe(source.slice(0,12_001));
  });
  it('skips an oversized SVG body while retaining a bounded following prose page',()=>{
    const svg='<svg>😀'+('<path/>'.repeat(30_000))+'</svg>';
    const prefix='# Figure 🧭\n```svg\n',after='After the drawing. '.repeat(3000);
    const source=prefix+svg+'\n```\n'+after;
    const first=agentRead(source,0,12_000);
    const omitted=first.svg_omissions[0];
    expect(omitted.source_start).toBe(Array.from(prefix).length);
    expect(first.end).toBe(omitted.source_end+12_000-omitted.source_start);
    expect(first.next_offset).toBe(first.end);
    expect(first.text).toContain('[SVG omitted:');
    expect(first.text).toContain('After the drawing.');
    expect(first.text).not.toContain('<path/>');
    const next=agentRead(source,first.next_offset,12_000);
    expect(next.text).not.toContain('[SVG omitted:');
    expect(next.text).toBe(Array.from(source).slice(first.next_offset!,next.end).join(''));
    expect(next.text).toContain('After the drawing.');
    const exact=agentRead(source,0,12_000,undefined,'source');
    expect(exact.end).toBe(12_000);
    expect(exact.text).toBe(Array.from(source).slice(0,12_000).join(''));
  });
  it('does not leak fenced artwork into an outline',()=>{
    expect(agentOutline('# Intro\n\n```svg\n# Not a heading\n```\n\n## Later\n').map(heading=>[heading.title,heading.line])).toEqual([['Intro',1],['Later',7]]);
  });
  it('applies exact replacements and bounded line edits without changing other bytes',()=>{
    expect(applyAgentPatches('one\r\ntwo\r\nthree',[{type:'replace',old:'two',new:'😀'},{type:'lines',start_line:3,end_line:3,text:'end'}])).toBe('one\r\n😀\r\nend');
    expect(()=>applyAgentPatches('repeat repeat',[{type:'replace',old:'repeat',new:'x'}])).toThrow('found 2');
    expect(()=>applyAgentPatches('one',[{type:'lines',start_line:0,end_line:1,text:'x'}])).toThrow();
    expect(applyAgentPatches('one\n',[{type:'lines',start_line:2,end_line:2,text:'new'}])).toBe('one\nnew');
  });
  it('rejects an invalid later operation before exposing a partial result',()=>{
    const source='original';expect(()=>applyAgentPatches(source,[{type:'replace',old:'original',new:'changed'},{type:'replace',old:'missing',new:'x'}])).toThrow();expect(source).toBe('original');
  });
});
