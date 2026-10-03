import {expect,test} from 'vitest';
import {documentOutline} from './documentNavigation';
test('outline excludes frontmatter and code and retains duplicate headings and raw offsets',()=>{
  const md='---\ntitle: metadata\n---\n# Notes\n\n```md\n# Not a heading\n```\n\n## Energy $E=mc^2$\n\n## Notes\n\n## Notes\n';
  const outline=documentOutline(md);
  expect(outline.map(entry=>entry.id)).toEqual(['notes','energy-emc2','notes-1','notes-2']);
  expect(outline.map(entry=>md.slice(entry.offset).split('\n')[0])).toEqual(['# Notes','## Energy $E=mc^2$','## Notes','## Notes']);
});
