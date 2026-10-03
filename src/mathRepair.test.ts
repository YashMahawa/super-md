import { expect, it } from "vitest";
import { applyMathRepairs, suggestMathRepairs } from "./mathRepair";
import katex from "katex";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { remarkObsidianMath } from "./obsidianMath";
import { visit } from "unist-util-visit";
it("repairs explicit alternate delimiters and standalone equations",()=>{
  const source = String.raw`Inline \(x^2\).` + "\n\n" + String.raw`\frac{1}{2} + \alpha = 4`;
  const changes = suggestMathRepairs(source);
  expect(changes).toHaveLength(2);
  expect(applyMathRepairs(source,changes)).toContain("$x^2$");
  expect(applyMathRepairs(source,changes)).toContain("$$\n\\frac{1}{2} + \\alpha = 4\n$$");
});
it("does not modify code, currency, existing equations, URLs or ambiguous prose",()=>{
  const source = "```tex\n\\frac{1}{2}\n```\n\n`\\(literal\\)` costs $20.\n\n$\\alpha=4$\n\nExplain the \\alpha coefficient in words.";
  expect(suggestMathRepairs(source)).toHaveLength(0);
});
it("will not apply a repair to changed text",()=>{
  const source = String.raw`\(x\)`;
  expect(applyMathRepairs("other",suggestMathRepairs(source))).toBe("other");
});
it.each([
  [String.raw`$ x^2 $`,"$x^2$"],
  [String.raw`$ x + y $`,"$x + y$"],
  [String.raw`\frac{a}{b}$`,"$$\n\\frac{a}{b}\n$$"],
  [String.raw`Given \frac{a}{b}$, continue.`,String.raw`Given $\frac{a}{b}$, continue.`],
  [String.raw`$ \frac{a}{b} $`,String.raw`$\frac{a}{b}$`],
  [String.raw`$$\frac{a}{b}$`,"$$\n\\frac{a}{b}\n$$"],
  [String.raw`\(x^2\]`,"$x^2$"],
  [String.raw`\$\frac{a}{b}\$`,String.raw`$\frac{a}{b}$`],
  [String.raw`E=mc^2`,"$$\nE=mc^2\n$$"],
  ["$$\n\\frac{a}{b}","$$\n\\frac{a}{b}\n$$"],
  [String.raw`$\sqrt{x$`,String.raw`$\sqrt{x}$`],
  [String.raw`Given \frac{a}{b} = c, continue.`,String.raw`Given $\frac{a}{b} = c$, continue.`],
  [String.raw`> \frac{a}{b}`,String.raw`> $\frac{a}{b}$`],
  [String.raw`\begin{align}a&=b\\c&=d\end{align}`,"$$\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n$$"],
])("validates and renders a copied formula case %s",(source,expected)=>{
  const fixed=applyMathRepairs(source,suggestMathRepairs(source));expect(fixed).toBe(expected);
  const tree=unified().use(remarkParse).use(remarkMath).use(remarkObsidianMath).parse(fixed);let count=0;
  visit(tree,(node:any)=>{if(node.type==="math"||node.type==="inlineMath"){count++;expect(()=>katex.renderToString(node.value,{throwOnError:true})).not.toThrow();}});
  expect(count).toBe(1);expect(suggestMathRepairs(fixed)).toHaveLength(0);
});
it("does not invent arguments, absorb prose, or modify mathematical code and links",()=>{
  const source=String.raw`Costs $20 and $30. Literal \$50.

Explain the \alpha coefficient in words.

\frac

\unsupported{x}

[\frac{1}{2}](https://example.com)

~~~tex
$ \sqrt{x} $
~~~

$\alpha=4$

$$
\frac{1}{2}
$$`;
  expect(suggestMathRepairs(source)).toHaveLength(0);
});
