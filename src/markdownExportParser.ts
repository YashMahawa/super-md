import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { maskFrontmatter } from "./frontmatter";
import { remarkObsidianMath } from "./obsidianMath";

/**
 * Shared frozen parse-only processor for Markdown and document-media exports
 * that use identical CommonMark + GFM (`singleTilde: false`) + math + Obsidian
 * display/table math parsing options while preserving exact UTF-16 offsets.
 */
export const markdownExportParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkObsidianMath)
  .freeze();

export interface MaskedMarkdownAst {
  masked: string;
  tree: ReturnType<typeof markdownExportParser.parse>;
}

export function parseMaskedMarkdown(markdown: string): MaskedMarkdownAst {
  const masked = maskFrontmatter(markdown);
  return { masked, tree: markdownExportParser.parse(masked) };
}
