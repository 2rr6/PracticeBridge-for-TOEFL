import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {authoredScanPng} from './helpers/ocr-fixture.mjs';

// Tests the real production view through a local contract harness. This is not
// a passing real T06/server/engine/compile/practice acceptance chain.
const root=path.resolve('test-results/material-ocr-ui'),output=path.join(root,crypto.randomUUID());await fs.mkdir(output,{recursive:true});
const materialId='author-material',epoch='33333333-3333-4333-8333-333333333333',sourceRevision='a'.repeat(64),evidenceRef='b'.repeat(64),image=authoredScanPng().bytes;
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><main id="root" style="max-width:1100px;margin:24px auto;padding:0 16px"></main><script type="module">
import {mountMaterialOcrReview} from '/material-ocr.mjs';
const materialId=${JSON.stringify(materialId)},epoch=${JSON.stringify(epoch)},sourceRevision=${JSON.stringify(sourceRevision)},evidenceRef=${JSON.stringify(evidenceRef)};
window.requests=[];window.failReview=false;window.deferAuthor=false;window.setRevision=1;
const makeSummary=()=>({materialId,expectedEpoch:epoch,sourceRevision,expectedSetRevision:window.setRevision,enabled:true,authorRequired:true,entries:[{evidenceRef,page:1,state:'needs_review',kind:'ocr-evidence',hasImage:true,jobId:'fixture-job',canReview:true}]});
const makeAuthor=data=>({...data,reviewToken:crypto.randomUUID(),expiresAt:Date.now()+900000,canReview:true,evidence:{kind:'ocr-evidence',state:'needs_review',text:'Raw OCR may contain an answer. <img src=x onerror=alert(1)>',words:[],issues:[],source:{page:1,width:1200,height:1000}}});
const api=async(url,data)=>{
  window.requests.push({url,data:structuredClone(data)});
  if(url.endsWith('/ocr')){if(new URLSearchParams(location.search).has('deferSummary'))return new Promise(resolve=>{window.releaseSummary=()=>resolve(makeSummary());});return makeSummary();}
  if(url.endsWith('/author/close'))return {closed:true};
  if(url.endsWith('/author')){const result=makeAuthor(data);if(window.deferAuthor)return new Promise(resolve=>{window.releaseAuthor=()=>resolve(result);});return result;}
  if(url.endsWith('/review')){if(window.failReview)throw Error('候选版本冲突');return {materialId,expectedEpoch:epoch,sourceRevision,expectedSetRevision:2,candidateId:'reviewed-candidate',candidateRevision:1,answer:null,canCompile:true};}
  if(url.endsWith('/compile'))return {receipt:{libraryId:'reviewed-library',added:1},completeness:{pending:0}};
  throw Error('Unexpected harness request');
};
window.controller=await mountMaterialOcrReview(document.querySelector('#root'),{materialId,api,refresh:async()=>{}});
</script>`;
const publicFiles=new Set(['material-ocr.mjs','ui.mjs','workspace-connection.mjs','style.css']);
const server=http.createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
    if(url.pathname.startsWith('/api/materials/author-material/ocr/image/')){res.setHeader('Content-Type','image/png');res.end(image);return;}
    const name=url.pathname.slice(1);if(publicFiles.has(name)){res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(path.resolve('public',name)));return;}
    res.statusCode=404;res.end('Not found');
  }catch{res.statusCode=500;res.end('Harness error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
const address='http://127.0.0.1:'+server.address().port,errors=[],checks=[];
const openPage=async()=>{const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(address);await page.waitForFunction(()=>Boolean(window.controller));return page;};
const authorOpen=async page=>{await page.locator('[data-ocr-author]').check();await page.locator('[data-open-ocr]').click();await page.locator('[data-ocr-author-panel]').waitFor();};
try{
  browser=await chromium.launch({channel:process.env.PRACTICEBRIDGE_BROWSER_CHANNEL||'msedge',headless:true});
  const page=await openPage();
  assert.equal(await page.locator('[data-ocr-raw],img').count(),0);assert.equal(await page.locator('[data-open-ocr]').isDisabled(),true);assert.equal(await page.evaluate(()=>window.requests.some(r=>r.url.endsWith('/author'))),false);checks.push('summary does not request or render raw OCR or image');
  await authorOpen(page);assert.equal(await page.locator('img').count(),1,'raw OCR markup must be escaped');assert.equal(await page.locator('[name=prompt]').inputValue(),'');assert.equal(await page.locator('[name=sourceQuestionNumber]').inputValue(),'');assert.equal(await page.locator('[name=originalOrdinalInTask]').inputValue(),'');assert.equal(await page.locator('[data-option-id]').first().inputValue(),'');assert.equal(await page.locator('[data-save-ocr]').isDisabled(),true);checks.push('explicit author reveal with blank manual fields and no inferred ordinal or answer');
  await page.locator('[name=instructions]').fill('Read the notice and choose one answer.');await page.locator('[name=passage]').fill('The red door is NOT open. The blue door is open.');await page.locator('[name=prompt]').fill('Which door is NOT open?');
  for(const [index,id,text] of [[0,'A','The red door.'],[1,'B','The blue door.']]){await page.locator('[data-option-id]').nth(index).fill(id);await page.locator('[data-option-text]').nth(index).fill(text);}
  const fields=['completeQuestion','completeDependencies','readable','answerSafe','fieldsConfirmed','criticalDifferencesResolved'];
  for(const [index,field] of fields.entries()){await page.locator('[name='+field+']').check();assert.equal(await page.locator('[data-save-ocr]').isDisabled(),index<5);}
  await page.locator('[name=instructions]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'manual-fields-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('[name=instructions]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'manual-fields-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks.push('six independent confirmations and mobile width');
  await page.evaluate(()=>{window.failReview=true;});await page.locator('[data-save-ocr]').click();await page.getByText('候选版本冲突 未保存输入仍保留。',{exact:true}).waitFor();assert.equal(await page.locator('[name=prompt]').inputValue(),'Which door is NOT open?');assert.equal(await page.locator('[name=criticalDifferencesResolved]').isChecked(),true);checks.push('failed save retains manual draft and its original version');
  await page.evaluate(()=>{window.failReview=false;});await page.locator('[data-save-ocr]').click();await page.locator('[data-compile-ocr]').waitFor();
  const submitted=await page.evaluate(()=>window.requests.filter(r=>r.url.endsWith('/review')).at(-1).data);assert.equal(submitted.proposal.sourceQuestionNumber,null);assert.equal(submitted.proposal.originalOrdinalInTask,null);assert.equal(Object.hasOwn(submitted.proposal,'answer'),false);assert.ok(fields.every(k=>submitted.review[k]===true));assert.equal(submitted.expectedEpoch,epoch);assert.equal(submitted.expectedSetRevision,1);
  await page.locator('[data-compile-ocr]').click();await page.getByRole('link',{name:'打开练习',exact:true}).waitFor();const compile=await page.evaluate(()=>window.requests.find(r=>r.url.endsWith('/compile')).data);assert.deepEqual(compile.selectedIds,['reviewed-candidate']);assert.deepEqual(compile.candidateRevisions,{'reviewed-candidate':1});assert.equal(compile.expectedEpoch,epoch);checks.push('manual reviewed candidate invokes existing guarded subset compile API');

  const delayed=await openPage();let imageRequests=0;delayed.on('request',request=>{if(request.url().includes('/ocr/image/'))imageRequests++;});
  await delayed.evaluate(()=>{window.deferAuthor=true;});await delayed.locator('[data-ocr-author]').check();await delayed.locator('[data-open-ocr]').click();await delayed.waitForFunction(()=>typeof window.releaseAuthor==='function');await delayed.locator('[data-ocr-author]').uncheck();await delayed.evaluate(()=>window.releaseAuthor());await delayed.waitForFunction(()=>window.requests.some(r=>r.url.endsWith('/author/close')));assert.equal(await delayed.locator('[data-ocr-raw],img').count(),0);assert.equal(imageRequests,0);checks.push('late author response is discarded and token revoked after hiding author view');

  const stale=await openPage();await authorOpen(stale);await stale.locator('[name=prompt]').fill('Unsaved original-version draft');await stale.evaluate(()=>{window.setRevision=2;});await stale.locator('[data-refresh-ocr]').click();await stale.getByText('候选或来源已有变化。输入保留原版本；请关闭本页并重新打开后再次核对。',{exact:true}).waitFor();assert.equal(await stale.locator('[name=prompt]').inputValue(),'Unsaved original-version draft');assert.equal(await stale.locator('[data-save-ocr]').isDisabled(),true);checks.push('summary refresh does not overwrite a draft or change its captured revision');
  await stale.evaluate(()=>window.dispatchEvent(new Event('practicebridge-workspace-stale')));assert.equal(await stale.locator('[data-ocr-raw],img').count(),0);assert.equal(await stale.locator('[data-ocr-author]').isChecked(),false);checks.push('workspace change immediately hides raw evidence and invalidates the view');

  const initial=await browser.newPage({viewport:{width:390,height:844}});initial.on('pageerror',e=>errors.push(e.message));await initial.goto(address+'/?deferSummary=1');await initial.locator('[data-ocr-author]').check();await initial.waitForFunction(()=>typeof window.releaseSummary==='function');await initial.evaluate(()=>window.releaseSummary());await initial.waitForFunction(()=>Boolean(window.controller));assert.equal(await initial.locator('[data-refresh-ocr]').isDisabled(),false);assert.equal(await initial.locator('[data-open-ocr]').isDisabled(),false);checks.push('author toggle during metadata load cannot strand the view in loading state');
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({status:'passed',scope:'Production view through local API contract harness; full real server/engine/practice chain remains root acceptance.',checks,pageErrors:errors},null,2)+'\n');console.log(JSON.stringify({passed:true,output,checks:checks.length}));console.log('PASS OCR author component through scoped API contract harness');console.log('RESULT_DIR '+output);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
