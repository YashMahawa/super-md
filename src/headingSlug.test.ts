import {describe,expect,it} from 'vitest';
import conformance from '../test-fixtures/heading-slug-conformance.json';
import {agentHeadingSlug,agentOutline,resolveAgentHeading} from './agentOperations';
import {documentOutline,resolveHeadingOffset} from './documentNavigation';
import {headingSlug} from './headingSlug';

describe('heading slug cross-runtime conformance',()=>{
  it('matches shared conformance vectors for NFKC document slugs and NFKD agent slugs',()=>{
    expect(conformance.version).toBe(1);
    expect(conformance.cases.length).toBeGreaterThanOrEqual(24);
    expect(conformance.cases.length).toBeLessThanOrEqual(30);
    expect(conformance.cases.some(entry=>entry.documentSlug!==entry.agentSlug)).toBe(true);
    for(const entry of conformance.cases){
      expect(headingSlug(entry.input),`documentSlug (${entry.id})`).toBe(entry.documentSlug);
      expect(agentHeadingSlug(entry.input),`agentSlug (${entry.id})`).toBe(entry.agentSlug);
    }
  });

  it('resolves accented, compatibility-symbol, and <kbd> headings across outline and agent lookup',()=>{
    const md=[
      '# Cafe\u0301',
      '',
      '## ℍ₂O & ℝ² Space',
      '',
      '## Trade™ 100㎐',
      '',
      '## Press <kbd>Ctrl</kbd> + C',
      '',
    ].join('\n');
    const outline=documentOutline(md);
    expect(outline.map(item=>item.id)).toEqual(['café','h2o--r2-space','tradetm-100hz','press-ctrl--c']);
    expect(resolveHeadingOffset(md,'#cafe%CC%81')).toBe(outline[0].offset);
    expect(resolveHeadingOffset(md,'#h2o--r2-space')).toBe(outline[1].offset);
    expect(resolveHeadingOffset(md,'#Press%20%3Ckbd%3ECtrl%3C/kbd%3E%20+%20C')).toBe(outline[3].offset);

    const headings=agentOutline(md);
    expect(resolveAgentHeading(headings,'cafe').index).toBe(0);
    expect(resolveAgentHeading(headings,'h2o-r2-space').index).toBe(1);
    expect(resolveAgentHeading(headings,'tradetm-100hz').index).toBe(2);
    expect(resolveAgentHeading(headings,'press-kbd-ctrl-kbd-c').index).toBe(3);
  });
});
