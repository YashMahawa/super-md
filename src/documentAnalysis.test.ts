import {describe,it,expect} from 'vitest';
import {analyzeDocument} from './documentAnalysis';
import {normalizeMarkdownSource} from './markdownSource';

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
});
