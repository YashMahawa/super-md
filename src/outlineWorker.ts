import type {OutlineEntry} from './documentAnalysis';

type OutlineWorkerResponse = {outline:OutlineEntry[]};
type OutlineWorkerLike = Pick<Worker,'postMessage'|'terminate'> & {
  onmessage:((event:MessageEvent<OutlineWorkerResponse>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null;
  onmessageerror:((event:MessageEvent)=>void)|null;
};
type ActiveRequest = {
  source:string;
  worker:OutlineWorkerLike;
  signal?:AbortSignal;
  onAbort?:()=>void;
  promise:Promise<OutlineEntry[]>;
  resolve:(outline:OutlineEntry[])=>void;
  reject:(error:Error)=>void;
};

function abortError():Error {
  const error=new Error('Outline analysis cancelled');
  error.name='AbortError';
  return error;
}

function validOutline(value:unknown):value is OutlineEntry[] {
  return Array.isArray(value)&&value.length<=2000&&value.every(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&Number.isInteger(item.level)&&Number.isFinite(item.offset));
}

/** Owns at most one lazy worker and never retains source or results after completion. */
export class OutlineWorkerClient {
  private active:ActiveRequest|null=null;
  private disposed=false;

  constructor(private readonly createWorker:()=>OutlineWorkerLike=()=>new Worker(new URL('./outlineAnalysis.worker.ts',import.meta.url),{type:'module'})){}

  request(source:string,signal?:AbortSignal):Promise<OutlineEntry[]> {
    if(this.disposed)return Promise.reject(new Error('Outline worker client is disposed'));
    if(signal?.aborted)return Promise.reject(abortError());
    if(this.active?.source===source&&this.active.signal===signal)return this.active.promise;
    this.cancel();
    let worker:OutlineWorkerLike;
    try{worker=this.createWorker();}catch(error){return Promise.reject(error instanceof Error?error:new Error('Could not start outline worker'));}
    let resolvePromise!:(outline:OutlineEntry[])=>void,rejectPromise!:(error:Error)=>void;
    const promise=new Promise<OutlineEntry[]>((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject;});
    const request:ActiveRequest={source,worker,signal,promise,resolve:resolvePromise,reject:rejectPromise};
    this.active=request;
    const finish=(error:Error|null,outline?:OutlineEntry[])=>{
      if(this.active!==request)return;
      this.active=null;
      if(request.onAbort)request.signal?.removeEventListener('abort',request.onAbort);
      request.worker.onmessage=null;request.worker.onerror=null;request.worker.onmessageerror=null;
      request.worker.terminate();
      if(error)request.reject(error);else request.resolve(outline!);
    };
    request.worker.onmessage=event=>{
      if(!validOutline(event.data?.outline)){finish(new Error('Outline worker returned invalid data'));return;}
      finish(null,event.data.outline);
    };
    request.worker.onerror=()=>finish(new Error('Outline worker failed'));
    request.worker.onmessageerror=()=>finish(new Error('Outline worker returned unreadable data'));
    if(signal){request.onAbort=()=>finish(abortError());signal.addEventListener('abort',request.onAbort,{once:true});}
    try{request.worker.postMessage({source});}catch(error){finish(error instanceof Error?error:new Error('Could not send source to outline worker'));}
    return promise;
  }

  /** Cancel any in-flight generation; late messages are ignored. */
  cancel():void {
    const request=this.active;
    if(!request)return;
    this.active=null;
    if(request.onAbort)request.signal?.removeEventListener('abort',request.onAbort);
    request.worker.onmessage=null;request.worker.onerror=null;request.worker.onmessageerror=null;
    request.worker.terminate();
    request.reject(abortError());
  }

  dispose():void {if(this.disposed)return;this.cancel();this.disposed=true;}
}
