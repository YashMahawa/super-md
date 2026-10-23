// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import FolderPanel from './FolderPanel';
import {invoke} from '../nativeBridge';
vi.mock('../nativeBridge',()=>({invoke:vi.fn()}));
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
it('routes directory requests through the shared bridge and shows failures',async()=>{
  localStorage.clear();const host=document.createElement('div'),root=createRoot(host),open=vi.fn();
  vi.mocked(invoke).mockResolvedValueOnce([{name:'Notes.md',path:'/notes/Notes.md',directory:false}]);
  await act(async()=>root.render(<FolderPanel root="/notes" activePath={null} onChoose={vi.fn()} onHide={vi.fn()} onOpen={open}/>));
  expect(invoke).toHaveBeenCalledWith('read_directory_children',{root:'/notes',path:'/notes'});
  const file=Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='Notes.md')!;
  act(()=>file.click());expect(open).toHaveBeenCalledWith('/notes/Notes.md');
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Folder unavailable'));
  await act(async()=>root.render(<FolderPanel root="/other" activePath={null} onChoose={vi.fn()} onHide={vi.fn()} onOpen={open}/>));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Folder unavailable');
  act(()=>root.unmount());
});
