import {analyzeDocument} from './documentAnalysis';

const scope=self as unknown as {
  onmessage:((event:MessageEvent<{source:string}>)=>void)|null;
  postMessage:(value:unknown)=>void;
  close:()=>void;
};

scope.onmessage=event=>{
  try{
    // Only the compact outline crosses the worker boundary. Closing the
    // worker after this one job also releases analyzeDocument's AST cache.
    const outline=analyzeDocument(event.data.source).outline;
    scope.postMessage({outline});
  }catch{
    scope.postMessage({error:'outline-analysis-failed'});
  }finally{scope.close();}
};
