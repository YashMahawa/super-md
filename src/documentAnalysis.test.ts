import {describe,it,expect} from 'vitest';
import {analyzeDocument} from './documentAnalysis';
import {hasCallouts,maskCode,normalizeCallouts,normalizeMarkdownSource} from './markdownSource';

describe('shared source analysis',()=>{
  it('nests container callouts and keeps literal delimiters inside variable-length code fences',()=>{
    const source=':::callout note Outer\nOuter body\n\n:::callout tip Inner\nInner body\n:::\n\nAfter inner\n\n````text\n:::callout warning Not a callout\n::: \n```\n````\n:::\n\n# After\n';
    const normalized=normalizeMarkdownSource(source);
    expect(normalized.value).toContain('> > [!TIP] Inner\n> > Inner body\n>');
    expect(normalized.value).toContain('> After inner');
    expect(normalized.value).toContain('> :::callout warning Not a callout\n> ::: ');
    expect(normalized.originalOffset(normalized.value.indexOf('# After'))).toBe(source.indexOf('# After'));
    const analysis=analyzeDocument(source);expect(analysis.blocks.map(x=>x.text).join('')).toBe(source);
    expect(analysis.outline.at(-1)?.offset).toBe(source.indexOf('# After'));
  });
  it('does not turn fenced examples or unmatched closes into callouts',()=>{
    const source='~~~text\n:::callout note Literal\n::: \n~~~\n\n::: \n';
    expect(normalizeMarkdownSource(source).value).toBe(source);
  });
  it('reuses immutable raw syntax and keeps source blocks lossless',()=>{
    const source='---\ntitle: Notes\n---\n# Real heading\n\nA paragraph.\n\n1. First\n\n2. Second\n';
    const first=analyzeDocument(source);expect(analyzeDocument(source)).toBe(first);
    expect(first.outline).toEqual([{id:'real-heading',title:'Real heading',level:1,offset:source.indexOf('# Real')}]);
    expect(first.blocks.map(block=>block.text).join('')).toBe(source);
    expect(first.blocks.at(-1)!.text).toContain('2. Second');
  });
  it('maps rendered callout and wiki changes back to original task and heading offsets',()=>{
    const source='---\r\ntitle: Draft\r\n---\r\n# Intro\n\n:::callout tip "Try this"\n- [ ] Visit [[#A long title|here]].\n\nA body.\n:::\n\n## A long title\n\n- [x] Done\n';
    const result=analyzeDocument(source);
    expect(result.tasks).toEqual([source.indexOf('[ ]')+1,source.indexOf('[x]')+1]);
    expect(result.outline.map(heading=>heading.offset)).toEqual([source.indexOf('# Intro'),source.indexOf('## A long')]);
    for(const block of result.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
    const normal=normalizeMarkdownSource(source);expect(normal.value).toContain('> [!TIP] Try this');expect(normal.value).toContain('[here](#a-long-title)');
    expect(normal.originalOffset(normal.value.indexOf('## A long'))).toBe(source.indexOf('## A long'));
  });
  it('keeps math table pipes, SVG blocks and fences compatible with shared parsing',()=>{
    const source='| A | B |\n|---|---|\n| $P(|X|>1)$ | value |\n\n```python\nprint(1)\n\nprint(2)\n```\n\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">\n\n<circle cx="2" cy="2" r="1"/>\n</svg>';
    const result=analyzeDocument(source);expect(result.tree.children[0].type).toBe('table');
    expect(result.tree.children.filter(node=>node.type==='code')).toHaveLength(2);
    expect(result.blocks.map(block=>block.text).join('')).toBe(source);
  });
  it('assigns Python duplicate ordinals by identical source and retains original offsets',()=>{
    const source='```python\nprint(1)\n```\n\n```py\nprint(2)\n```\n\n```python\nprint(1)\n```';
    expect(analyzeDocument(source).pythonCells).toEqual([
      {source:'print(1)',ordinal:0,offset:0},
      {source:'print(2)',ordinal:0,offset:source.indexOf('```py\n')},
      {source:'print(1)',ordinal:1,offset:source.lastIndexOf('```python')},
    ]);
  });
  it('leaves NumPy arrays, smd-chart points, Bash [[ ... ]], C++ [[nodiscard]], and inline code untouched while converting prose wikilinks',()=>{
    const source=[
      '---\ntitle: Technical\n---',
      '# Intro',
      '',
      'Embed ![[diagram.png|Architecture]] and link [[#Matrix Section|section]] plus [[Reference|ref]].',
      '',
      '| Syntax | Meaning |',
      '|---|---|',
      '| `[[Note]]` and `` `![[raw.png]]` `` | [[Table Note|Linked in table]] |',
      '',
      '```python',
      'import numpy as np',
      'arr = np.array([[1, 2], [3, 4]])',
      'single = [[1, 2]]',
      '```',
      '',
      '```smd-chart',
      '{"series":[{"points":[[0,1]]}]}',
      '```',
      '',
      '```bash',
      'if [[ -f "$FILE" ]]; then echo "![[not-image.png]]"; fi',
      '```',
      '',
      '~~~cpp',
      '[[nodiscard]] int value();',
      '~~~',
      '',
      '## Matrix Section',
      '',
      '- [ ] Verify `[[inline]]` before [[Task Note|task link]]',
      '',
    ].join('\n');
    const normalized=normalizeMarkdownSource(source);
    expect(normalized.value).toContain('![Architecture](diagram.png)');
    expect(normalized.value).toContain('[section](#matrix-section)');
    expect(normalized.value).toContain('[ref](Reference.md)');
    expect(normalized.value).toContain('| `[[Note]]` and `` `![[raw.png]]` `` | [Linked in table](Table Note.md) |');
    expect(normalized.value).toContain('arr = np.array([[1, 2], [3, 4]])\nsingle = [[1, 2]]');
    expect(normalized.value).toContain('{"series":[{"points":[[0,1]]}]}');
    expect(normalized.value).toContain('if [[ -f "$FILE" ]]; then echo "![[not-image.png]]"; fi');
    expect(normalized.value).toContain('[[nodiscard]] int value();');
    expect(normalized.value).toContain('- [ ] Verify `[[inline]]` before [task link](Task Note.md)');

    const analysis=analyzeDocument(source);
    expect(analysis.pythonCells).toEqual([
      {
        source:'import numpy as np\narr = np.array([[1, 2], [3, 4]])\nsingle = [[1, 2]]',
        ordinal:0,
        offset:source.indexOf('```python'),
      },
    ]);
    expect(analysis.outline.map(h=>[h.id,h.offset])).toEqual([
      ['intro',source.indexOf('# Intro')],
      ['matrix-section',source.indexOf('## Matrix Section')],
    ]);
    expect(analysis.tasks).toEqual([source.indexOf('[ ]')+1]);
    expect(analysis.blocks.map(b=>b.text).join('')).toBe(source);
    for(const block of analysis.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
  });
  it('masks indented code outside paragraphs and lists while keeping lazy continuations, list paragraphs, and stray backtick wikilinks active',()=>{
    const source=[
      '    indented = [[1, 2]]',
      '',
      'Paragraph with stray ` backtick before [[After Stray]].',
      '    lazy_continuation = [[Lazy Link]]',
      '',
      'Second paragraph with ``unmatched and `[[inline_masked]]` before [[After Inline]].',
      '',
      '- List item',
      '',
      '    list_paragraph = [[List Link]]',
      '',
      '        list_code = [[8, 9]]',
      '',
      '# Heading',
      '    after_heading_code = [[3, 4]]',
      '',
    ].join('\n');
    const masked=maskCode(source);
    expect(masked).toHaveLength(source.length);
    const normalized=normalizeMarkdownSource(source).value;
    expect(normalized).toContain('    indented = [[1, 2]]');
    expect(normalized).toContain('[After Stray](After Stray.md)');
    expect(normalized).toContain('`[[inline_masked]]`');
    expect(normalized).toContain('[After Inline](After Inline.md)');
    expect(normalized).toContain('    lazy_continuation = [Lazy Link](Lazy Link.md)');
    expect(normalized).toContain('    list_paragraph = [List Link](List Link.md)');
    expect(normalized).toContain('        list_code = [[8, 9]]');
    expect(normalized).toContain('    after_heading_code = [[3, 4]]');
  });
  it('rejects backtick fences with backticks in info strings, requires matching closing fences, and tracks blockquote fences in callouts',()=>{
    const infoBacktick='```python `[[inline_code]]` [[Prose Link]]\n:::callout note Real\nBody\n:::\n';
    expect(hasCallouts(infoBacktick)).toBe(true);
    const normInfo=normalizeMarkdownSource(infoBacktick).value;
    expect(normInfo).toContain('`[[inline_code]]`');
    expect(normInfo).toContain('[Prose Link](Prose Link.md)');
    expect(normInfo).toContain('> [!NOTE] Real\n> Body');

    const mismatched=[
      '> ````python',
      '> a = [[1, 2]]',
      '> ```',
      '> still_fenced = [[3, 4]]',
      '> ```` trailing-info',
      '> still_fenced_2 = [[5, 6]]',
      '> ~~~',
      '> still_fenced_3 = [[7, 8]]',
      '> ````   ',
      '> [[Quoted Prose]]',
    ].join('\n');
    const normMismatched=normalizeMarkdownSource(mismatched).value;
    expect(normMismatched).toContain('> a = [[1, 2]]');
    expect(normMismatched).toContain('> still_fenced = [[3, 4]]');
    expect(normMismatched).toContain('> still_fenced_2 = [[5, 6]]');
    expect(normMismatched).toContain('> still_fenced_3 = [[7, 8]]');
    expect(normMismatched).toContain('> [Quoted Prose](Quoted Prose.md)');

    const calloutWithQuotedFence=[
      ':::callout note Outer',
      '```markdown',
      '> ```',
      ':::',
      '```',
      '> ```markdown',
      '> :::callout tip InnerExample',
      '> :::',
      '> ```',
      'Still inside outer [[Outer Link]]',
      ':::',
    ].join('\n');
    const normCallout=normalizeMarkdownSource(calloutWithQuotedFence).value;
    expect(normCallout).toContain('> Still inside outer [Outer Link](Outer Link.md)');
    expect(normCallout.trimEnd().endsWith('> Still inside outer [Outer Link](Outer Link.md)')).toBe(true);

    expect(hasCallouts('```markdown\n:::callout note Fenced\n:::\n```')).toBe(false);
    expect(hasCallouts('> ```markdown\n> :::callout note QuotedFenced\n> :::\n> ```')).toBe(false);
    expect(hasCallouts('---\ntitle: x\n---\n```md\n:::callout note Fenced\n:::\n```\n:::callout tip Real\nOk\n:::')).toBe(true);
  });
  it('normalizes spaced, aliased, portable, and section wikilinks while preserving sparse UTF-16 source offsets',()=>{
    expect(normalizeCallouts('[[Task Note]]')).toBe('[Task Note](Task%20Note.md)');
    expect(normalizeCallouts('[[Lecture 2#Bayes Law|Bayes]]')).toBe('[Bayes](Lecture%202.md#bayes-law)');
    expect(normalizeCallouts('[[Lecture 2#Bayes]]')).toBe('[Lecture 2#Bayes](Lecture%202.md#bayes)');
    expect(normalizeCallouts('[[study.smd]]')).toBe('[study.smd](study.smd)');
    expect(normalizeCallouts('[[Study Deck.smd#Card 1|First card]]')).toBe('[First card](Study%20Deck.smd#card-1)');
    expect(normalizeCallouts('[[archive.fmd]]')).toBe('[archive.fmd](archive.fmd)');
    expect(normalizeCallouts('[[notes.markdown#Intro]]')).toBe('[notes.markdown#Intro](notes.markdown#intro)');
    expect(normalizeCallouts('![[DM Images/proof.svg|300]]')).toBe('![DM Images/proof.svg](DM%20Images/proof.svg){width=300}');
    expect(normalizeCallouts('[[   ]]')).toBe('[[   ]]');
    expect(normalizeCallouts('Keep `[[Task Note]]` and $P([[A]]) = 1$ literal.')).toBe('Keep `[[Task Note]]` and $P([[A]]) = 1$ literal.');

    const source=[
      '---',
      'title: Study Index',
      '---',
      '# Study 🧠 Index',
      '',
      'Open [[Task Note]], [[Lecture 2#Bayes Law|Bayes]], and [[study.smd]].',
      '',
      '- [ ] Review after wikilinks',
      '',
      '## Follow-up Section',
    ].join('\n');
    const stage=normalizeMarkdownSource(source,{encodeLinkDestinations:true});
    const tailMarker='## Follow-up Section';
    expect(stage.originalOffset(stage.value.indexOf(tailMarker))).toBe(source.indexOf(tailMarker));
    const analysis=analyzeDocument(source);
    expect(analysis.tasks).toEqual([source.indexOf('[ ]')+1]);
    expect(analysis.outline.map(item=>[item.id,item.offset])).toEqual([
      ['study--index',source.indexOf('# Study 🧠 Index')],
      ['follow-up-section',source.indexOf('## Follow-up Section')],
    ]);
    for(const block of analysis.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
  });
  it('rewrites numeric Obsidian pipe widths to {width=...} while preserving non-numeric captions and offsets',()=>{
    const source='![[diagram.png|300]] and ![[diagram.png|300x180]] and ![[diagram.png|Caption|240]] vs ![[diagram.png|Architecture]]\n\n# Heading After\n';
    const normalized=normalizeMarkdownSource(source);
    expect(normalized.value).toContain('![diagram.png](diagram.png){width=300}');
    expect(normalized.value).toContain('![diagram.png](diagram.png){width=300}');
    expect(normalized.value).toContain('![Caption](diagram.png){width=240}');
    expect(normalized.value).toContain('![Architecture](diagram.png)');
    expect(normalized.originalOffset(normalized.value.indexOf('# Heading After'))).toBe(source.indexOf('# Heading After'));
    const analysis=analyzeDocument(source);
    expect(analysis.outline[0]?.offset).toBe(source.indexOf('# Heading After'));
  });
  it('strips paired %%...%% comments outside code and math while preserving original offsets and lossless blocks',()=>{
    const source=[
      '%%Draft header',
      'spanning multiple lines%%',
      '# Water H~2~O %%inline note%%',
      '',
      'Visible before %%hidden middle%% visible after, plus unmatched %% marker.',
      '',
      'Inline `%%kept_inline%%` and math $a %% b$ plus:',
      '',
      '$$',
      '%% kept tex comment',
      'x^2 + y^2',
      '$$',
      '',
      '```python',
      '%%timeit x = 1',
      'print("%%still_code%%")',
      '```',
      '',
      '## Next ^2^ Section',
      '',
      '- [ ] Check ==important== task',
      '',
    ].join('\n');

    const normalized=normalizeMarkdownSource(source);
    expect(normalized.value).not.toContain('Draft header');
    expect(normalized.value).not.toContain('inline note');
    expect(normalized.value).not.toContain('hidden middle');
    expect(normalized.value).toContain('unmatched %% marker.');
    expect(normalized.value).toContain('`%%kept_inline%%`');
    expect(normalized.value).toContain('$a %% b$');
    expect(normalized.value).toContain('%% kept tex comment');
    expect(normalized.value).toContain('%%timeit x = 1');
    expect(normalized.originalOffset(normalized.value.indexOf('## Next'))).toBe(source.indexOf('## Next'));

    const analysis=analyzeDocument(source);
    expect(analysis.outline).toEqual([
      {id:'water-h2o',title:'Water H2O',level:1,offset:source.indexOf('# Water')},
      {id:'next-2-section',title:'Next 2 Section',level:2,offset:source.indexOf('## Next')},
    ]);
    expect(analysis.tasks).toEqual([source.indexOf('[ ]')+1]);
    expect(analysis.pythonCells).toEqual([
      {
        source:'%%timeit x = 1\nprint("%%still_code%%")',
        ordinal:0,
        offset:source.indexOf('```python'),
      },
    ]);
    expect(analysis.blocks.map(b=>b.text).join('')).toBe(source);
    for(const block of analysis.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
  });
  it('preserves escapes, code fences, and interleaved inline/display math boundaries without blank lines',()=>{
    const source=[
      'Item 1 costs $50 %%stripped_before_flow_math%% and keeps \\%%escaped_one\\%% plus \\$50.',
      '$$',
      '%% kept_flow_tex_comment',
      'a_1 + b_1 = 1',
      '$$',
      'Item 2 has $x_2 %% kept_inline_math$, \\\\%%stripped_after_slash%%, \\\\$y_2 %% kept_after_slash$, and costs $75 %%stripped_before_fence%%.',
      '```python',
      '%%timeit x = 1',
      '```',
      '~~~markdown',
      '%%kept_tilde_fence%%',
      '~~~',
      '> ````markdown',
      '> ```',
      '> %%kept_quoted_fence%%',
      '> ```',
      '> ````',
      'Item 3 has $z_3 = 1$, costs $90, and has $$c_3 %% kept_compact_display$$ %%stripped_after_compact%% plus \\$\\$not_math\\$\\$ %%stripped_after_escaped_display%%.',
      '$$d_4 %% kept_line_display$$ %%stripped_line_display%%',
      '# Final Section',
    ].join('\n');

    const normalized=normalizeMarkdownSource(source);
    expect(normalized.value).not.toContain('stripped_before_flow_math');
    expect(normalized.value).not.toContain('stripped_before_fence');
    expect(normalized.value).not.toContain('stripped_after_slash');
    expect(normalized.value).not.toContain('stripped_after_compact');
    expect(normalized.value).not.toContain('stripped_after_escaped_display');
    expect(normalized.value).not.toContain('stripped_line_display');
    expect(normalized.value).toContain('\\%%escaped_one\\%%');
    expect(normalized.value).toContain('kept_flow_tex_comment');
    expect(normalized.value).toContain('$x_2 %% kept_inline_math$');
    expect(normalized.value).toContain('\\\\$y_2 %% kept_after_slash$');
    expect(normalized.value).toContain('%%timeit x = 1');
    expect(normalized.value).toContain('%%kept_tilde_fence%%');
    expect(normalized.value).toContain('%%kept_quoted_fence%%');
    expect(normalized.value).toContain('$$c_3 %% kept_compact_display$$');
    expect(normalized.value).toContain('$$d_4 %% kept_line_display$$');
    expect(normalized.originalOffset(normalized.value.indexOf('# Final Section'))).toBe(source.indexOf('# Final Section'));

    const analysis=analyzeDocument(source);
    expect(analysis.outline).toEqual([
      {id:'final-section',title:'Final Section',level:1,offset:source.indexOf('# Final Section')},
    ]);
    expect(analysis.blocks.map(b=>b.text).join('')).toBe(source);
  });
  it('retains wikilink labels, spaces, fragments, math-masked brackets, and original source offsets alongside percent-comment stripping',()=>{
    const source=[
      '---',
      'title: Combined Study Links',
      '---',
      '%%leading draft comment%%',
      '# Combined Overview',
      '',
      'Before %%inline comment%%[[Lecture 2#Bayes Law|Bayes]] and [[Task Note]] plus [[Study Deck.smd#Card 1|First card]] and [guide](Study Notes/guide.md#intro).',
      'Math keeps $P([[A]]) = 1 %% kept_inline$ and $$Q([[B]]) = 2 %% kept_display$$ literal, while budget $50 to $99 %%stripped_tail%% stays linear.',
      '',
      '- [ ] Check [[Reference Note#Section Two|Ref Label]] after comments',
      '',
      '## Follow-up Heading',
    ].join('\n');

    const normalized=normalizeMarkdownSource(source,{encodeLinkDestinations:true});
    expect(normalized.value).not.toContain('leading draft comment');
    expect(normalized.value).not.toContain('inline comment');
    expect(normalized.value).not.toContain('stripped_tail');
    expect(normalized.value).toContain('[Bayes](Lecture%202.md#bayes-law)');
    expect(normalized.value).toContain('[Task Note](Task%20Note.md)');
    expect(normalized.value).toContain('[First card](Study%20Deck.smd#card-1)');
    expect(normalized.value).toContain('[guide](Study%20Notes/guide.md#intro)');
    expect(normalized.value).toContain('$P([[A]]) = 1 %% kept_inline$');
    expect(normalized.value).toContain('$$Q([[B]]) = 2 %% kept_display$$');
    expect(normalized.originalOffset(normalized.value.indexOf('## Follow-up Heading'))).toBe(source.indexOf('## Follow-up Heading'));

    const analysis=analyzeDocument(source);
    expect(analysis.tasks).toEqual([source.indexOf('[ ]')+1]);
    expect(analysis.outline).toEqual([
      {id:'combined-overview',title:'Combined Overview',level:1,offset:source.indexOf('# Combined Overview')},
      {id:'follow-up-heading',title:'Follow-up Heading',level:2,offset:source.indexOf('## Follow-up Heading')},
    ]);
    const links:Array<{slice:string;wikilink?:string;fragment?:string}>=[];
    const collectLinks=(node:any)=>{
      if(node?.type==='link'&&node.position?.start?.offset!==undefined&&node.position?.end?.offset!==undefined){
        const props=(node.data as any)?.hProperties||{};
        links.push({
          slice:source.slice(node.position.start.offset,node.position.end.offset),
          wikilink:props['data-wikilink'],
          fragment:props['data-heading-fragment'],
        });
      }
      if(Array.isArray(node?.children))for(const child of node.children)collectLinks(child);
    };
    collectLinks(analysis.tree);
    expect(links).toEqual([
      {slice:'[[Lecture 2#Bayes Law|Bayes]]',wikilink:'Lecture 2',fragment:'Bayes Law'},
      {slice:'[[Task Note]]',wikilink:'Task Note',fragment:undefined},
      {slice:'[[Study Deck.smd#Card 1|First card]]',wikilink:'Study Deck.smd',fragment:'Card 1'},
      {slice:'[guide](Study Notes/guide.md#intro)',wikilink:undefined,fragment:undefined},
      {slice:'[[Reference Note#Section Two|Ref Label]]',wikilink:'Reference Note',fragment:'Section Two'},
    ]);
    expect(analysis.blocks.map(b=>b.text).join('')).toBe(source);
    for(const block of analysis.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
  });
  it('scales linearly on large notes with interleaved inline math, display math, percent comments, escapes, and code fences',()=>{
    const sections:string[]=[];
    for(let i=0;i<300;i++){
      sections.push(
        `Paragraph ${i}: inline $a_${i} + b_${i} = 100\\%$ and $p_${i} %% kept_inline_${i}$ %%strip_inline_${i}%% with budget $50 (\\$escaped, \\%%kept_lit_${i}\\%%) and $$m_${i} %% kept_compact_${i}$$.\n`+
        `$$\n%% kept_display_${i}\n\\sum_{k=1}^{n} x_k = ${i}\n$$\n`+
        (i%2===0
          ?`\`\`\`python\n%%timeit total = ${i}\n\`\`\``
          :`~~~markdown\n%%kept_fenced_${i}%%\n~~~`),
      );
    }
    const ledger:string[]=[];
    for(let j=0;j<2400;j++){
      ledger.push(`Ledger ${j}: allocation $50 to $99 per node (\\$fee, \\%%lit_${j}\\%%) %%strip_ledger_${j}%%`);
    }
    sections.push(ledger.join('\n'));
    sections.push('# Tail Heading');
    const largeDoc=sections.join('\n\n');

    const start=performance.now();
    const normalized=normalizeMarkdownSource(largeDoc);
    const elapsedMs=performance.now()-start;

    // Reverted O(N^2) math lookahead takes >5,000 ms on 2,400 unmatched-$ lines (~260 KB) and corrupts interleaved $$ blocks.
    expect(elapsedMs).toBeLessThan(800);
    expect(normalized.value).toContain('kept_inline_0');
    expect(normalized.value).toContain('kept_compact_299');
    expect(normalized.value).toContain('kept_display_299');
    expect(normalized.value).toContain('%%timeit total = 298');
    expect(normalized.value).toContain('%%kept_fenced_299%%');
    expect(normalized.value).toContain('\\%%kept_lit_150\\%%');
    expect(normalized.value).toContain('\\%%lit_2399\\%%');
    expect(normalized.value).not.toContain('strip_inline_0');
    expect(normalized.value).not.toContain('strip_inline_299');
    expect(normalized.value).not.toContain('strip_ledger_0');
    expect(normalized.value).not.toContain('strip_ledger_2399');
    expect(normalized.originalOffset(normalized.value.indexOf('# Tail Heading'))).toBe(largeDoc.indexOf('# Tail Heading'));
  });
});
