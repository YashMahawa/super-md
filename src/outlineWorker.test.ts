import {describe,it,expect,vi} from 'vitest';
import {OutlineWorkerClient} from './outlineWorker';
import type {OutlineEntry} from './documentAnalysis';

class FakeWorker {
  onmessage:((event:MessageEvent<{outline:OutlineEntry[]}>)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:((event:MessageEvent)=>void)|null=null;
  posted:unknown;
  terminated=false;
  postMessage(value:unknown){this.posted=value;}
  terminate(){this.terminated=true;}
  respond(outline:OutlineEntry[]){this.onmessage?.({data:{outline}} as MessageEvent<{outline:OutlineEntry[]}>);}
  fail(){this.onerror?.({message:'worker failed'} as ErrorEvent);}
}

const result:OutlineEntry[]=[{id:'chapter',title:'Chapter',level:1,offset:0}];

describe('OutlineWorkerClient',()=>{
  it('runs one active source once and sends only that source to its worker',async()=>{
    const worker=new FakeWorker(),factory=vi.fn(()=>worker as unknown as Worker),client=new OutlineWorkerClient(factory);
    const signal=new AbortController().signal;
    const first=client.request('# Chapter',signal),duplicate=client.request('# Chapter',signal);
    expect(duplicate).toBe(first);expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posted).toEqual({source:'# Chapter'});
    worker.respond(result);await expect(first).resolves.toEqual(result);
    expect(worker.terminated).toBe(true);
    client.dispose();
  });

  it('terminates superseded work, ignores stale replies, and resolves only the current generation',async()=>{
    const workers:FakeWorker[]=[],client=new OutlineWorkerClient(()=>{const worker=new FakeWorker();workers.push(worker);return worker as unknown as Worker;});
    const old=client.request('old source');
    const oldRejected=expect(old).rejects.toMatchObject({name:'AbortError'});
    const current=client.request('new source');
    expect(workers[0].terminated).toBe(true);
    workers[0].respond([{id:'stale',title:'Stale',level:1,offset:0}]);
    workers[1].respond(result);
    await oldRejected;await expect(current).resolves.toEqual(result);
    expect(workers[1].terminated).toBe(true);
    client.dispose();
  });

  it('aborts via the caller signal and rejects worker errors so callers can sync-fallback',async()=>{
    const worker=new FakeWorker(),client=new OutlineWorkerClient(()=>worker as unknown as Worker),controller=new AbortController();
    const aborted=client.request('cancel me',controller.signal);
    const rejection=expect(aborted).rejects.toMatchObject({name:'AbortError'});
    controller.abort();await rejection;expect(worker.terminated).toBe(true);

    const retry=client.request('retry after failure');
    worker.fail();await expect(retry).rejects.toThrow('Outline worker failed');
    expect(worker.terminated).toBe(true);
    client.dispose();
  });

  it('disposes active work and refuses further requests',async()=>{
    const worker=new FakeWorker(),client=new OutlineWorkerClient(()=>worker as unknown as Worker);
    const active=client.request('active'),rejection=expect(active).rejects.toMatchObject({name:'AbortError'});
    client.dispose();await rejection;
    expect(worker.terminated).toBe(true);
    await expect(client.request('after dispose')).rejects.toThrow('disposed');
  });
});
