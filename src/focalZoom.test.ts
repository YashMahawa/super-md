import {expect,it} from "vitest";
import {axisNumber,axisTicks,zoomTranslation,zoomPlotCenter} from "./focalZoom";
it("keeps an off-center image point under the cursor and reverses cleanly",()=>{
  const focus={x:200,y:350},origin={x:600,y:400},pan={x:30,y:-60};
  const next=zoomTranslation(pan,origin,focus,100,250);
  const world={x:(focus.x-origin.x-pan.x),y:(focus.y-origin.y-pan.y)};
  expect(origin.x+next.x+world.x*2.5).toBeCloseTo(focus.x);
  expect(origin.y+next.y+world.y*2.5).toBeCloseTo(focus.y);
  const restored=zoomTranslation(next,origin,focus,250,100);expect(restored.x).toBeCloseTo(pan.x);expect(restored.y).toBeCloseTo(pan.y);
});
it("keeps the plotted world coordinate fixed at an asymmetric focus",()=>{
  const center={x:.13,y:-.27},focus={x:.82,y:.21},before=1.7,after=4.2;
  const next=zoomPlotCenter(center,before,after,focus);
  expect(next.x+(focus.x-.5)/after).toBeCloseTo(center.x+(focus.x-.5)/before);
  expect(next.y+(.5-focus.y)/after).toBeCloseTo(center.y+(.5-focus.y)/before);
});
it("produces readable, bounded axis ticks, not raw floating-point bounds",()=>{
  expect(axisNumber(11.545655894490642)).toBe("11.546");
  expect(axisTicks(-11.545655894490642,11.545655894490642)).toEqual([-10,-5,0,5,10]);
  expect(axisTicks(-1e50,1e50).length).toBeLessThan(20);expect(axisTicks(1,1)).toEqual([]);
});
