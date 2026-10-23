// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import SvgDiagram from './SvgDiagram';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
it('ends the size placeholder on load, reports decode failure, and recovers for a different drawing',()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const first='<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><path d="M0 0L120 60"/></svg>';
  try{
    act(()=>root.render(<SvgDiagram source={first} preserveOriginal/>));
    expect(host.querySelector('[role=status]')).not.toBeNull();
    act(()=>host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('[role=status]')).toBeNull();
    expect(host.querySelector('[role=alert]')?.textContent).toContain('could not be decoded');
    act(()=>root.render(<SvgDiagram source={first.replace('L120 60','L100 50')} preserveOriginal/>));
    expect(host.querySelector('[role=alert]')).toBeNull();
    act(()=>host.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(host.querySelector('[role=status]')).toBeNull();
    expect(host.querySelector('img')?.style.visibility).not.toBe('hidden');
  }finally{act(()=>root.unmount());host.remove();}
});
