import {test,expect} from '@playwright/test';

test('PDF progress allows native cancellation without publishing a partial result',async({page})=>{
  await page.addInitScript(()=>{
    let pending='';
    (window as any).__pdfEvents=[];
    window.SuperMD={post:(id,command,raw)=>{
      const args=JSON.parse(raw);(window as any).__pdfEvents.push({command,args});
      if(command==='export_pdf_native'){pending=id;return;}
      if(command==='cancel_export'){
        queueMicrotask(()=>{
          window.supermdReply?.(id,{cancelled:true},null);
          window.supermdReply?.(pending,null,'PDF export cancelled');
        });return;
      }
      queueMicrotask(()=>window.supermdReply?.(id,command==='load_python_output'?null:true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(()=>{
    window.supermdLoad?.({id:'export-note',path:'export-note',content:'# A complete PDF\n\nOriginal content remains.',mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100});
    void window.supermdExport?.({pageSize:'a4',margin:18,fontSize:10,lineHeight:1.45,fontFamily:'Manrope',pageNumbers:true});
  });
  const dialog=page.getByRole('dialog',{name:'Exporting PDF'});
  await expect(dialog).toContainText('Typesetting your document');
  await dialog.getByRole('button',{name:'Cancel export'}).click();
  await expect(dialog).toHaveCount(0);
  const events=await page.evaluate(()=>(window as any).__pdfEvents);
  const start=events.find((item:any)=>item.command==='export_pdf_native'),cancel=events.find((item:any)=>item.command==='cancel_export');
  expect(start.args.jobId).toBe(cancel.args.jobId);
  expect(events.find((item:any)=>item.command==='export_failed').args.error).toBe('PDF export cancelled');
  await expect(page.getByRole('heading',{name:'A complete PDF'})).toBeVisible();
});

test('a provider failure mentioning cancellation remains a real export error',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).__pdfError='';
    window.SuperMD={post:(id,command,raw)=>{
      if(command==='export_pdf_native'){
        queueMicrotask(()=>window.supermdReply?.(id,null,'Provider rejected destination; PDF export cancelled by provider policy'));
        return;
      }
      if(command==='export_failed') (window as any).__pdfError=JSON.parse(raw).error;
      queueMicrotask(()=>window.supermdReply?.(id,true,null));
    }};
  });
  await page.goto('/android-reader.html');await page.waitForFunction(()=>typeof window.supermdLoad==='function');
  await page.evaluate(async()=>{
    window.supermdLoad?.({id:'provider-note',path:'provider-note',content:'# Provider error',mode:'reader',dark:false,fullscreen:false,colors:{},font:'Manrope',size:16,zoom:100});
    await window.supermdExport?.({pageSize:'a4',margin:18,fontSize:10,lineHeight:1.45,fontFamily:'Manrope',pageNumbers:true});
  });
  await expect.poll(()=>page.evaluate(()=>(window as any).__pdfError)).toBe('Error: Provider rejected destination; PDF export cancelled by provider policy');
});
