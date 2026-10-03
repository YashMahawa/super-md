import {afterEach,expect,test} from 'vitest';
import {pythonResults,remember} from './renderedOutputs';
import {chartCenters} from './renderedOutputs';
afterEach(()=>pythonResults.clear());
test('small graph states survive scrolling through more than sixty graphs',()=>{
  chartCenters.clear();for(let i=0;i<1000;i++)remember(chartCenters,`graph-${i}`,{x:i,y:i});
  expect(chartCenters.size).toBe(1000);expect(chartCenters.get('graph-0')).toEqual({x:0,y:0});chartCenters.clear();
});
test('derived Python image cache is bounded by volume and refreshes recency',()=>{
  const result={ok:true,stdout:'',stderr:'',images:['data:image/png;base64,'+'a'.repeat(3_000_000)]};
  remember(pythonResults,'first',result);remember(pythonResults,'second',result);
  remember(pythonResults,'first',result);remember(pythonResults,'third',result);
  expect([...pythonResults.keys()]).toEqual(['first','third']);
  expect(pythonResults.size).toBe(2);
});
