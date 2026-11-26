import {afterEach,expect,test} from 'vitest';
import {chartCenters,exportRenderedViews,importRenderedViews,pythonResults,remember,stepIndices} from './renderedOutputs';
afterEach(()=>{pythonResults.clear();stepIndices.clear();chartCenters.clear();});
test('small graph states survive scrolling through more than sixty graphs',()=>{
  chartCenters.clear();for(let i=0;i<1000;i++)remember(chartCenters,`graph-${i}`,{x:i,y:i});
  expect(chartCenters.size).toBe(1000);expect(chartCenters.get('graph-0')).toEqual({x:0,y:0});chartCenters.clear();
});
test('stepIndices enforces 5000-entry LRU limit and round-trips through rendered view serialization',()=>{
  for(let i=0;i<5002;i++)remember(stepIndices,`deck-${i}`,i%10);
  expect(stepIndices.size).toBe(5000);
  expect(stepIndices.has('deck-0')).toBe(false);
  expect(stepIndices.has('deck-1')).toBe(false);
  remember(stepIndices,'deck-2',4);
  remember(stepIndices,'deck-5002',1);
  expect(stepIndices.get('deck-2')).toBe(4);
  expect(stepIndices.has('deck-3')).toBe(false);

  stepIndices.clear();
  const activeDeck='{"title":"Study","steps":[{"label":"A","description":"1"},{"label":"B","description":"2"},{"label":"C","description":"3"}]}';
  remember(stepIndices,activeDeck,2);
  remember(stepIndices,'{"title":"Other"}',1);
  const content=`# Note\n\n\`\`\`smd-steps\n${activeDeck}\n\`\`\`\n`;
  const exported=exportRenderedViews(content);
  expect(exported.steps).toEqual([[activeDeck,2]]);

  stepIndices.clear();
  importRenderedViews(content,{...exported,steps:[[activeDeck,2],[activeDeck,-1],[activeDeck,40],[activeDeck,1.5],['missing',1]]});
  expect(stepIndices.get(activeDeck)).toBe(2);
  expect(stepIndices.has('missing')).toBe(false);
});
test('derived Python image cache is bounded by volume and refreshes recency',()=>{
  const result={ok:true,stdout:'',stderr:'',images:['data:image/png;base64,'+'a'.repeat(3_000_000)]};
  remember(pythonResults,'first',result);remember(pythonResults,'second',result);
  remember(pythonResults,'first',result);remember(pythonResults,'third',result);
  expect([...pythonResults.keys()]).toEqual(['first','third']);
  expect(pythonResults.size).toBe(2);
});
