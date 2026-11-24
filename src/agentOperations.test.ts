import {describe,it,expect} from 'vitest';
import {agentCharLength,agentCodePointOffset,agentUtf16Offset,applyAgentPatches,applyAgentPatchesDetailed,agentRead,agentSearch,agentOutline,agentOutlinePage,agentSection,agentSectionForExport} from './agentOperations';
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
  it('indexes astral pairs and unpaired surrogates across 512-code-point checkpoints',()=>{
    const unit='a😀\ud83dx\ude00y🧭';
    const text=unit.repeat(180)+'\ud83d';
    const points=Array.from(text);
    expect(agentCharLength(text)).toBe(points.length);
    for(const cp of [0,1,2,3,4,511,512,513,1023,1024,1025,points.length-1,points.length]){
      const expectedUtf16=points.slice(0,cp).join('').length;
      expect(agentUtf16Offset(text,cp)).toBe(expectedUtf16);
      expect(agentCodePointOffset(text,expectedUtf16)).toBe(cp);
    }
    const emojiIndex=text.indexOf('😀',900);
    expect(agentCodePointOffset(text,emojiIndex+1)).toBe(Array.from(text.slice(0,emojiIndex+1)).length);
    expect(()=>agentUtf16Offset(text,-1)).toThrow('non-negative');
    expect(()=>agentUtf16Offset(text,points.length+1)).toThrow('beyond the document');
  });
  it('tracks surrogate pairing and splitting across 1-unit patch boundary windows',()=>{
    const pairedByLines=applyAgentPatchesDetailed('a\ud83d',[{type:'lines',start_line:2,end_line:2,text:'\ude00'},{type:'replace',old:'a',new:'b'}]);
    expect(pairedByLines.text).toBe('b😀');
    expect(pairedByLines.operations[0]).toEqual({operationIndex:0,type:'lines',startOffset:2,endOffset:2,deltaChars:0});
    const pairJoin=applyAgentPatchesDetailed('\ud83dx\ude00',[{type:'replace',old:'x',new:''}]);
    expect(pairJoin.text).toBe('😀');
    expect(pairJoin.operations[0]).toEqual({operationIndex:0,type:'replace',startOffset:1,endOffset:2,deltaChars:-2});
    const pairSplit=applyAgentPatchesDetailed('😀',[{type:'replace',old:'\ude00',new:'x'}]);
    expect(pairSplit.text).toBe('\ud83dx');
    expect(pairSplit.operations[0]).toMatchObject({deltaChars:1});
    const multiGap=applyAgentPatchesDetailed('\ud83dxx\ude00',[{type:'replace',old:'x',new:'',count:'all'}]);
    expect(multiGap.text).toBe('😀');
    expect(multiGap.operations[0]).toEqual({operationIndex:0,type:'replace',startOffset:1,endOffset:3,deltaChars:-3});
    const lineBoundaryPair=applyAgentPatchesDetailed('head\ud83d',[{type:'lines',start_line:2,end_line:2,text:'\ude00tail'}]);
    expect(lineBoundaryPair.text).toBe('head😀tail');
    expect(lineBoundaryPair.operations[0]).toEqual({operationIndex:0,type:'lines',startOffset:5,endOffset:5,deltaChars:4});
  });
  it('preserves all Unicode line breaks and neighbor merges without trailing newlines',()=>{
    const mixed='# One\r\n# Two\r# Three\v# Four\f# Five\x85# Six\u2028# Seven\u2029# Eight';
    const outline=agentOutline(mixed);
    expect(outline.map(h=>[h.title,h.line])).toEqual([['One',1],['Two',2],['Three',3],['Four',4],['Five',5],['Six',6],['Seven',7],['Eight',8]]);
    expect(agentOutlinePage(mixed,0,8).documentLength).toBe(Array.from(mixed).length);
    const merged=applyAgentPatchesDetailed('alpha\r\nbeta',[
      {type:'insert',line:2,text:'prefix-'},
      {type:'insert',line:3,text:'gamma'},
      {type:'lines',start_line:1,end_line:1,text:'ALPHA'},
    ]);
    expect(merged.text).toBe('ALPHA\nprefix-beta\r\ngamma');
    const crlfJoin=applyAgentPatches('top\r',[{type:'lines',start_line:2,end_line:2,text:'\nnext\nlast'}]);
    expect(crlfJoin).toBe('top\r\nnext\nlast');
  });
  it('handles İ length shifts, context-free Σ folding, unpaired surrogates and excludeDiagrams in search',()=>{
    const tr='İstanbul İki 😀 İstanbul';
    const byUpper=agentSearch(tr,'İSTANBUL',10,2);
    expect(byUpper.matches.map(m=>[m.matchOffset,m.matchLength])).toEqual([[0,8],[15,8]]);
    expect(byUpper.matches[1].text).toBe('😀 İstanbul');
    const byExpanded=agentSearch(tr,'i\u0307stanbul',10,0);
    expect(byExpanded.matches.map(m=>[m.matchOffset,m.matchLength])).toEqual([[0,8],[15,8]]);
    expect(agentSearch('İstanbul','i',10,0).matches).toEqual([]);
    expect(agentSearch('\u0130\u0307\u0307','\u0307\u0307',10,0).matches.map(m=>[m.matchOffset,m.matchLength])).toEqual([[1,2]]);

    const greek='ΑΣ Σα ς';
    expect(agentSearch(greek,'σ',10,0).matches.map(m=>m.matchOffset)).toEqual([1,3]);
    expect(agentSearch(greek,'Σ',10,0).matches.map(m=>m.matchOffset)).toEqual([1,3]);
    expect(agentSearch(greek,'ς',10,0).matches.map(m=>m.matchOffset)).toEqual([6]);

    expect(agentSearch('😀\ude00','\ude00',10,0,{caseSensitive:true}).matches.map(m=>m.matchOffset)).toEqual([1]);
    expect(agentSearch('😀target αtarget target_1 target','target',10,0,{wholeWord:true}).matches.map(m=>m.matchOffset)).toEqual([1,25]);

    const withDiagrams='😀 intro target\n```mermaid\ngraph TD\n  target-->B\n```\n```\n<svg>target</svg>\n```\nfinal target';
    const filtered=agentSearch(withDiagrams,'target',10,4,{excludeDiagrams:true});
    expect(filtered.totalMatches).toBe(2);
    expect(filtered.matches.map(m=>[m.matchOffset,m.line])).toEqual([[8,1],[84,9]]);
  });
  it('applies 100-patch batches and enforces the exact 20 MB UTF-8 byte limit',()=>{
    const initial=Array.from({length:120},(_,i)=>`Line ${i} 🧭 <token_${i}>\n`).join('');
    const ops=Array.from({length:100},(_,i)=>
      i%3===0?{type:'replace' as const,old:`<token_${i}>`,new:`<patched_${i}_😀>`}:
      i%3===1?{type:'lines' as const,start_line:i+1,end_line:i+1,text:`Edited ${i} 🧪 <token_${i}>\n`}:
      {type:'insert' as const,line:i+1,text:`Inserted ${i}\n`}
    );
    let expected=initial;
    const stepSummaries=ops.map((op,idx)=>{
      const single=applyAgentPatchesDetailed(expected,[op]);
      expected=single.text;
      return {...single.operations[0],operationIndex:idx};
    });
    const batch=applyAgentPatchesDetailed(initial,ops);
    expect(batch.applied).toBe(100);
    expect(batch.text).toBe(expected);
    expect(batch.operations).toEqual(stepSummaries);

    const longLeft='x'+'😀'.repeat(40)+'\ud83d',longRight='y😀'+'z'.repeat(80)+'\r\n';
    const peeled=applyAgentPatchesDetailed(longLeft,[
      {type:'lines',start_line:2,end_line:2,text:'\ude00mid\n'+longRight},
      {type:'insert',line:2,text:'ins\n'},
      {type:'replace',old:'mid',new:'MID'},
    ]);
    expect(peeled.text).toBe('x'+'😀'.repeat(41)+'MID\nins\n'+longRight);
    expect(peeled.operations.map(item=>[item.startOffset,item.endOffset,item.deltaChars])).toEqual([[42,42,88],[46,46,4],[42,45,0]]);

    const nearCap='😀'.repeat(4_999_999)+'a\ud83d'; // 19,999,996 + 1 + 3 = 20,000,000 UTF-8 bytes
    expect(applyAgentPatches(nearCap,[{type:'replace',old:'a',new:'b'}]).length).toBe(nearCap.length);
    const detailedNearCap=applyAgentPatchesDetailed(nearCap,[{type:'replace',old:'a',new:'b'}]);
    expect(detailedNearCap.operations[0]).toEqual({operationIndex:0,type:'replace',startOffset:4_999_999,endOffset:5_000_000,deltaChars:0});
    expect(()=>applyAgentPatches(nearCap,[{type:'lines',start_line:2,end_line:2,text:'\ude00'}])).toThrow('exceeds 20 MB');
    expect(()=>applyAgentPatchesDetailed(nearCap,[{type:'lines',start_line:2,end_line:2,text:'\ude00'}])).toThrow('exceeds 20 MB');
  });
});
