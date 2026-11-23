// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import MarkdownPreview from './MarkdownPreview';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

it('classifies standalone SVGs without classifying inline icons or remounting unchanged image paragraphs on an edit',()=>{
  const uri='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40"/></svg>');
  const source=`- [ ] A task\n\n![Diagram](${uri})\n\nAn inline icon ![Icon](${uri}) stays inline.\n`;
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{
    act(()=>root.render(<MarkdownPreview markdown={source} documentPath={null} python="" dark={false}/>));
    const paragraph=host.querySelector('.media-paragraph')!,image=paragraph.querySelector('img')!;
    expect(paragraph.querySelector('.note-image--diagram')).not.toBeNull();
    expect(host.querySelectorAll('.media-paragraph')).toHaveLength(1);
    act(()=>image.dispatchEvent(new Event('load')));
    act(()=>root.render(<MarkdownPreview markdown={source.replace('[ ]','[x]')} documentPath={null} python="" dark={false}/>));
    expect(host.querySelector('.media-paragraph')).toBe(paragraph);
    expect(paragraph.querySelector('img')).toBe(image);
    expect(paragraph.querySelector('[role=status]')).toBeNull();
  }finally{act(()=>root.unmount());host.remove();}
});
