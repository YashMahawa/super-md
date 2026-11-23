import {analyzeDocument,toCompactAnalysis,type CompactDocumentAnalysis} from './documentAnalysis';

export interface DocumentAnalysisWorkerRequest {
  id:number;
  source:string;
}

export interface DocumentAnalysisWorkerResponse {
  id:number;
  analysis?:CompactDocumentAnalysis;
  error?:string;
}

const scope=self as unknown as {
  onmessage:((event:MessageEvent<DocumentAnalysisWorkerRequest>)=>void)|null;
  postMessage:(value:DocumentAnalysisWorkerResponse)=>void;
};

scope.onmessage=event=>{
  const id=event.data?.id;
  if(typeof id!=='number'||typeof event.data?.source!=='string')return;
  try{
    // Stay warm across consecutive edits so unified/remark JIT and the bounded
    // 8 MB AST cache remain hot; the UI client terminates us after idle timeout.
    const analysis=toCompactAnalysis(analyzeDocument(event.data.source));
    scope.postMessage({id,analysis});
  }catch(error){
    scope.postMessage({id,error:error instanceof Error?error.message:'document-analysis-failed'});
  }
};
