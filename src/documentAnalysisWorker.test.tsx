// @vitest-environment jsdom
import {StrictMode,act,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as documentAnalysis from './documentAnalysis';
import {
  DocumentAnalysisWorkerClient,
  WORKER_ANALYSIS_MIN_CHARS,
  useDocumentAnalysis,
  type AnalysisWorkerLike,
} from './documentAnalysisWorker';
import type {DocumentAnalysisWorkerRequest,DocumentAnalysisWorkerResponse} from './documentAnalysis.worker';
import MarkdownPreview from './components/MarkdownPreview';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

class ControlledWorker implements AnalysisWorkerLike {
  onmessage:((event:MessageEvent<DocumentAnalysisWorkerResponse>)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:((event:MessageEvent)=>void)|null=null;
  posted:DocumentAnalysisWorkerRequest[]=[];
  terminated=false;

  constructor(private readonly realAnalyze:(source:string)=>documentAnalysis.DocumentAnalysis){}

  postMessage(value:DocumentAnalysisWorkerRequest):void {
    this.posted.push(value);
  }

  terminate():void {
    this.terminated=true;
  }

  flushNext():void {
    const job=this.posted.at(-1);
    if(!job)throw new Error('No posted job to flush');
    const compact=documentAnalysis.toCompactAnalysis(this.realAnalyze(job.source));
    this.onmessage?.({data:{id:job.id,analysis:compact}} as MessageEvent<DocumentAnalysisWorkerResponse>);
  }

  emitRaw(payload:DocumentAnalysisWorkerResponse):void {
    this.onmessage?.({data:payload} as MessageEvent<DocumentAnalysisWorkerResponse>);
  }

  fail(message='worker runtime error'):void {
    this.onerror?.({message} as ErrorEvent);
  }
}

function buildDocumentOfSize(targetBytes:number):string {
  const paragraph='Readable study paragraph with **emphasis**, `inline_code`, and reference context for Split mode editing. '.repeat(14);
  const section=`## Section Heading\n\n${paragraph}\n\n- [ ] Check item\n\n`;
  const repeats=Math.ceil(targetBytes/section.length)+1;
  return `# Large Benchmark Note\n\n${section.repeat(repeats)}`.slice(0,targetBytes);
}

let root:Root|null=null;
afterEach(()=>{
  if(root){
    act(()=>root?.unmount());
    root=null;
  }
  document.body.innerHTML='';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DocumentAnalysisWorkerClient & useDocumentAnalysis',()=>{
  it('executes documentAnalysis.worker message loop, ignores malformed requests, and reports parse errors',async()=>{
    const posted:DocumentAnalysisWorkerResponse[]=[];
    const fakeSelf={
      onmessage:null as ((event:MessageEvent<DocumentAnalysisWorkerRequest>)=>void)|null,
      postMessage:(value:DocumentAnalysisWorkerResponse)=>{posted.push(value);},
    };
    vi.stubGlobal('self',fakeSelf);
    await import('./documentAnalysis.worker');
    expect(typeof fakeSelf.onmessage).toBe('function');

    // Malformed payloads are ignored safely.
    fakeSelf.onmessage!({data:{id:'bad' as unknown as number,source:'# Ignored'}} as MessageEvent<DocumentAnalysisWorkerRequest>);
    fakeSelf.onmessage!({data:{id:1,source:null as unknown as string}} as MessageEvent<DocumentAnalysisWorkerRequest>);
    expect(posted).toHaveLength(0);

    // Valid source posts compact analysis without block text copies.
    fakeSelf.onmessage!({data:{id:7,source:'# Worker Heading\n\n- [ ] Item\n'}} as MessageEvent<DocumentAnalysisWorkerRequest>);
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(7);
    expect(posted[0].analysis?.outline[0]?.title).toBe('Worker Heading');

    // Runtime exception inside analyzeDocument reports structured error string.
    const spy=vi.spyOn(documentAnalysis,'analyzeDocument').mockImplementationOnce(()=>{
      throw new Error('synthetic-parse-failure');
    });
    fakeSelf.onmessage!({data:{id:8,source:'# Boom'}} as MessageEvent<DocumentAnalysisWorkerRequest>);
    expect(posted[1]).toEqual({id:8,error:'synthetic-parse-failure'});
    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('reuses a single warm worker across consecutive edits, coalesces superseded revisions, and terminates after idle timeout',async()=>{
    vi.useFakeTimers();
    const realAnalyze=documentAnalysis.analyzeDocument;
    const workers:ControlledWorker[]=[];
    const factory=vi.fn(()=>{
      const worker=new ControlledWorker(realAnalyze);
      workers.push(worker);
      return worker;
    });
    const client=new DocumentAnalysisWorkerClient(factory,{idleMs:5_000});

    // Lazy initialization: zero workers until first request (or prewarm).
    expect(factory).toHaveBeenCalledTimes(0);

    const rev1=client.request('# Rev 1\n\nFirst body.');
    // Rapid consecutive edits while rev1 is in flight: rev2 & rev3 are superseded
    // in the pending slot without posting to the worker or restarting it.
    const rev2=client.request('# Rev 2\n\nIntermediate edit 1.');
    const rev2Rejected=expect(rev2).rejects.toMatchObject({name:'AbortError'});
    const rev3=client.request('# Rev 3\n\nIntermediate edit 2.');
    const rev3Rejected=expect(rev3).rejects.toMatchObject({name:'AbortError'});
    const rev4=client.request('# Rev 4\n\nFinal coalesced edit.');

    await rev2Rejected;
    await rev3Rejected;

    // Still only 1 warm worker, and only rev1 has crossed postMessage so far!
    expect(factory).toHaveBeenCalledTimes(1);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].posted.map(item=>item.source)).toEqual(['# Rev 1\n\nFirst body.']);

    // Completing rev1 resolves rev1 AND immediately dispatches rev4 on the SAME warm worker.
    workers[0].flushNext();
    const res1=await rev1;
    expect(res1.analysis.outline[0]?.title).toBe('Rev 1');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].posted.map(item=>item.source)).toEqual([
      '# Rev 1\n\nFirst body.',
      '# Rev 4\n\nFinal coalesced edit.',
    ]);

    workers[0].flushNext();
    const res4=await rev4;
    expect(res4.analysis.outline[0]?.title).toBe('Rev 4');
    expect(client.peek('# Rev 4\n\nFinal coalesced edit.')).toBe(res4);

    // Consecutive edit after completion still reuses the same warm worker.
    const rev5=client.request('# Rev 5\n\nWarm follow-up.');
    expect(factory).toHaveBeenCalledTimes(1);
    workers[0].flushNext();
    await expect(rev5).resolves.toMatchObject({source:'# Rev 5\n\nWarm follow-up.'});
    expect(workers[0].terminated).toBe(false);

    // Advance past idle timeout: worker terminates and retained analysis is released.
    vi.advanceTimersByTime(4_999);
    expect(workers[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0].terminated).toBe(true);
    expect(client.peek('# Rev 5\n\nWarm follow-up.')).toBeNull();
    expect(client.peek('# Rev 1\n\nFirst body.')).toBeNull();

    // prewarm() spawns lazily and schedules idle reclamation.
    client.prewarm();
    expect(factory).toHaveBeenCalledTimes(2);
    const afterIdle=client.request('# After Idle');
    expect(factory).toHaveBeenCalledTimes(2);
    workers[1].flushNext();
    await expect(afterIdle).resolves.toMatchObject({source:'# After Idle'});

    client.dispose();
    expect(workers[1].terminated).toBe(true);
  });

  it('retains a bounded LRU cache across multi-tab switches and undo/redo without re-posting to the worker',async()=>{
    const realAnalyze=documentAnalysis.analyzeDocument;
    const worker=new ControlledWorker(realAnalyze);
    const client=new DocumentAnalysisWorkerClient(()=>worker,{idleMs:30_000});

    const pA=client.request('# Tab A\n\n- [ ] Task');
    worker.flushNext();
    const resA=await pA;

    const pAEdited=client.request('# Tab A\n\n- [x] Task');
    worker.flushNext();
    const resAEdited=await pAEdited;

    const pB=client.request('# Tab B\n\nSecond tab.');
    worker.flushNext();
    const resB=await pB;

    expect(worker.posted).toHaveLength(3);

    // Switching back to Tab A (edited), undoing back to Tab A (unchecked), and redoing
    // all resolve synchronously from peek() and request() without posting new worker jobs.
    expect(client.peek('# Tab A\n\n- [x] Task')).toBe(resAEdited);
    expect(client.peek('# Tab A\n\n- [ ] Task')).toBe(resA);
    expect(client.peek('# Tab B\n\nSecond tab.')).toBe(resB);
    await expect(client.request('# Tab A\n\n- [ ] Task')).resolves.toBe(resA);
    await expect(client.request('# Tab A\n\n- [x] Task')).resolves.toBe(resAEdited);
    expect(worker.posted).toHaveLength(3);

    // Exceeding 6 cached entries evicts the least-recently-used revision while keeping recent ones.
    for(let i=1;i<=5;i++){
      const req=client.request(`# Extra ${i}`);
      worker.flushNext();
      await req;
    }
    expect(client.peek('# Tab B\n\nSecond tab.')).toBeNull();
    expect(client.peek('# Extra 5')).not.toBeNull();

    client.reclaimIdle();
    expect(client.peek('# Extra 5')).toBeNull();
    client.dispose();
  });

  it('transfers compact block ranges without block text strings and rejects malformed worker payloads or cancellations cleanly',async()=>{
    const realAnalyze=documentAnalysis.analyzeDocument;
    const captured:{payload:DocumentAnalysisWorkerResponse|null}={payload:null};
    const worker:AnalysisWorkerLike={
      onmessage:null,
      onerror:null,
      onmessageerror:null,
      postMessage(request:DocumentAnalysisWorkerRequest){
        const compact=documentAnalysis.toCompactAnalysis(realAnalyze(request.source));
        const payload:DocumentAnalysisWorkerResponse={id:request.id,analysis:compact};
        captured.payload=payload;
        this.onmessage?.({data:payload} as MessageEvent<DocumentAnalysisWorkerResponse>);
      },
      terminate(){},
    };
    const client=new DocumentAnalysisWorkerClient(()=>worker,{idleMs:10_000});
    const source='# Alpha\n\nParagraph one.\n\n## Beta\n\nParagraph two.\n';
    const hydrated=await client.request(source);

    expect(captured.payload?.analysis?.blockRanges).toEqual([
      {start:0,end:source.indexOf('Paragraph one.')},
      {start:source.indexOf('Paragraph one.'),end:source.indexOf('## Beta')},
      {start:source.indexOf('## Beta'),end:source.indexOf('Paragraph two.')},
      {start:source.indexOf('Paragraph two.'),end:source.length},
    ]);
    for(const range of captured.payload!.analysis!.blockRanges){
      expect(Object.prototype.hasOwnProperty.call(range,'text')).toBe(false);
    }
    expect(hydrated.analysis.blocks.map(block=>block.text).join('')).toBe(source);

    // Malformed worker payload, worker error payload, messageerror, and cancel() handling.
    const controlled=new ControlledWorker(realAnalyze);
    const guardClient=new DocumentAnalysisWorkerClient(()=>controlled,{idleMs:10_000});
    const invalidPromise=guardClient.request('# Invalid Payload');
    controlled.emitRaw({id:controlled.posted[0].id,analysis:{tree:null} as unknown as documentAnalysis.CompactDocumentAnalysis});
    await expect(invalidPromise).rejects.toThrow('invalid data');

    const errPromise=guardClient.request('# Worker Error');
    controlled.emitRaw({id:controlled.posted[1].id,error:'boom'});
    await expect(errPromise).rejects.toThrow('boom');

    const cancelActive=guardClient.request('# Active Cancel');
    const cancelQueued=guardClient.request('# Queued Cancel');
    const activeRej=expect(cancelActive).rejects.toMatchObject({name:'AbortError'});
    const queuedRej=expect(cancelQueued).rejects.toMatchObject({name:'AbortError'});
    guardClient.cancel();
    await activeRej;
    await queuedRej;

    client.dispose();
    guardClient.dispose();
  });

  it('triggers zero UI-thread analyzeDocument calls when typing in Split mode on >80 KB and 1 MB documents while pinning preview revisions',async()=>{
    class NoopIntersectionObserver { observe(){} unobserve(){} disconnect(){} }
    class NoopResizeObserver { observe(){} disconnect(){} }
    vi.stubGlobal('IntersectionObserver',NoopIntersectionObserver);
    vi.stubGlobal('ResizeObserver',NoopResizeObserver);

    const realAnalyze=documentAnalysis.analyzeDocument;
    const uiAnalyzeSpy=vi.spyOn(documentAnalysis,'analyzeDocument');

    for(const [label,sizeBytes,mountFullPreview] of [['85 KB',85*1024,true],['1 MB',1024*1024,false]] as const){
      uiAnalyzeSpy.mockClear();
      let workerInstance:ControlledWorker|null=null;
      const client=new DocumentAnalysisWorkerClient(()=>{
        workerInstance=new ControlledWorker(realAnalyze);
        return workerInstance;
      },{idleMs:30_000});

      const initialDoc=buildDocumentOfSize(sizeBytes);
      let setSourceExternal!:(next:string)=>void;
      let latestRenderedEditorValue='';
      let latestPinnedSource:string|null=null;

      function SplitHarness(){
        const [source,setSource]=useState(initialDoc);
        setSourceExternal=setSource;
        latestRenderedEditorValue=source;
        const {pinnedAnalysis}=useDocumentAnalysis(`doc-${label}`,source,'split',{client});
        latestPinnedSource=pinnedAnalysis?.source??null;
        return (
          <div>
            {mountFullPreview?(
              <textarea aria-label="source-input" value={source} onChange={e=>setSource(e.target.value)}/>
            ):(
              <output aria-label="source-input" data-length={source.length}>{source.slice(-32)}</output>
            )}
            {pinnedAnalysis&&(mountFullPreview?(
              <MarkdownPreview
                markdown={pinnedAnalysis.source}
                sourceAnalysis={pinnedAnalysis}
                documentPath={null}
                python=""
                dark={false}
              />
            ):(
              <div data-pinned-blocks={pinnedAnalysis.analysis.blocks.length}/>
            ))}
          </div>
        );
      }

      const host=document.createElement('div');
      document.body.append(host);
      root=createRoot(host);

      await act(async()=>{
        root?.render(<SplitHarness/>);
      });

      // Zero UI-thread analyzeDocument calls on initial mount!
      expect(uiAnalyzeSpy).toHaveBeenCalledTimes(0);

      // Worker completes initial analysis off-thread (realAnalyze runs inside ControlledWorker,
      // so reset spy around worker execution to measure strictly UI-thread calls).
      uiAnalyzeSpy.mockRestore();
      await act(async()=>{
        workerInstance!.flushNext();
      });
      expect(latestPinnedSource).toBe(initialDoc);
      const typingSpy=vi.spyOn(documentAnalysis,'analyzeDocument');

      // Type 5 consecutive keystrokes in Split mode while worker is busy on edit 1.
      for(let step=1;step<=5;step++){
        await act(async()=>{
          setSourceExternal(`${initialDoc}\nTyped revision ${step}`);
        });
      }

      // Editor state updated immediately with every keystroke, preview stays pinned, with ZERO UI-thread parses!
      expect(latestRenderedEditorValue).toContain('Typed revision 5');
      expect(latestPinnedSource).toBe(initialDoc);
      expect(typingSpy).toHaveBeenCalledTimes(0);

      // Flush edit 1 and coalesced edit 5 in worker; verify UI thread STILL never parses.
      typingSpy.mockRestore();
      await act(async()=>{
        workerInstance!.flushNext();
        workerInstance!.flushNext();
      });
      expect(latestPinnedSource).toContain('Typed revision 5');
      const settleSpy=vi.spyOn(documentAnalysis,'analyzeDocument');
      expect(settleSpy).toHaveBeenCalledTimes(0);

      act(()=>root?.unmount());
      root=null;
      host.remove();
      client.dispose();
    }
  },60_000);

  it('falls back cleanly to synchronous analyzeDocument when Worker is unavailable or fails',async()=>{
    const savedWorker=globalThis.Worker;
    // @ts-expect-error Simulate environment without Web Workers
    delete globalThis.Worker;
    try{
      const unavailableClient=new DocumentAnalysisWorkerClient();
      expect(unavailableClient.isAvailable()).toBe(false);

      const host=document.createElement('div');
      document.body.append(host);
      root=createRoot(host);

      function FallbackHarness({client}:{client:DocumentAnalysisWorkerClient}){
        const {pinnedAnalysis,outline,isReady}=useDocumentAnalysis('fallback-doc','# Sync Heading\n\nBody text.','reader',{
          client,
          minWorkerChars:0,
        });
        return <div data-ready={String(isReady)} data-heading={outline[0]?.title??''}>{pinnedAnalysis?.source??''}</div>;
      }

      await act(async()=>{
        root?.render(<FallbackHarness client={unavailableClient}/>);
      });
      const view=host.querySelector('[data-ready]')!;
      expect(view.getAttribute('data-ready')).toBe('true');
      expect(view.getAttribute('data-heading')).toBe('Sync Heading');

      // Also verify runtime worker failure falls back cleanly to sync analysis.
      const failingWorker=new ControlledWorker(documentAnalysis.analyzeDocument);
      const failingClient=new DocumentAnalysisWorkerClient(()=>failingWorker);
      await act(async()=>{
        root?.render(<FallbackHarness client={failingClient}/>);
      });
      await act(async()=>{
        failingWorker.fail('WebView worker blocked');
      });
      expect(host.querySelector('[data-ready]')?.getAttribute('data-ready')).toBe('true');
      expect(host.querySelector('[data-ready]')?.getAttribute('data-heading')).toBe('Sync Heading');
      failingClient.dispose();

      // Also verify React 19 <StrictMode> effect cleanup + remount attaches to the warm worker job cleanly.
      const strictWorker=new ControlledWorker(documentAnalysis.analyzeDocument);
      const strictClient=new DocumentAnalysisWorkerClient(()=>strictWorker);
      await act(async()=>{
        root?.render(
          <StrictMode>
            <FallbackHarness client={strictClient}/>
          </StrictMode>,
        );
      });
      expect(strictWorker.posted).toHaveLength(1);
      await act(async()=>{
        strictWorker.flushNext();
      });
      expect(host.querySelector('[data-ready]')?.getAttribute('data-ready')).toBe('true');
      expect(host.querySelector('[data-ready]')?.getAttribute('data-heading')).toBe('Sync Heading');
      strictClient.dispose();
    }finally{
      if(savedWorker!==undefined)globalThis.Worker=savedWorker;
    }
  });

  it('uses synchronous analyzeDocument fallback without spawning a worker for small documents (<= 80,000 chars) and offloads above 80,000 chars',async()=>{
    expect(WORKER_ANALYSIS_MIN_CHARS).toBe(80_000);
    const realAnalyze=documentAnalysis.analyzeDocument;
    let workerInstance:ControlledWorker|null=null;
    const factory=vi.fn(()=>{
      workerInstance=new ControlledWorker(realAnalyze);
      return workerInstance;
    });
    const client=new DocumentAnalysisWorkerClient(factory,{idleMs:30_000});

    const shortNote='# Quick Note\n\nShort body under the worker threshold.';
    const boundaryNote=buildDocumentOfSize(WORKER_ANALYSIS_MIN_CHARS);
    expect(boundaryNote).toHaveLength(WORKER_ANALYSIS_MIN_CHARS);
    const largeNote=`# Oversized Heading\n\n${buildDocumentOfSize(WORKER_ANALYSIS_MIN_CHARS+512)}`;
    expect(largeNote.length).toBeGreaterThan(WORKER_ANALYSIS_MIN_CHARS);

    let setSourceExternal!:(next:string)=>void;
    let stateSnapshot:{exactSource:string|null;pinnedSource:string|null;heading:string;isReady:boolean}={
      exactSource:null,
      pinnedSource:null,
      heading:'',
      isReady:false,
    };

    function ThresholdHarness(){
      const [source,setSource]=useState(shortNote);
      setSourceExternal=setSource;
      const {pinnedAnalysis,exactAnalysis,outline,isReady}=useDocumentAnalysis('threshold-doc',source,'reader',{client});
      stateSnapshot={
        exactSource:exactAnalysis?.source??null,
        pinnedSource:pinnedAnalysis?.source??null,
        heading:outline[0]?.title??'',
        isReady,
      };
      return <div data-ready={String(isReady)} data-heading={outline[0]?.title??''}/>;
    }

    const host=document.createElement('div');
    document.body.append(host);
    root=createRoot(host);

    await act(async()=>{
      root?.render(<ThresholdHarness/>);
    });
    expect(stateSnapshot).toEqual({
      exactSource:shortNote,
      pinnedSource:shortNote,
      heading:'Quick Note',
      isReady:true,
    });
    expect(factory).toHaveBeenCalledTimes(0);

    await act(async()=>{
      setSourceExternal(boundaryNote);
    });
    expect(stateSnapshot.exactSource).toBe(boundaryNote);
    expect(stateSnapshot.isReady).toBe(true);
    expect(factory).toHaveBeenCalledTimes(0);

    const uiAnalyzeSpy=vi.spyOn(documentAnalysis,'analyzeDocument');
    await act(async()=>{
      setSourceExternal(largeNote);
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(uiAnalyzeSpy).toHaveBeenCalledTimes(0);
    expect(stateSnapshot.pinnedSource).toBe(boundaryNote);
    expect(stateSnapshot.exactSource).toBeNull();

    uiAnalyzeSpy.mockRestore();
    await act(async()=>{
      workerInstance!.flushNext();
    });
    expect(stateSnapshot.exactSource).toBe(largeNote);
    expect(stateSnapshot.heading).toBe('Oversized Heading');
    client.dispose();
  });

  it('ignores stale worker responses and cancels superseded revisions across rapid async edits and large-to-small transitions',async()=>{
    const realAnalyze=documentAnalysis.analyzeDocument;
    const worker=new ControlledWorker(realAnalyze);
    const client=new DocumentAnalysisWorkerClient(()=>worker,{idleMs:30_000});

    // 1. Client-level stale message guard: out-of-order or duplicate responses with a stale id are ignored.
    const abortRev1=new AbortController();
    const p1=client.request('# Client Rev 1\n\nFirst.',abortRev1.signal);
    const p1Aborted=expect(p1).rejects.toMatchObject({name:'AbortError'});
    abortRev1.abort();
    await p1Aborted;

    const p2=client.request('# Client Rev 2\n\nSecond.');
    // Inject a stale/unknown job id while job 1 is still inFlight on the worker.
    worker.emitRaw({
      id:999,
      analysis:documentAnalysis.toCompactAnalysis(realAnalyze('# Ghost Heading\n\nStale payload.')),
    });
    expect(worker.posted).toHaveLength(1);

    // Flush job 1 so job 2 becomes inFlight, then replay a duplicate response for job 1: must be ignored!
    const job1Id=worker.posted[0].id;
    worker.flushNext();
    expect(worker.posted).toHaveLength(2);
    worker.emitRaw({
      id:job1Id,
      analysis:documentAnalysis.toCompactAnalysis(realAnalyze('# Stale Replay\n\nShould not resolve job 2.')),
    });
    expect(client.peek('# Stale Replay\n\nShould not resolve job 2.')).toBeNull();

    worker.flushNext();
    const res2=await p2;
    expect(res2.analysis.outline[0]?.title).toBe('Client Rev 2');

    // 2. Hook-level stale revision guard across rapid large edits followed by a small synchronous edit.
    const hookWorker=new ControlledWorker(realAnalyze);
    const hookClient=new DocumentAnalysisWorkerClient(()=>hookWorker,{idleMs:30_000});
    const baseBody=buildDocumentOfSize(WORKER_ANALYSIS_MIN_CHARS+1024);
    const largeRev1=`# Large Rev 1\n\n${baseBody}`;
    const largeRev2=`# Large Rev 2\n\n${baseBody}\nEdit two.`;
    const largeRev3=`# Large Rev 3\n\n${baseBody}\nEdit three.`;
    const largeRev4=`# Large Rev 4\n\n${baseBody}\nEdit four.`;
    const smallFinal='# Small Final\n\nSettled synchronously without waiting on stale worker jobs.';

    let setSourceExternal!:(next:string)=>void;
    let latestExact:string|null=null;
    let latestHeading='';

    function StaleRevisionHarness(){
      const [source,setSource]=useState(largeRev1);
      setSourceExternal=setSource;
      const {exactAnalysis,outline}=useDocumentAnalysis('stale-rev-doc',source,'reader',{client:hookClient});
      latestExact=exactAnalysis?.source??null;
      latestHeading=outline[0]?.title??'';
      return <div data-heading={latestHeading}/>;
    }

    const host=document.createElement('div');
    document.body.append(host);
    root=createRoot(host);

    await act(async()=>{
      root?.render(<StaleRevisionHarness/>);
    });
    await act(async()=>{
      hookWorker.flushNext();
    });
    expect(latestExact).toBe(largeRev1);
    expect(latestHeading).toBe('Large Rev 1');
    expect(hookWorker.posted).toHaveLength(1);

    // Rapidly dispatch largeRev2 (inFlight), largeRev3 (queued then aborted), largeRev4 (queued)...
    await act(async()=>{
      setSourceExternal(largeRev2);
    });
    await act(async()=>{
      setSourceExternal(largeRev3);
    });
    await act(async()=>{
      setSourceExternal(largeRev4);
    });
    expect(hookWorker.posted.map(job=>job.source)).toEqual([largeRev1,largeRev2]);

    // ...then shrink to smallFinal before largeRev2 finishes on the worker!
    await act(async()=>{
      setSourceExternal(smallFinal);
    });
    // smallFinal settles immediately on the synchronous path and aborts queued largeRev4.
    expect(latestExact).toBe(smallFinal);
    expect(latestHeading).toBe('Small Final');

    // Late completion of in-flight largeRev2 must NOT overwrite smallFinal OR pump aborted largeRev4!
    await act(async()=>{
      hookWorker.flushNext();
    });
    expect(hookWorker.posted.map(job=>job.source)).toEqual([largeRev1,largeRev2]);
    expect(latestExact).toBe(smallFinal);
    expect(latestHeading).toBe('Small Final');

    client.dispose();
    hookClient.dispose();
  });
});
