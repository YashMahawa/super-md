import {expect,it} from "vitest";
import {wheelIntent} from "./wheelIntent";
it("separates notched wheels, smooth movement, modifier pinch and held-scroll zoom",()=>{
  const base={ctrlKey:false,metaKey:false,deltaMode:0,deltaX:0,deltaY:120,buttons:0};
  expect(wheelIntent(base)).toBe("scroll");expect(wheelIntent({...base,deltaMode:1,deltaY:3})).toBe("scroll");
  expect(wheelIntent({...base,deltaY:6.5})).toBe("pan");expect(wheelIntent({...base,deltaX:5})).toBe("pan");
  expect(wheelIntent({...base,ctrlKey:true})).toBe("zoom");expect(wheelIntent(base,true)).toBe("zoom");
});
