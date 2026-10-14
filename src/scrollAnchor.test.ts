// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {captureScrollAnchor,markScrollInput} from './scrollAnchor';
it('does not restore an old anchor over newer native or browser scroll input',()=>{
  const root=document.createElement('div');document.body.append(root);root.scrollTop=200;
  const restore=captureScrollAnchor(root);markScrollInput();root.scrollTop=450;restore();expect(root.scrollTop).toBe(450);
  const next=captureScrollAnchor(root);document.dispatchEvent(new WheelEvent('wheel'));root.scrollTop=600;next();expect(root.scrollTop).toBe(600);root.remove();
});
