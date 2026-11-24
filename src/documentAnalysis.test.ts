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
    const source=[
      '---',
      'title: Spaced Wikilinks',
      '---',
      '# Course Hub 🚀',
      '',
      'Read [[Task Note]], [[Lecture 2#Bayes Law|Bayes 🧪]], [[study.smd]], [[legacy.fmd|Legacy Deck]], and [[#Course Hub 🚀|top]].',
      '',
      '![[DM Images/proof diagram.svg|Proof Diagram]]',
      '',
      '- [ ] Complete [[Task Note|first task]]',
      '',
      '## Follow-up Section',
      '',
      '- [x] Review `[[Task Note]]` and $P([[A]]) = 1$',
      '',
    ].join('\n');

    const encoded=normalizeCallouts(source);
    expect(encoded).toContain('[Task Note](Task%20Note.md)');
    expect(encoded).toContain('[Bayes 🧪](Lecture%202.md#bayes-law)');
    expect(encoded).toContain('[study.smd](study.smd)');
    expect(encoded).toContain('[Legacy Deck](legacy.fmd)');
    expect(encoded).toContain('[top](#course-hub)');
    expect(encoded).toContain('![Proof Diagram](DM%20Images/proof%20diagram.svg)');
    expect(encoded).toContain('`[[Task Note]]`');
    expect(encoded).toContain('$P([[A]]) = 1$');

    const analysis=analyzeDocument(source);
    expect(analysis.tasks).toEqual([source.indexOf('[ ]')+1,source.indexOf('[x]')+1]);
    expect(analysis.outline.map(item=>[item.id,item.offset])).toEqual([
      ['course-hub',source.indexOf('# Course Hub 🚀')],
      ['follow-up-section',source.indexOf('## Follow-up Section')],
    ]);
    for(const block of analysis.blocks)expect(source.slice(block.start,block.end)).toBe(block.text);
  });
});
