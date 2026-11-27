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

it('lists .qmd and .Rmd notes in visible folders with exact case, filters file names case-insensitively, and opens them',async()=>{
  localStorage.clear();const host=document.createElement('div'),root=createRoot(host),open=vi.fn();
  vi.mocked(invoke).mockImplementation(async(_cmd,args)=>{
    if((args as {path?:string})?.path==='/lab/biostats'){
      return [
        {name:'Overview.md',path:'/lab/biostats/Overview.md',directory:false},
        {name:'SurvivalModel.RMD',path:'/lab/biostats/SurvivalModel.RMD',directory:false},
      ];
    }
    return [
      {name:'biostats',path:'/lab/biostats',directory:true},
      {name:'ClinicalTrial.Rmd',path:'/lab/ClinicalTrial.Rmd',directory:false},
      {name:'quarto-report.qmd',path:'/lab/quarto-report.qmd',directory:false},
      {name:'UPPER_MODEL.QMD',path:'/lab/UPPER_MODEL.QMD',directory:false},
    ];
  });
  await act(async()=>root.render(<FolderPanel root="/lab" activePath="/lab/ClinicalTrial.Rmd" onChoose={vi.fn()} onHide={vi.fn()} onOpen={open}/>));
  const labels=()=>Array.from(host.querySelectorAll('.folder-tree button.folder-entry span')).map(x=>x.textContent);
  expect(labels()).toEqual(['biostats','ClinicalTrial.Rmd','quarto-report.qmd','UPPER_MODEL.QMD']);

  const biostatsButton=Array.from(host.querySelectorAll<HTMLButtonElement>('.folder-tree button.folder-entry')).find(x=>x.textContent==='biostats')!;
  await act(async()=>biostatsButton.click());
  expect(labels()).toEqual(['biostats','Overview.md','SurvivalModel.RMD','ClinicalTrial.Rmd','quarto-report.qmd','UPPER_MODEL.QMD']);

  const filterInput=host.querySelector('input[aria-label="Filter file names"]') as HTMLInputElement;
  const setInputValue=(value:string)=>{
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    setter?.call(filterInput,value);
    filterInput.dispatchEvent(new Event('input',{bubbles:true}));
    filterInput.dispatchEvent(new Event('change',{bubbles:true}));
  };

  await act(async()=>setInputValue('.rmd'));
  expect(labels()).toEqual(['biostats','SurvivalModel.RMD','ClinicalTrial.Rmd']);

  await act(async()=>setInputValue('.QMD'));
  expect(labels()).toEqual(['biostats','quarto-report.qmd','UPPER_MODEL.QMD']);

  const qmdButton=Array.from(host.querySelectorAll<HTMLButtonElement>('.folder-tree button.folder-entry')).find(x=>x.textContent==='quarto-report.qmd')!;
  act(()=>qmdButton.click());
  expect(open).toHaveBeenCalledWith('/lab/quarto-report.qmd');
  act(()=>root.unmount());
});
