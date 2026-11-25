// @vitest-environment jsdom
import {StrictMode,act,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as documentAnalysis from './documentAnalysis';
import {
  DocumentAnalysisWorkerClient,
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

    // Lazy initialization: zero workers until first request.
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

    // Subsequent edit lazily spawns a fresh worker.
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

    //Exceeding 6 cached entries evicts the least-recently-used revision while keeping recent ones.
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

  it('transfers compact block ranges without block text strings across the worker boundary',async()=>{
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
    client.dispose();
  });

  it('triggers zero UI-thread analyzeDocument calls when typing in Split mode on both 79 KB and 1 MB documents while pinning preview revisions',async()=>{
    class NoopIntersectionObserver { observe(){} unobserve(){} disconnect(){} }
    class NoopResizeObserver { observe(){} disconnect(){} }
    vi.stubGlobal('IntersectionObserver',NoopIntersectionObserver);
    vi.stubGlobal('ResizeObserver',NoopResizeObserver);

    const realAnalyze=documentAnalysis.analyzeDocument;
    const uiAnalyzeSpy=vi.spyOn(documentAnalysis,'analyzeDocument');

    for(const [label,sizeBytes,mountFullPreview] of [['79 KB',79*1024,true],['1 MB',1024*1024,false]] as const){
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
        const {pinnedAnalysis,outline,isReady}=useDocumentAnalysis('fallback-doc','# Sync Heading\n\nBody text.','reader',{client});
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
});
