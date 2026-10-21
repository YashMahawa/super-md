// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cancelHeadingNavigation,navigateToHeading} from './documentNavigation';

afterEach(()=>{
  document.documentElement.style.removeProperty('--native-visible-chrome-inset');
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([[undefined,16],['209.5px',225.5],['0px',16],['-30px',16],['invalid',16],['9999px',496]] as const)(
  'places a heading below the visible native overlay (%s)',(inset,gap)=>{
    // Rendering viewport and note geometry are unchanged: only the navigation
    // destination avoids controls the native host says are currently visible.
    vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));
    vi.stubGlobal('cancelAnimationFrame',vi.fn());
    vi.stubGlobal('ResizeObserver',undefined);
    const root=document.createElement('section');
    root.className='android-reading';
    root.innerHTML='<h2 id="destination" data-heading-key="destination">Destination</h2>';
    const heading=root.firstElementChild as HTMLElement;
    document.body.append(root);
    root.getBoundingClientRect=()=>({top:0,left:0,width:400,height:700,bottom:700,right:400,x:0,y:0,toJSON(){}});
    heading.getBoundingClientRect=()=>({top:1000-root.scrollTop,left:16,width:300,height:30,bottom:1030-root.scrollTop,right:316,x:16,y:1000-root.scrollTop,toJSON(){}});
    if(inset!==undefined)document.documentElement.style.setProperty('--native-visible-chrome-inset',inset);
    try{
      expect(navigateToHeading(root,'destination')).toBe(true);
      expect(root.scrollTop).toBe(1000-gap);
      expect(heading.getBoundingClientRect().top).toBe(gap);
    }finally{cancelHeadingNavigation(root);}
  },
);
