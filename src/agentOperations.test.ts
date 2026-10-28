import {describe,it,expect} from 'vitest';
import {applyAgentPatches,applyAgentPatchesDetailed,agentRead,agentSearch,agentOutline,agentOutlinePage,agentSection,agentSectionForExport} from './agentOperations';
describe('live agent document operations',()=>{
  it('uses Unicode code points without splitting emoji',()=>{
    expect(agentRead('α😀z',1,1).text).toBe('😀');
    expect(agentSearch('😀 prefix\nword 😀 word','word',2,0).matches.map(match=>[match.offset,match.line])).toEqual([[9,2],[16,2]]);
    expect(agentSearch('😀x','x',1,1).matches[0]).toMatchObject({offset:1,matchOffset:1,matchLength:1,snippetOffset:0,text:'😀x'});
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
  it('resolves exact titles, slugs and numbered prefixes to paginated nested sections',()=>{
    const source='😀 Preamble\n# Intro\n\n## 7.4 Methods\nA paragraph with details.\n### Nested\nNested content stays in the parent section.\n## 7.40 Other\nOther section.\n';
    const start=Array.from(source.slice(0,source.indexOf('## 7.4 Methods'))).length;
    const finish=Array.from(source.slice(0,source.indexOf('## 7.40 Other'))).length;
    let page=agentRead(source,0,32,'7.4','source'),combined=page.text;
    expect(page.start).toBe(start);expect(page.sectionStart).toBe(start);expect(page.sectionEnd).toBe(finish);
    expect(page.documentLength).toBe(Array.from(source).length);expect(page.truncated).toBe(true);
    while(page.next_offset!==null){page=agentRead(source,page.next_offset,32,'7.4 Methods','source');combined+=page.text;
      expect(page.sectionStart).toBe(start);expect(page.sectionEnd).toBe(finish);}
    expect(combined).toBe(Array.from(source).slice(start,finish).join(''));
    expect(combined).toContain('### Nested');expect(combined).not.toContain('7.40 Other');
    expect(agentRead(source,0,32,'7-4-methods','source').sectionStart).toBe(start);
    const exported=agentSection(source,'7.4');
    expect(exported.text).toBe(Array.from(source).slice(start,finish).join(''));
    expect(exported.text).toContain('### Nested');expect(exported.text).not.toContain('Other section.');
    expect(exported.documentLength).toBe(Array.from(source).length);
    expect(source).toContain('Other section.');
    const numbered=agentRead(source,0,32,'7.40','source');
    expect(numbered.sectionStart).toBe(Array.from(source.slice(0,source.indexOf('## 7.40 Other'))).length);
    const numericSource='# 2. Findings\nTop section.\n## 2.1 Child\nNested section.\n# 20. Other\nOther section.\n';
    const numeric=agentRead(numericSource,0,100,'2','source');
    expect(numeric.sectionStart).toBe(0);expect(numeric.sectionEnd).toBe(numericSource.indexOf('# 20. Other'));
    expect(numeric.text).toContain('2.1 Child');expect(numeric.text).not.toContain('20. Other');
  });
  it('rejects ambiguous exact headings with bounded candidates and pages outlines',()=>{
    const duplicate=Array.from({length:8},(_,index)=>`# Duplicate\nEntry ${index}\n`).join('');
    expect(()=>agentRead(duplicate,0,100,'Duplicate','source')).toThrow(/ambiguous \(8 matches\).*0: Duplicate.*; …/);
    const source=Array.from({length:85},(_,index)=>`# Section ${index}\nBody ${index}\n`).join('');
    const page=agentOutlinePage(source,80,5);
    expect(page.headings.map(item=>item.title)).toEqual(['Section 80','Section 81','Section 82','Section 83','Section 84']);
    expect(page.headings[0].sectionStart).toBe(page.headings[0].start);
    expect(page.headings[0].sectionEnd).toBe(page.headings[1].sectionStart);
    expect(page.total).toBe(85);expect(page.offset).toBe(80);expect(page.documentLength).toBe(Array.from(source).length);
    expect(page.nextOffset).toBeNull();expect(page.truncated).toBe(false);
    expect(agentOutlinePage(source,0,80).nextOffset).toBe(80);expect(agentOutlinePage(source,0,80).truncated).toBe(true);
  });
  it('continues a long selected section from next_offset without leaking its next section',()=>{
    const body='Body 🧭 stays in this section.\n'.repeat(600),source=`# Intro\n## Long Section\n${body}## Next Section\nDo not include this text.\n`;
    const first=agentRead(source,0,12_000,'Long Section','source');
    expect(first.start).toBe(Array.from(source.slice(0,source.indexOf('## Long Section'))).length);
    expect(Array.from(first.text).length).toBe(12_000);expect(first.truncated).toBe(true);
    const second=agentRead(source,first.next_offset,12_000,'Long Section','source');
    expect(second.start).toBe(first.next_offset);expect(second.sectionStart).toBe(first.sectionStart);expect(second.sectionEnd).toBe(first.sectionEnd);
    expect(second.next_offset).toBeNull();expect(second.truncated).toBe(false);
    expect(second.text).toContain('Body 🧭');expect(second.text).not.toContain('Do not include this text.');
  });
  it('carries only external first reference definitions into an export slice',()=>{
    const source='[image]: assets/first.png\n[image]: assets/second.png\n[docs]: https://example.test/docs\n[unused]: assets/unused.png\n\n# Chosen\n![hero][image] and [manual][docs].\n\n`[fake][unused]`\n\n# Other\nOther section.\n';
    const original=source,exported=agentSectionForExport(source,'Chosen'),exact=agentSection(source,'Chosen');
    expect(exact.text).toBe(source.slice(source.indexOf('# Chosen'),source.indexOf('# Other')));
    expect(exported.text).toContain('![hero][image] and [manual][docs].');
    expect(exported.text).toContain('[image]: assets/first.png');
    expect(exported.text).not.toContain('[image]: assets/second.png');
    expect(exported.text).toContain('[docs]: https://example.test/docs');
    expect(exported.text).not.toContain('[unused]: assets/unused.png');
    expect(exported.text).not.toContain('Other section.');
    expect(source).toBe(original);
  });
  it('applies exact replacements and bounded line edits without changing other bytes',()=>{
    expect(applyAgentPatches('one\r\ntwo\r\nthree',[{type:'replace',old:'two',new:'😀'},{type:'lines',start_line:3,end_line:3,text:'end'}])).toBe('one\r\n😀\r\nend');
    expect(()=>applyAgentPatches('repeat repeat',[{type:'replace',old:'repeat',new:'x'}])).toThrow('found 2');
    expect(()=>applyAgentPatches('one',[{type:'lines',start_line:0,end_line:1,text:'x'}])).toThrow();
    expect(()=>applyAgentPatches('one',[{type:'lines',start_line:1,text:'x'}])).toThrow('operations[0]: lines.end_line');
    expect(applyAgentPatches('one\n',[{type:'lines',start_line:2,end_line:2,text:'new'}])).toBe('one\nnew');
    expect(applyAgentPatches('one',[{type:'insert',line:2,text:'new'}])).toBe('one\nnew');
  });

  it('pages search by code-point offsets and preserves all matches on a line',()=>{
    const source='😀 ward Ward afterward\nward ward';
    const first=agentSearch(source,'ward',2,0,{offset:0});
    expect(first.matches.map(match=>[match.matchOffset,match.matchLength,match.line])).toEqual([[2,4,1],[7,4,1]]);
    expect(first.totalMatches).toBe(5);expect(first.remainingMatches).toBe(5);expect(first.nextOffset).toBe(11);expect(first.truncated).toBe(true);
    const second=agentSearch(source,'ward',2,0,{offset:first.nextOffset,caseSensitive:true,wholeWord:true});
    expect(second.matches.map(match=>match.matchOffset)).toEqual([22,27]);
    expect(second.totalMatches).toBe(3);expect(second.remainingMatches).toBe(2);expect(second.nextOffset).toBeNull();
  });
  it('keeps totalMatches stable across pages and handles an exhausted cursor',()=>{
    const source='x '.repeat(30),first=agentSearch(source,'x',25,0);
    expect(first.matches).toHaveLength(25);expect(first.totalMatches).toBe(30);expect(first.remainingMatches).toBe(30);
    expect(first.truncated).toBe(true);expect(first.nextOffset).not.toBeNull();
    const second=agentSearch(source,'x',25,0,{offset:first.nextOffset});
    expect(second.matches).toHaveLength(5);expect(second.totalMatches).toBe(30);expect(second.remainingMatches).toBe(5);
    expect(second.truncated).toBe(false);expect(second.nextOffset).toBeNull();
    const exhausted=agentSearch(source,'x',25,0,{offset:source.length});
    expect(exhausted.matches).toEqual([]);expect(exhausted.totalMatches).toBe(30);expect(exhausted.remainingMatches).toBe(0);
    expect(exhausted.truncated).toBe(false);expect(exhausted.nextOffset).toBeNull();
  });
  it('uses fixed-width safe regex and rejects unsafe quantifiers',()=>{
    expect(agentSearch('ax ay az','a.',10,0,{regex:true}).matches.map(match=>match.text)).toEqual(['ax','ay','az']);
    expect(()=>agentSearch('aaaa','a+',10,0,{regex:true})).toThrow('quantifiers');
  });
  it('reports strict sequential patch summaries with code-point ranges',()=>{
    const result=applyAgentPatchesDetailed('😀 alpha\nbeta',[{type:'replace',old:'alpha',new:'A'},{type:'insert',line:2,text:'new\n'}]);
    expect(result.text).toBe('😀 A\nnew\nbeta');expect(result.applied).toBe(2);
    expect(result.operations).toEqual([{operationIndex:0,type:'replace',startOffset:2,endOffset:7,deltaChars:-4},{operationIndex:1,type:'insert',startOffset:4,endOffset:4,deltaChars:4}]);
    expect(applyAgentPatches('x x',[{type:'replace',old:'x',new:'y',expectedCount:2}])).toBe('y y');
    expect(applyAgentPatches('x x',[{type:'replace',old:'x',new:'y',count:'all'}])).toBe('y y');
    expect(()=>applyAgentPatches('x x',[{type:'replace',old:'x',new:'y',count:'all',expectedCount:3}])).toThrow('operations[0]');
    expect(()=>applyAgentPatches('x',[{type:'replace',old:'x',new:'y',oldText:'x'}])).toThrow("Unknown field 'oldText'");
  });
  it('rejects an invalid later operation before exposing a partial result',()=>{
    const source='original';expect(()=>applyAgentPatches(source,[{type:'replace',old:'original',new:'changed'},{type:'replace',old:'missing',new:'x'}])).toThrow();expect(source).toBe('original');
  });
});
