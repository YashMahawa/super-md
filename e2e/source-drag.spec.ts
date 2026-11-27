import {expect,test} from '@playwright/test';

test('rendered text drags expose the same Markdown as Copy',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(()=>window.supermdLoad?.({id:'source-drag',path:null,content:'# Drag source\n\nAlpha **bold** and [a link](https://example.test) with $x^2$.\n\nNarrow **selection**.',mode:'live',dark:false,fullscreen:false,colors:{},font:'Manrope',size:18,zoom:100}));
  await expect(page.locator('.live-document .markdown-body p')).toHaveCount(2);

  const result=await page.locator('.live-document .markdown-body').evaluate(root=>{
    const setSelection=(range:Range)=>{const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);};
    const getTextNode=(element:Element,predicate:(text:string)=>boolean)=>{
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
      while((node=walker.nextNode()))if(predicate(node.textContent||''))return node as Text;
      throw new Error('Expected text node was not rendered');
    };
    const compare=(target:Element,range:Range)=>{
      setSelection(range);
      const copied=new DataTransfer();
      const copy=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:copied});
      target.dispatchEvent(copy);
      const rect=range.getBoundingClientRect();
      const dragged=new DataTransfer();
      dragged.setData('text/html','<strong>Rendered HTML must not override the Markdown source</strong>');
      dragged.setData('text/uri-list','https://example.test/native-link');
      const drag=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dragged,clientX:rect.left+Math.min(2,Math.max(.25,rect.width/2)),clientY:rect.top+rect.height/2});
      target.dispatchEvent(drag);
      if(dragged.getData('text/plain')){if(dragged.getData('text/html')||dragged.getData('text/uri-list'))throw new Error('Rich text payload overrode the source drag');}
      return {copy:copied.getData('text/plain'),drag:dragged.getData('text/plain'),prevented:drag.defaultPrevented};
    };
    const paragraph=root.querySelector('p')!;
    let range=document.createRange();range.selectNodeContents(paragraph);
    const full=compare(paragraph,range);
    const strong=root.querySelector('strong')!;const bold=getTextNode(strong,text=>text.includes('bold'));
    range=document.createRange();range.setStart(bold,1);range.setEnd(bold,4);
    const narrow=compare(strong,range);
    const link=root.querySelector('a')!;const linked=getTextNode(link,text=>text.includes('a link'));
    range=document.createRange();range.setStart(linked,2);range.setEnd(linked,6);
    const narrowLink=compare(link,range);
    const math=root.querySelector('.katex')!;const formula=getTextNode(math.querySelector('.katex-html')!,text=>text.includes('x'));
    range=document.createRange();range.setStart(formula,0);range.setEnd(formula,1);
    const formulaSelection=compare(math,range);
    const second=root.querySelectorAll('p')[1]!;const firstText=paragraph.firstChild as Text;const secondText=second.firstChild as Text;
    range=document.createRange();range.setStart(firstText,0);range.setEnd(secondText,6);
    const crossBlocks=compare(paragraph,range);
    range=document.createRange();range.setStart(firstText,0);range.setEnd(firstText,5);setSelection(range);
    const linkText=getTextNode(link,text=>text.includes('a link')),linkRange=document.createRange();linkRange.setStart(linkText,2);linkRange.setEnd(linkText,6);
    const linkRect=linkRange.getBoundingClientRect(),nativeLinkData=new DataTransfer();nativeLinkData.setData('text/uri-list','https://example.test');nativeLinkData.setData('text/plain','https://example.test');
    const linkDrag=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:nativeLinkData,clientX:linkRect.left+linkRect.width/2,clientY:linkRect.top+linkRect.height/2});
    link.dispatchEvent(linkDrag);
    const unrelatedLink={uri:nativeLinkData.getData('text/uri-list'),plain:nativeLinkData.getData('text/plain'),prevented:linkDrag.defaultPrevented};
    window.getSelection()?.removeAllRanges();
    return {full,narrow,narrowLink,formulaSelection,crossBlocks,unrelatedLink};
  });

  expect(result.full).toEqual({copy:'Alpha **bold** and [a link](https://example.test) with $x^2$.',drag:'Alpha **bold** and [a link](https://example.test) with $x^2$.',prevented:false});
  expect(result.narrow).toEqual({copy:'**old**',drag:'**old**',prevented:false});
  expect(result.narrowLink).toEqual({copy:'[link](https://example.test)',drag:'[link](https://example.test)',prevented:false});
  expect(result.formulaSelection.copy).toBe('$x^2$');
  expect(result.formulaSelection.drag).toBe(result.formulaSelection.copy);
  expect(result.formulaSelection.prevented).toBe(false);
  expect(result.crossBlocks.drag).toBe(result.crossBlocks.copy);
  expect(result.crossBlocks.copy).toContain('**bold**');
  expect(result.crossBlocks.copy).toContain('$x^2$');
  expect(result.unrelatedLink).toEqual({uri:'https://example.test',plain:'https://example.test',prevented:false});
});

test('closed answer content stays out of ordinary copy and drag until opened while callout markers survive',async({page})=>{
  await page.addInitScript(()=>{window.SuperMD={post:()=>{}};});
  await page.goto('/android-reader.html');
  await page.waitForFunction(()=>typeof window.supermdLoad==='function');

  const content=[
    '# Study check',
    '',
    '> [!question] Evaluate $\\int_0^1 2x\\,dx$',
    '> State the antiderivative first.',
    '',
    '> [!answer] Worked **solution**',
    '> Hidden antiderivative $x^2$ gives $1$.',
    '',
    '> [!note]- Extra hint',
    '> Power rule backwards.',
    '',
    '> [!tip]+ Sanity check',
    '> Area of triangle is $\\frac{1}{2} \\cdot 1 \\cdot 2 = 1$.',
  ].join('\n');

  for(const mode of ['reader','live'] as const){
    await page.evaluate(({md,viewMode})=>window.supermdLoad?.({
      id:`callout-copy-${viewMode}`,
      path:null,
      content:md,
      mode:viewMode,
      dark:false,
      fullscreen:false,
      colors:{},
      font:'Manrope',
      size:18,
      zoom:100,
    }),{md:content,viewMode:mode});

    const answerDetails=page.locator('details.callout-answer');
    await expect(answerDetails).toHaveCount(1);
    await expect(answerDetails).not.toHaveAttribute('open','');

    const copyAndDragAll=()=>page.locator('.markdown-body').evaluate(root=>{
      const range=document.createRange();
      range.selectNodeContents(root);
      const selection=window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const target=root.querySelector('h1')!;
      const copied=new DataTransfer();
      target.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:copied}));
      const rect=target.getBoundingClientRect();
      const dragged=new DataTransfer();
      dragged.setData('text/html','<p>override</p>');
      target.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dragged,clientX:rect.left+8,clientY:rect.top+rect.height/2}));
      const selectedHook=window.supermdSelectedText?.()??'';
      selection.removeAllRanges();
      return {copy:copied.getData('text/plain'),drag:dragged.getData('text/plain'),selectedHook};
    });

    const whileClosed=await copyAndDragAll();
    expect(whileClosed.copy).not.toContain('Hidden antiderivative');
    expect(whileClosed.copy).not.toContain('Power rule backwards');
    expect(whileClosed.copy).toContain('> [!question] Evaluate $\\int_0^1 2x\\,dx$');
    expect(whileClosed.copy).toContain('> [!answer] Worked **solution**');
    expect(whileClosed.copy).toContain('> [!note]- Extra hint');
    expect(whileClosed.copy).toContain('> [!tip]+ Sanity check');
    expect(whileClosed.drag).toBe(whileClosed.copy);
    expect(whileClosed.selectedHook).toBe(whileClosed.copy);

    // Open the answer disclosure by clicking its summary
    await answerDetails.locator('summary.callout-title').click();
    await expect(answerDetails).toHaveAttribute('open','');

    const whileOpen=await copyAndDragAll();
    expect(whileOpen.copy).toContain('> [!answer] Worked **solution**\n> Hidden antiderivative $x^2$ gives $1$.');
    expect(whileOpen.copy).not.toContain('Power rule backwards');
    expect(whileOpen.drag).toBe(whileOpen.copy);
    expect(whileOpen.selectedHook).toBe(whileOpen.copy);

    // Close the answer disclosure again and verify answer body is excluded once more
    await answerDetails.locator('summary.callout-title').click();
    await expect(answerDetails).not.toHaveAttribute('open','');
    const afterReclose=await copyAndDragAll();
    expect(afterReclose.copy).not.toContain('Hidden antiderivative');
    expect(afterReclose.copy).toBe(whileClosed.copy);
  }
});
