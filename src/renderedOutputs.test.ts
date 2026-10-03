import {afterEach,expect,test} from 'vitest';
import {pythonResults,remember} from './renderedOutputs';
afterEach(()=>pythonResults.clear());
test('derived Python image cache is bounded by volume and refreshes recency',()=>{
  const result={ok:true,stdout:'',stderr:'',images:['data:image/png;base64,'+'a'.repeat(3_000_000)]};
  remember(pythonResults,'first',result);remember(pythonResults,'second',result);
  remember(pythonResults,'first',result);remember(pythonResults,'third',result);
  expect([...pythonResults.keys()]).toEqual(['first','third']);
  expect(pythonResults.size).toBe(2);
});
