import { expect, it } from "vitest";
import { applyMathRepairs, suggestMathRepairs } from "./mathRepair";
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
