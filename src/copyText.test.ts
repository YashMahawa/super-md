// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('./nativeBridge',()=>({invoke}));
import {copyText} from './copyText';

const original=Object.getOwnPropertyDescriptor(navigator,'clipboard');
beforeEach(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,get:()=>undefined}));
afterEach(()=>{vi.restoreAllMocks();invoke.mockReset();delete window.SuperMD;if(original)Object.defineProperty(navigator,'clipboard',original);else Reflect.deleteProperty(navigator,'clipboard');});
it('copies through the browser without touching the native bridge',async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator,'clipboard','get').mockReturnValue({writeText} as unknown as Clipboard);
  await copyText('A full guide\nwith code');
  expect(writeText).toHaveBeenCalledWith('A full guide\nwith code');expect(invoke).not.toHaveBeenCalled();
});
it('uses the host clipboard without waiting for a hidden browser permission prompt',async()=>{
  const writeText=vi.fn(()=>new Promise<void>(()=>{}));
  Object.defineProperty(navigator,'clipboard',{configurable:true,get:()=>({writeText})});
  window.SuperMD={post:vi.fn()};invoke.mockResolvedValue(true);
  await copyText('Full guide');expect(invoke).toHaveBeenCalledWith('copy_text',{text:'Full guide'});expect(writeText).not.toHaveBeenCalled();
});
it('reports denied clipboard access instead of claiming a successful copy',async()=>{
  Object.defineProperty(navigator,'clipboard',{configurable:true,get:()=>({writeText:async()=>{throw new Error('denied');}})});
  await expect(copyText('guide')).rejects.toThrow('denied');expect(invoke).not.toHaveBeenCalled();
  window.SuperMD={post:vi.fn()};invoke.mockRejectedValue(new Error('native unavailable'));
  await expect(copyText('guide')).rejects.toThrow('native unavailable');
});
