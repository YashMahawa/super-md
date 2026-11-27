// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {alignRangeToCurrentSource,applyAlignedEdit,applyAlignedTaskToggle} from './revisionEdit';
import {analyzeDocument} from './documentAnalysis';
import MarkdownPreview from './components/MarkdownPreview';
import LiveEditor from './components/LiveEditor';
import MediaTools from './components/MediaTools';

vi.mock('@tauri-apps/api/core',()=>({
  invoke:vi.fn(async()=>'data:image/png;base64,iVBORw0KGgo='),
}));

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

let root:Root|null=null;
afterEach(()=>{
  if(root){
    act(()=>root?.unmount());
    root=null;
  }
  document.body.innerHTML='';
});

describe('revision alignment & interactive preview safety',()=>{
  it('aligns spans before and after non-overlapping edits including emoji UTF-16 pairs and rejects overlapping stale spans',()=>{
    const base='# Title\n\n- [ ] First task\n\nMiddle paragraph.\n\n- [ ] Second task 🚀\n';
    const secondTaskOffset=base.lastIndexOf('[ ]')+1;
    const firstTaskOffset=base.indexOf('[ ]')+1;

    // Edit inserted in the middle paragraph: first task stays in prefix, second task shifts by delta.
    const editedMiddle=base.replace('Middle paragraph.','Middle paragraph with newly typed 🚀🚀 text!\nExtra line.');
    const delta=editedMiddle.length-base.length;

    const firstToggle=applyAlignedTaskToggle(base,editedMiddle,firstTaskOffset,true);
    expect(firstToggle).not.toBeNull();
    expect(firstToggle!.change).toEqual({from:firstTaskOffset,to:firstTaskOffset+1,insert:'x'});
    expect(firstToggle!.content).toContain('- [x] First task');
    expect(firstToggle!.content).toContain('Middle paragraph with newly typed 🚀🚀 text!');

    const secondToggle=applyAlignedTaskToggle(base,editedMiddle,secondTaskOffset,true);
    expect(secondToggle).not.toBeNull();
    expect(secondToggle!.change).toEqual({from:secondTaskOffset+delta,to:secondTaskOffset+delta+1,insert:'x'});
    expect(secondToggle!.content).toContain('- [x] Second task 🚀');
    expect(secondToggle!.content).toContain('Middle paragraph with newly typed 🚀🚀 text!');

    // Concurrent edit that overwrote the second task itself MUST be rejected cleanly!
    const overwrittenTask=base.replace('- [ ] Second task 🚀','Replaced the task with prose.');
    expect(applyAlignedTaskToggle(base,overwrittenTask,secondTaskOffset,true)).toBeNull();
    expect(alignRangeToCurrentSource(base,overwrittenTask,secondTaskOffset-2,secondTaskOffset+5)).toBeNull();
    expect(applyAlignedEdit(base,overwrittenTask,secondTaskOffset-2,secondTaskOffset+5,'x')).toBeNull();
  });

  it('aligns MarkdownPreview task toggles from a pinned base revision onto newer source and reverts rejected stale clicks',async()=>{
    const host=document.createElement('div');
    document.body.append(host);
    root=createRoot(host);

    const pinnedSource='# Tasks\n\nIntro paragraph.\n\n- [ ] Ship worker\n';
    const pinnedAnalysis={source:pinnedSource,analysis:analyzeDocument(pinnedSource)};
    let authoritativeSource='# Tasks\n\nIntro paragraph edited while worker is busy!\n\n- [ ] Ship worker\n';

    const onToggleTask=vi.fn((base:string,offset:number,checked:boolean)=>{
      const aligned=applyAlignedTaskToggle(base,authoritativeSource,offset,checked);
      if(!aligned)return false;
      authoritativeSource=aligned.content;
      return true;
    });

    await act(async()=>{
      root?.render(
        <MarkdownPreview
          markdown={pinnedAnalysis.source}
          sourceAnalysis={pinnedAnalysis}
          onToggleTask={onToggleTask}
          documentPath={null}
          python=""
          dark={false}
        />,
      );
    });

    const checkbox=host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(checkbox.checked).toBe(false);
    await act(async()=>checkbox.click());
    expect(authoritativeSource).toBe('# Tasks\n\nIntro paragraph edited while worker is busy!\n\n- [x] Ship worker\n');

    // Worker finishes analyzing the checked revision:
    const checkedPinned={source:authoritativeSource,analysis:analyzeDocument(authoritativeSource)};
    await act(async()=>{
      root?.render(
        <MarkdownPreview
          markdown={checkedPinned.source}
          sourceAnalysis={checkedPinned}
          onToggleTask={onToggleTask}
          documentPath={null}
          python=""
          dark={false}
        />,
      );
    });
    const refreshedCheckbox=host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(refreshedCheckbox.checked).toBe(true);

    // Now simulate concurrent edit overwriting the task line while preview is still pinned:
    authoritativeSource='# Tasks\n\nTask list removed in Source mode.\n';
    await act(async()=>refreshedCheckbox.click());
    // Text is uncorrupted and checkbox reverted visually back to checked!
    expect(authoritativeSource).toBe('# Tasks\n\nTask list removed in Source mode.\n');
    expect(refreshedCheckbox.checked).toBe(true);
  });

  it('aligns LiveEditor inline block opening and edits when pinned sourceAnalysis lags behind newer non-overlapping edits',async()=>{
    const host=document.createElement('div');
    document.body.append(host);
    root=createRoot(host);

    const base='# Heading\n\nFirst block.\n\nSecond editable block.';
    const pinned={source:base,analysis:analyzeDocument(base)};
    let current='# Heading (edited earlier)\n\nFirst block.\n\nSecond editable block.';
    const onChange=vi.fn((next:string)=>{current=next;});

    await act(async()=>{
      root?.render(
        <LiveEditor
          markdown={current}
          sourceAnalysis={pinned}
          onChange={onChange}
          documentPath={null}
          python=""
          dark={false}
        />,
      );
    });

    const blocks=host.querySelectorAll<HTMLElement>('.live-block');
    const lastBlock=blocks[blocks.length-1]!;
    await act(async()=>{
      lastBlock.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    });
    const textarea=host.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea?.value).toBe('Second editable block.');

    await act(async()=>{
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
      setter.call(textarea,'Second block updated cleanly.');
      textarea!.dispatchEvent(new Event('input',{bubbles:true}));
    });

    expect(current).toBe('# Heading (edited earlier)\n\nFirst block.\n\nSecond block updated cleanly.');
  });

  it('aligns MediaTools image removal from a pinned renderedContent onto shifted current content and blocks overlapping stale edits',async()=>{
    const host=document.createElement('div');
    host.className='android-document';
    document.body.append(host);
    root=createRoot(host);

    const renderedContent='# Gallery\n\nIntro.\n\n![Chart](data:image/png;base64,iVBORw0KGgo=)\n';
    let currentContent='# Gallery\n\nIntro with extra words typed before worker finished.\n\n![Chart](data:image/png;base64,iVBORw0KGgo=)\n';
    const notices:string[]=[];
    const applyInsert=vi.fn((text:string,point?:{from:number;to:number})=>{
      const from=point?.from??currentContent.length;
      const to=point?.to??from;
      currentContent=currentContent.slice(0,from)+text+currentContent.slice(to);
    });

    await act(async()=>{
      root?.render(
        <div>
          <MediaTools
            documentId="media-align"
            content={currentContent}
            renderedContent={renderedContent}
            documentPath={null}
            onInsert={applyInsert}
            onNotice={msg=>notices.push(msg)}
          />
          <MarkdownPreview
            markdown={renderedContent}
            sourceAnalysis={{source:renderedContent,analysis:analyzeDocument(renderedContent)}}
            documentPath={null}
            python=""
            dark={false}
          />
        </div>,
      );
    });

    const noteImage=host.querySelector<HTMLElement>('[data-note-image-source]')!;
    await act(async()=>{
      window.dispatchEvent(new CustomEvent('supermd-image-edit',{detail:{action:'remove',image:noteImage}}));
    });
    expect(notices).toEqual([]);
    expect(currentContent).toBe('# Gallery\n\nIntro with extra words typed before worker finished.\n\n\n');

    // Now test overlapping concurrent modification: must notify and NOT corrupt currentContent!
    currentContent='# Gallery\n\nImage reference rewritten concurrently!\n';
    await act(async()=>{
      root?.render(
        <div>
          <MediaTools
            documentId="media-align"
            content={currentContent}
            renderedContent={renderedContent}
            documentPath={null}
            onInsert={applyInsert}
            onNotice={msg=>notices.push(msg)}
          />
          <MarkdownPreview
            markdown={renderedContent}
            sourceAnalysis={{source:renderedContent,analysis:analyzeDocument(renderedContent)}}
            documentPath={null}
            python=""
            dark={false}
          />
        </div>,
      );
    });

    const staleImage=host.querySelector<HTMLElement>('[data-note-image-source]')!;
    await act(async()=>{
      window.dispatchEvent(new CustomEvent('supermd-image-edit',{detail:{action:'remove',image:staleImage}}));
    });
    expect(notices).toHaveLength(1);
    expect(currentContent).toBe('# Gallery\n\nImage reference rewritten concurrently!\n');
  });
});
