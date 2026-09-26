// Isolated UI coverage. Uses synthetic materials and a local fixture server; no model or user data is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),publicDir=path.join(root,'public');
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
const run=await fs.mkdtemp(path.join(root,'test-results','material-layout-'));
const records=[],requests=[],errors=[],externalRequests=[];
const workspaceEpoch=crypto.randomUUID(),bootToken=crypto.randomBytes(32).toString('hex');
const settings={provider:'none',baseUrl:'',model:'',capabilities:{structure:false,assessMaterials:false,feedback:false,chat:false}};
let failReceipt=true,browser,page;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname.startsWith('/api/')){
      let body='';for await(const chunk of req)body+=chunk;
      const input=body?JSON.parse(body):null;
      requests.push({path:url.pathname,method:req.method,body:input});
      const respond=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','X-PracticeBridge-Epoch':workspaceEpoch});res.end(JSON.stringify(data));};
      if(url.pathname==='/api/bootstrap')return respond({workspaceEpoch,bootToken});
      assert.equal(req.headers['x-practicebridge-epoch'],workspaceEpoch,'Fixture requests must use the established workspace');
      if(['POST','PATCH','PUT','DELETE'].includes(req.method))assert.equal(req.headers['x-practicebridge-token'],bootToken,'Fixture mutations must use the established connection');
      if(url.pathname==='/api/state')return respond({libraries:[],attempts:[],sessions:[],jobs:[],settings,materials:records.map(({text,draft,...record})=>({...record,textLength:text.length}))});
      if(url.pathname==='/api/materials'&&req.method==='POST'){
        if(failReceipt){failReceipt=false;return respond({error:'测试保存失败，请直接重试。'},507);}
        const now=new Date().toISOString(),material={id:crypto.randomUUID(),title:input.title||'原始材料',status:'received',createdAt:now,updatedAt:now,text:input.text||'',files:input.files.map(file=>({id:crypto.createHash('sha256').update(file.data).digest('hex'),name:file.name,size:Buffer.from(file.data,'base64').length,mime:'application/octet-stream'})),analysis:null,draft:null,error:null,libraryId:null};
        records.push(material);return respond({material});
      }
      const match=url.pathname.match(/^\/api\/materials\/([^/]+)(?:\/(assess|convert))?$/),material=match&&records.find(record=>record.id===match[1]);
      if(material){
        if(match[2]==='assess'){
          assert.deepEqual(input,{useAI:false,consent:false});
          material.status='unsupported';material.analysis={status:'unsupported',summary:'原件已保存；这个自编测试格式暂时无法整理。',detectedSections:[],missingInformation:['可读取的题目文字或文档。'],warnings:[],canCreateDraft:false};
        }
        if(match[2]==='convert')throw Error('Unsupported material must not be converted.');
        return respond({material});
      }
      return respond({error:'Fixture route unavailable.'},404);
    }
    const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),filename=path.resolve(publicDir,relative);
    if(!filename.startsWith(`${publicDir}${path.sep}`))throw Error('Invalid fixture path');
    const bytes=await fs.readFile(filename),mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(filename)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime});res.end(bytes);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try{
  browser=await chromium.launch({channel:process.env.PRACTICEBRIDGE_BROWSER_CHANNEL||'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){externalRequests.push(url.href);return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#import');await page.locator('#save-material').waitFor();
  assert.equal(await page.locator('#import-files').getAttribute('accept'),null);
  await page.locator('#import-files').setInputFiles({name:'Original source & notes.unrecognized',mimeType:'application/octet-stream',buffer:Buffer.from('An inert synthetic original file.')});
  await page.locator('#import-title').fill('待整理的文档与原件');
  await page.getByText('或者，粘贴文字材料',{exact:true}).click();
  await page.locator('#import-text').fill('自编补充文字。保存失败时，此内容应继续保留。');
  await page.screenshot({path:path.join(run,'01-receive-desktop.png'),fullPage:true});
  await page.locator('#save-material').click();await page.locator('#import-error .error').waitFor();
  assert.match(await page.locator('#selected-files').textContent(),/Original source & notes/);
  assert.equal(await page.locator('#import-title').inputValue(),'待整理的文档与原件');
  assert.equal(await page.locator('#import-text').inputValue(),'自编补充文字。保存失败时，此内容应继续保留。');
  assert.equal(requests.some(request=>/assess|convert/.test(request.path)),false);
  await page.locator('#save-material').click();await page.locator('#material-detail').waitFor();
  assert.equal(await page.locator('#process-material-ai').isDisabled(),true);
  assert.equal(records.length,1);assert.equal(records[0].status,'received');
  assert.equal(requests.filter(request=>request.path==='/api/materials').length,2);
  await page.getByText('只在本机处理',{exact:true}).click();await page.locator('#process-material-local').click();
  await page.getByText('暂时无法整理',{exact:true}).waitFor();
  assert.equal(records[0].files.length,1);assert.equal(requests.some(request=>request.path.endsWith('/convert')),false);
  await page.screenshot({path:path.join(run,'02-retained-result-desktop.png'),fullPage:true});
  await page.locator('a[data-nav=materials]').click();await page.locator('.material-card').waitFor();
  assert.equal(await page.locator('.material-card').count(),1);
  await page.locator('#materials-search').fill('missing');assert.equal(await page.locator('.material-card').count(),0);
  await page.locator('#materials-search').fill('notes');assert.equal(await page.locator('.material-card').count(),1);
  await page.locator('#material-status-filter').selectOption('unsupported');assert.equal(await page.locator('.material-card').count(),1);
  await page.screenshot({path:path.join(run,'03-material-library-desktop.png'),fullPage:true});
  await page.locator('.material-card a').first().click();await page.locator('#material-analysis').waitFor();
  assert.match(await page.locator('#material-analysis').textContent(),/自编测试格式/);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(run,'04-material-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Material detail should not overflow the narrow viewport');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  const checks=['any extension can be selected','failed receipt retains selected files and text','receipt does not trigger processing','offline local assessment keeps unsupported originals','material list filters and reopens saved assessment','narrow viewport has no horizontal overflow'];
  await fs.writeFile(path.join(run,'result.json'),JSON.stringify({ok:true,checks,errors,externalRequests},null,2));
  for(const check of checks)console.log('PASS '+check);
  console.log('RESULT_DIR '+run);
}catch(error){
  await page?.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});
  await fs.writeFile(path.join(run,'failure.json'),JSON.stringify({ok:false,error:error.message,errors,externalRequests,requests,visibleText:await page?.locator('body').innerText().catch(()=>null)},null,2));
  console.log('RESULT_DIR '+run);throw error;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
