import { describe, expect, it } from "vitest";
import LiveEditor,{ splitMarkdownBlocks } from "./LiveEditor";
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import MarkdownPreview from './MarkdownPreview';

describe("live Markdown blocks", () => {
  it("keeps fenced code and callouts intact across blank lines", () => {
    const note = "# Heading\n\n```python\na = 1\n\nprint(a)\n```\n\n:::callout tip\nOne\n\nTwo\n:::\n\nEnd";
    const blocks = splitMarkdownBlocks(note);
    expect(blocks).toHaveLength(4);
    expect(blocks[1].text).toContain("\n\nprint(a)");
    expect(blocks[2].text).toContain("One\n\nTwo");
    expect(blocks.map((block) => block.text).join("")).toBe(note);
  });
  it('keeps loose and nested list items in one semantic editable block',()=>{
    const note='1. One\n\n2. Two\n\n   - Nested\n\n3. Three\n\nAfter';
    const blocks=splitMarkdownBlocks(note);
    expect(blocks).toHaveLength(2);expect(blocks[0].text).toContain('3. Three');
    expect(blocks.map(block=>block.text).join('')).toBe(note);
  });
  it('renders references, footnotes and duplicate heading IDs with document-wide context',()=>{
    const markdown='# Topic\n\nRead [the documentation][ref]. A result[^1].\n\n# Topic\n\nAnother result[^2].\n\n[ref]: https://example.com\n\n[^1]: First source.\n\n[^2]: Second source.';
    const props={markdown,documentPath:null,python:'',dark:false};
    const read=renderToStaticMarkup(createElement(MarkdownPreview,props));
    const live=renderToStaticMarkup(createElement(LiveEditor,{...props,onChange:()=>{}}));
    expect(live).toContain('href="https://example.com"');
    expect(live.match(/data-footnote-ref=/g)).toHaveLength(2);
    expect(live.match(/data-footnotes=/g)).toHaveLength(1);
    expect(live).toContain('id="topic"');expect(live).toContain('id="topic-1"');
    expect((live.match(/href=/g)||[]).length).toBe((read.match(/href=/g)||[]).length);
    expect(live).toContain('First source.');expect(live).toContain('Second source.');
  });
});
