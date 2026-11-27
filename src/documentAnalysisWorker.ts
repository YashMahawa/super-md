import {useEffect,useRef,useState} from 'react';
import {
  analyzeDocument,
  hydrateDocumentAnalysis,
  type CompactDocumentAnalysis,
  type OutlineEntry,
  type SourceBlockRange,
  type SourceDocumentAnalysis,
} from './documentAnalysis';
import type {DocumentAnalysisWorkerRequest,DocumentAnalysisWorkerResponse} from './documentAnalysis.worker';
import type {ReaderDisplayMode} from './readerSourceAnalysis';

export type AnalysisWorkerLike = Pick<Worker,'postMessage'|'terminate'> & {
  onmessage:((event:MessageEvent<DocumentAnalysisWorkerResponse>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null;
  onmessageerror:((event:MessageEvent)=>void)|null;
};

type Subscriber = {
  resolve:(result:SourceDocumentAnalysis)=>void;
  reject:(error:Error)=>void;
  signal?:AbortSignal;
  onAbort?:()=>void;
};

type PendingJob = {
  id:number;
  source:string;
  subscribers:Set<Subscriber>;
};

export interface DocumentAnalysisWorkerOptions {
  idleMs?:number;
}

const DEFAULT_IDLE_MS=30_000;
const MAX_CACHE_ENTRIES=6;
const MAX_CACHE_CHARS=2_000_000;

function abortError():Error {
  const error=new Error('Document analysis cancelled');
  error.name='AbortError';
  return error;
}

function validBlockRanges(ranges:unknown,sourceLength:number):ranges is SourceBlockRange[] {
  return Array.isArray(ranges)&&ranges.every(range=>
    Boolean(range)&&Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.start>=0&&range.start<=range.end&&range.end<=sourceLength
  );
}

function validCompactAnalysis(value:unknown,sourceLength:number):value is CompactDocumentAnalysis {
  if(!value||typeof value!=='object')return false;
  const candidate=value as Partial<CompactDocumentAnalysis>;
  if(!candidate.tree||candidate.tree.type!=='root'||!Array.isArray(candidate.tree.children))return false;
  if(!validBlockRanges(candidate.blockRanges,sourceLength))return false;
  if(!validBlockRanges(candidate.bodyBlockRanges,sourceLength))return false;
  if(candidate.frontmatter!==null&&(
    !candidate.frontmatter||typeof candidate.frontmatter!=='object'||
    !Number.isInteger(candidate.frontmatter.end)||candidate.frontmatter.end<0||candidate.frontmatter.end>sourceLength
  ))return false;
  if(!Array.isArray(candidate.outline)||candidate.outline.length>2000||!candidate.outline.every(item=>
    Boolean(item)&&typeof item.id==='string'&&typeof item.title==='string'&&Number.isInteger(item.level)&&Number.isFinite(item.offset)
  ))return false;
  if(!Array.isArray(candidate.tasks)||!candidate.tasks.every(offset=>Number.isInteger(offset)&&offset>=0&&offset<=sourceLength))return false;
  if(!Array.isArray(candidate.pythonCells)||!candidate.pythonCells.every(cell=>
    Boolean(cell)&&typeof cell.source==='string'&&Number.isInteger(cell.ordinal)&&Number.isFinite(cell.offset)
  ))return false;
  return true;
}

function detachSubscriber(subscriber:Subscriber):void {
  if(subscriber.onAbort&&subscriber.signal){
    subscriber.signal.removeEventListener('abort',subscriber.onAbort);
    subscriber.onAbort=undefined;
  }
}

/**
 * Owns one lazy, warm background Markdown analysis worker shared across modes.
 * Coalesces bursts to at most 1 in-flight + 1 queued revision without cold
 * restarts, and terminates the worker + cached result after an idle timeout.
 */
export class DocumentAnalysisWorkerClient {
  private worker:AnalysisWorkerLike|null=null;
  private inFlight:PendingJob|null=null;
  private queued:PendingJob|null=null;
  private readonly cache=new Map<string,SourceDocumentAnalysis>();
  private cachedChars=0;
  private idleTimer:ReturnType<typeof setTimeout>|null=null;
  private nextId=0;
  private disposed=false;
  private readonly idleMs:number;
  private readonly hasCustomFactory:boolean;
  private readonly createWorker:()=>AnalysisWorkerLike;

  constructor(
    createWorker?:()=>AnalysisWorkerLike,
    options:DocumentAnalysisWorkerOptions={},
  ){
    this.hasCustomFactory=Boolean(createWorker);
    this.idleMs=Math.max(0,options.idleMs??DEFAULT_IDLE_MS);
    this.createWorker=createWorker??(()=>new Worker(new URL('./documentAnalysis.worker.ts',import.meta.url),{type:'module'}));
  }

  isAvailable():boolean {
    return !this.disposed&&(this.hasCustomFactory||typeof Worker!=='undefined');
  }

  /** Return a recently completed analysis if its source is in the bounded LRU cache. */
  peek(source:string):SourceDocumentAnalysis|null {
    if(this.disposed)return null;
    return this.getCached(source,false);
  }

  /** Warm the background worker ahead of the first note load while still reclaiming after idleMs. */
  prewarm():void {
    if(!this.isAvailable()||this.worker)return;
    try{
      this.ensureWorker();
      if(!this.inFlight&&!this.queued)this.scheduleIdle();
    }catch{
      // Ignore prewarm failures; request() will handle fallback cleanly.
    }
  }

  request(source:string,signal?:AbortSignal):Promise<SourceDocumentAnalysis> {
    if(this.disposed)return Promise.reject(new Error('Document analysis worker client is disposed'));
    if(signal?.aborted)return Promise.reject(abortError());
    const cached=this.getCached(source,true);
    if(cached){
      if(!this.inFlight&&!this.queued)this.scheduleIdle();
      return Promise.resolve(cached);
    }
    if(this.inFlight?.source===source)return this.subscribe(this.inFlight,signal);
    if(this.queued?.source===source)return this.subscribe(this.queued,signal);

    this.clearIdle();

    if(this.inFlight){
      if(this.queued)this.rejectJob(this.queued,abortError());
      const job:PendingJob={id:++this.nextId,source,subscribers:new Set()};
      this.queued=job;
      return this.subscribe(job,signal);
    }

    let worker:AnalysisWorkerLike;
    try{
      worker=this.ensureWorker();
    }catch(error){
      this.scheduleIdle();
      return Promise.reject(error instanceof Error?error:new Error('Could not start document analysis worker'));
    }

    const job:PendingJob={id:++this.nextId,source,subscribers:new Set()};
    this.inFlight=job;
    const promise=this.subscribe(job,signal);
    this.postJob(worker,job);
    return promise;
  }

  /** Cancel any queued or in-flight callers while keeping a healthy worker warm, or terminate on dispose. */
  cancel():void {
    if(this.queued){
      const queued=this.queued;
      this.queued=null;
      this.rejectJob(queued,abortError());
    }
    if(this.inFlight){
      const active=this.inFlight;
      this.rejectJob(active,abortError());
    }
    if(!this.inFlight&&!this.queued)this.scheduleIdle();
  }

  reclaimIdle():void {
    this.clearIdle();
    if(this.inFlight||this.queued)return;
    this.terminateWorker();
    this.clearCache();
  }

  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    this.clearIdle();
    if(this.queued){
      const queued=this.queued;
      this.queued=null;
      this.rejectJob(queued,abortError());
    }
    if(this.inFlight){
      const active=this.inFlight;
      this.inFlight=null;
      this.rejectJob(active,abortError());
    }
    this.terminateWorker();
    this.clearCache();
  }

  private getCached(source:string,touch:boolean):SourceDocumentAnalysis|null {
    const hit=this.cache.get(source);
    if(!hit)return null;
    if(touch){
      this.cache.delete(source);
      this.cache.set(source,hit);
    }
    return hit;
  }

  private putCached(result:SourceDocumentAnalysis):void {
    const existing=this.cache.get(result.source);
    if(existing){
      this.cache.delete(result.source);
      this.cachedChars-=existing.source.length;
    }
    this.cache.set(result.source,result);
    this.cachedChars+=result.source.length;
    while(this.cache.size>1&&(this.cache.size>MAX_CACHE_ENTRIES||this.cachedChars>MAX_CACHE_CHARS)){
      const oldestKey=this.cache.keys().next().value;
      if(oldestKey===undefined)break;
      const evicted=this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.cachedChars-=evicted.source.length;
    }
  }

  private clearCache():void {
    this.cache.clear();
    this.cachedChars=0;
  }

  private subscribe(job:PendingJob,signal?:AbortSignal):Promise<SourceDocumentAnalysis> {
    return new Promise<SourceDocumentAnalysis>((resolve,reject)=>{
      const subscriber:Subscriber={resolve,reject,signal};
      if(signal){
        subscriber.onAbort=()=>{
          detachSubscriber(subscriber);
          job.subscribers.delete(subscriber);
          reject(abortError());
          if(this.queued===job&&job.subscribers.size===0){
            this.queued=null;
            if(!this.inFlight)this.scheduleIdle();
          }
        };
        signal.addEventListener('abort',subscriber.onAbort,{once:true});
      }
      job.subscribers.add(subscriber);
    });
  }

  private ensureWorker():AnalysisWorkerLike {
    if(this.worker)return this.worker;
    if(!this.isAvailable())throw new Error('Background Worker is unavailable');
    const worker=this.createWorker();
    worker.onmessage=event=>this.handleMessage(worker,event);
    worker.onerror=()=>this.handleWorkerFailure(worker,new Error('Document analysis worker failed'));
    worker.onmessageerror=()=>this.handleWorkerFailure(worker,new Error('Document analysis worker returned unreadable data'));
    this.worker=worker;
    return worker;
  }

  private postJob(worker:AnalysisWorkerLike,job:PendingJob):void {
    const payload:DocumentAnalysisWorkerRequest={id:job.id,source:job.source};
    try{
      worker.postMessage(payload);
    }catch(error){
      if(this.inFlight===job)this.inFlight=null;
      this.terminateWorker();
      this.rejectJob(job,error instanceof Error?error:new Error('Could not send source to document analysis worker'));
      this.pumpQueue();
    }
  }

  private handleMessage(worker:AnalysisWorkerLike,event:MessageEvent<DocumentAnalysisWorkerResponse>):void {
    if(this.worker!==worker)return;
    const job=this.inFlight;
    if(!job||event.data?.id!==job.id)return;
    this.inFlight=null;

    if(event.data.error){
      this.rejectJob(job,new Error(event.data.error));
      this.pumpQueue();
      return;
    }

    if(!validCompactAnalysis(event.data.analysis,job.source.length)){
      this.rejectJob(job,new Error('Document analysis worker returned invalid data'));
      this.pumpQueue();
      return;
    }

    const hydrated=hydrateDocumentAnalysis(job.source,event.data.analysis);
    this.putCached(hydrated);
    this.resolveJob(job,hydrated);
    this.pumpQueue();
  }

  private handleWorkerFailure(worker:AnalysisWorkerLike,error:Error):void {
    if(this.worker!==worker)return;
    this.terminateWorker();
    const active=this.inFlight;
    this.inFlight=null;
    if(active)this.rejectJob(active,error);
    if(this.queued){
      const next=this.queued;
      this.queued=null;
      this.rejectJob(next,error);
    }
    this.scheduleIdle();
  }

  private pumpQueue():void {
    while(this.queued){
      const next=this.queued;
      this.queued=null;
      if(next.subscribers.size===0)continue;
      let worker:AnalysisWorkerLike;
      try{
        worker=this.ensureWorker();
      }catch(error){
        this.rejectJob(next,error instanceof Error?error:new Error('Could not restart document analysis worker'));
        continue;
      }
      this.inFlight=next;
      this.postJob(worker,next);
      return;
    }
    if(!this.inFlight)this.scheduleIdle();
  }

  private resolveJob(job:PendingJob,result:SourceDocumentAnalysis):void {
    const subscribers=Array.from(job.subscribers);
    job.subscribers.clear();
    for(const subscriber of subscribers){
      detachSubscriber(subscriber);
      subscriber.resolve(result);
    }
  }

  private rejectJob(job:PendingJob,error:Error):void {
    const subscribers=Array.from(job.subscribers);
    job.subscribers.clear();
    for(const subscriber of subscribers){
      detachSubscriber(subscriber);
      subscriber.reject(error);
    }
  }

  private clearIdle():void {
    if(this.idleTimer!==null){
      clearTimeout(this.idleTimer);
      this.idleTimer=null;
    }
  }

  private scheduleIdle():void {
    this.clearIdle();
    if(this.disposed||(!this.worker&&this.cache.size===0))return;
    this.idleTimer=setTimeout(()=>this.reclaimIdle(),this.idleMs);
    (this.idleTimer as {unref?:()=>void})?.unref?.();
  }

  private terminateWorker():void {
    const worker=this.worker;
    if(!worker)return;
    this.worker=null;
    worker.onmessage=null;
    worker.onerror=null;
    worker.onmessageerror=null;
    worker.terminate();
  }
}

export const WORKER_ANALYSIS_MIN_CHARS=80_000;
export const sharedDocumentAnalysisClient=new DocumentAnalysisWorkerClient();

export interface UseDocumentAnalysisOptions {
  enabled?:boolean;
  client?:DocumentAnalysisWorkerClient;
  minWorkerChars?:number;
}

export interface DocumentAnalysisState {
  /** Latest completed analysis for the active document (pinned during edits). */
  pinnedAnalysis:SourceDocumentAnalysis|null;
  /** Non-null only when pinnedAnalysis matches the exact current `source`. */
  exactAnalysis:SourceDocumentAnalysis|null;
  /** Latest outline headings for the active document. */
  outline:OutlineEntry[];
  /** True once the active mode can mount its primary content surface. */
  isReady:boolean;
}

const EMPTY_OUTLINE:OutlineEntry[]=[];

/**
 * Shared off-thread document analysis hook for Reader, Split, Live, and Source
 * modes across Android, desktop, and web, with synchronous execution for small
 * (`<= 80,000` chars) or Worker-unsupported documents.
 */
export function useDocumentAnalysis(
  documentId:string|null,
  source:string,
  mode:ReaderDisplayMode,
  options:UseDocumentAnalysisOptions={},
):DocumentAnalysisState {
  const enabled=options.enabled??true;
  const client=options.client??sharedDocumentAnalysisClient;
  const minWorkerChars=options.minWorkerChars??WORKER_ANALYSIS_MIN_CHARS;
  const workerAvailable=client.isAvailable();
  const [completed,setCompleted]=useState<{documentId:string;value:SourceDocumentAnalysis}|null>(()=>{
    if(!enabled||documentId===null)return null;
    const cached=client.peek(source);
    if(cached)return {documentId,value:cached};
    if(!workerAvailable||source.length<=minWorkerChars){
      if(mode==='editor'&&!workerAvailable&&source.length>minWorkerChars)return null;
      return {documentId,value:{source,analysis:analyzeDocument(source)}};
    }
    return null;
  });
  const retainedRef=useRef<{documentId:string;value:SourceDocumentAnalysis}|null>(completed);

  const hasPriorForDoc=enabled&&documentId!==null&&(
    retainedRef.current?.documentId===documentId||completed?.documentId===documentId
  );
  const deferLargeFallback=!workerAvailable&&source.length>minWorkerChars&&(mode==='editor'||hasPriorForDoc);
  const shouldRunSync=source.length<=minWorkerChars||(!workerAvailable&&!deferLargeFallback);

  const peeked=enabled&&documentId!==null?client.peek(source):null;
  const existingExact=enabled&&documentId!==null
    ? (retainedRef.current?.documentId===documentId&&retainedRef.current.value.source===source
      ? retainedRef.current.value
      : completed?.documentId===documentId&&completed.value.source===source
        ? completed.value
        : null)
    : null;
  const syncImmediate=enabled&&documentId!==null&&!peeked&&shouldRunSync
    ? (existingExact??{source,analysis:analyzeDocument(source)})
    : null;
  const immediate=peeked??syncImmediate;

  if(!enabled||documentId===null){
    retainedRef.current=null;
  }else if(retainedRef.current?.documentId!==documentId){
    retainedRef.current=immediate?{documentId,value:immediate}:(completed?.documentId===documentId?completed:null);
  }else if(immediate){
    retainedRef.current={documentId,value:immediate};
  }

  const docSessionRef=useRef<{documentId:string;controller:AbortController;nextSeq:number;appliedSeq:number;lastImmediateSource:string|null}|null>(null);
  const ensureSession=(id:string)=>{
    const current=docSessionRef.current;
    if(current&&current.documentId===id&&!current.controller.signal.aborted)return current;
    current?.controller.abort();
    const next={documentId:id,controller:new AbortController(),nextSeq:0,appliedSeq:0,lastImmediateSource:null};
    docSessionRef.current=next;
    return next;
  };
  if(documentId===null){
    docSessionRef.current?.controller.abort();
    docSessionRef.current=null;
  }else{
    const session=ensureSession(documentId);
    if(immediate&&session.lastImmediateSource!==source){
      session.lastImmediateSource=source;
      session.appliedSeq=++session.nextSeq;
    }else if(!immediate){
      session.lastImmediateSource=null;
    }
  }

  useEffect(()=>()=>{
    docSessionRef.current?.controller.abort();
    docSessionRef.current=null;
  },[]);

  useEffect(()=>{
    if(!enabled||documentId===null)return;
    const session=ensureSession(documentId);

    const cached=client.peek(source);
    if(cached){
      const seq=++session.nextSeq;
      session.appliedSeq=seq;
      session.lastImmediateSource=source;
      const next={documentId,value:cached};
      retainedRef.current=next;
      setCompleted(prev=>prev?.documentId===documentId&&prev.value===cached?prev:next);
      return;
    }

    if(shouldRunSync){
      const seq=++session.nextSeq;
      session.appliedSeq=seq;
      session.lastImmediateSource=source;
      const reused=retainedRef.current?.documentId===documentId&&retainedRef.current.value.source===source
        ? retainedRef.current.value
        : {source,analysis:analyzeDocument(source)};
      const next={documentId,value:reused};
      retainedRef.current=next;
      setCompleted(prev=>prev?.documentId===documentId&&prev.value===reused?prev:next);
      return;
    }

    if(!workerAvailable){
      const seq=++session.nextSeq;
      const timerId=setTimeout(()=>{
        if(session.controller.signal.aborted||seq<session.appliedSeq)return;
        session.appliedSeq=seq;
        session.lastImmediateSource=source;
        const fallback={source,analysis:analyzeDocument(source)};
        const next={documentId,value:fallback};
        retainedRef.current=next;
        setCompleted(prev=>prev?.documentId===documentId&&prev.value.source===source?prev:next);
      },120);
      return()=>{
        clearTimeout(timerId);
      };
    }

    const coalesceMs=mode==='editor'&&hasPriorForDoc&&source.length>WORKER_ANALYSIS_MIN_CHARS?120:0;
    const seq=++session.nextSeq;
    const requestController=new AbortController();
    const abortRequest=()=>requestController.abort();
    session.controller.signal.addEventListener('abort',abortRequest,{once:true});
    let timerId:ReturnType<typeof setTimeout>|null=null;
    let cancelledBeforeDispatch=false;

    const dispatch=()=>{
      if(cancelledBeforeDispatch||requestController.signal.aborted||session.controller.signal.aborted)return;
      client.request(source,requestController.signal).then(
        result=>{
          if(requestController.signal.aborted||session.controller.signal.aborted||seq<session.appliedSeq)return;
          session.appliedSeq=seq;
          const next={documentId,value:result};
          retainedRef.current=next;
          setCompleted(prev=>prev?.documentId===documentId&&prev.value===result?prev:next);
        },
        (error:unknown)=>{
          if(requestController.signal.aborted||session.controller.signal.aborted||(error instanceof Error&&error.name==='AbortError'))return;
          if(seq<session.appliedSeq)return;
          session.appliedSeq=seq;
          const fallback={source,analysis:analyzeDocument(source)};
          const next={documentId,value:fallback};
          retainedRef.current=next;
          setCompleted(next);
        },
      );
    };

    if(coalesceMs>0){
      timerId=setTimeout(dispatch,coalesceMs);
    }else{
      dispatch();
    }

    return()=>{
      cancelledBeforeDispatch=true;
      if(timerId!==null)clearTimeout(timerId);
      session.controller.signal.removeEventListener('abort',abortRequest);
      requestController.abort();
    };
  },[enabled,documentId,source,mode,client,shouldRunSync]);

  if(!enabled||documentId===null){
    return {pinnedAnalysis:null,exactAnalysis:null,outline:EMPTY_OUTLINE,isReady:false};
  }

  const pinnedAnalysis=immediate??(retainedRef.current?.documentId===documentId?retainedRef.current.value:completed?.documentId===documentId?completed.value:null);
  const exactAnalysis=pinnedAnalysis?.source===source?pinnedAnalysis:null;
  const outline=pinnedAnalysis?.analysis.outline??EMPTY_OUTLINE;
  const isReady=mode==='editor'||pinnedAnalysis!==null;

  return {pinnedAnalysis,exactAnalysis,outline,isReady};
}
