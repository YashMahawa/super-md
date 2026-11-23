import {describe,it,expect} from 'vitest';
import {repairPastedMath} from './mathRepair';

describe('paste-only LaTeX repair',()=>{
  it('repairs validated delimiters and braces without cosmetic changes',()=>{
    expect(repairPastedMath(String.raw`\[\frac{a}{b}\]`)).toBe('$$\n\\frac{a}{b}\n$$');
    expect(repairPastedMath(String.raw`$\frac{a}{b$`)).toBe(String.raw`$\frac{a}{b}$`);
    expect(repairPastedMath(String.raw`$ \sqrt{x} $`)).toBe(String.raw`$ \sqrt{x} $`);
    expect(repairPastedMath('cost = unit + tax')).toBe('cost = unit + tax');
    expect(repairPastedMath('Costs $5 and $10.')).toBe('Costs $5 and $10.');
  });
  it('uses inline math for a formula pasted into surrounding prose',()=>{
    expect(repairPastedMath(String.raw`\frac{a}{b}`,'This equals ',' in the result.')).toBe(String.raw`$\frac{a}{b}$`);
    expect(repairPastedMath('E=mc^2')).toBe('$$\nE=mc^2\n$$');
  });
  it('protects surrounding Markdown, existing formulas and incomplete math',()=>{
    const formula=String.raw`\frac{a}{b}`;
    for(const [before,after]of [['```python\n','\n```'],['`','`'],['[a link](',' )'],['$x + ',' = y$'],['$$\nx +\n\n','\n y\n$$'],[String.raw`\(x + `,String.raw`\)`],['$x + ','']]){
      expect(repairPastedMath(formula,before,after),JSON.stringify({before,after})).toBe(formula);
    }
    const code='```python\n'+formula+'\n```';
    expect(repairPastedMath(code+'\n\nE=mc^2')).toBe(code+'\n\n$$\nE=mc^2\n$$');
  });
  it('leaves unsupported commands alone and bounds existing-note context',()=>{
    const unsupported=String.raw`$\unknownCommand{x}$`;
    expect(repairPastedMath(unsupported)).toBe(unsupported);
    const before='A prior paragraph.\n\n'.repeat(100_000);
    expect(repairPastedMath(String.raw`\frac{a}{b}`,before,'')).toBe('$$\n\\frac{a}{b}\n$$');
  });
});
