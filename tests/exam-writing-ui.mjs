import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';

const out=await fs.mkdtemp(path.resolve('test-results/exam-writing-ui-'));
const checks=[],errors=[];let server,browser,page;
const pass=label=>{checks.push(label);console.log('PASS '+label);};
try{
  server=await startServer({dataDir:path.join(out,'data')});
  const api=async(route,body)=>{const r=await appFetch(server.url+'/api'+route,{method:body?'POST':'GET',headers:{'X-PracticeBridge':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;};
  const zip=await fs.readFile('public/examples/getting-started.zip');
  const preview=await api('/import/preview',{files:[{name:'getting-started.zip',data:zip.toString('base64')}]});
  const {library}=await api('/import/commit',{draftId:preview.draftId,pack:preview.pack,acknowledged:true});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:988,height:762},permissions:['clipboard-read','clipboard-write']});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==server.url){errors.push('external '+url.href);return route.abort();}return route.continue();});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  async function enter(kind){const group=library.groups.find(g=>g.taskKind===kind);assert.ok(group,kind);await page.goto(server.url+`#practice/${library.libraryId}/${group.id}/practice`);await page.locator('[data-phase=instructions]').waitFor();await page.locator('#exam-next').click();await page.locator('#answer-input').waitFor();return group;}
  const email=await enter('write_email'),input=page.locator('#answer-input');
  await input.pressSequentially('Alpha beta gamma.');
  await input.evaluate(el=>el.setSelectionRange(6,10));
  await page.locator('[data-edit=cut]').click();assert.equal(await input.inputValue(),'Alpha  gamma.');
  await page.locator('[data-edit=undo]').click();assert.equal(await input.inputValue(),'Alpha beta gamma.');
  await page.locator('[data-edit=redo]').click();assert.equal(await input.inputValue(),'Alpha  gamma.');
  await input.evaluate(el=>el.setSelectionRange(6,6));
  await page.locator('[data-edit=paste]').click();assert.equal(await input.inputValue(),'Alpha beta gamma.');
  await page.locator('[data-edit=undo]').click();assert.equal(await input.inputValue(),'Alpha  gamma.');
  await page.locator('[data-edit=redo]').click();assert.equal(await input.inputValue(),'Alpha beta gamma.');
  assert.equal(await page.locator('#word-count').innerText(),'3');
  await page.locator('#toggle-word-count').click();assert.equal(await page.locator('#word-count').isVisible(),false);
  await page.locator('#toggle-word-count').click();assert.equal(await page.locator('#word-count').innerText(),'3');
  await page.locator('#exam-exit').click();await page.locator('#exam-set-rows').waitFor();
  const saved=(await api('/state')).sessions.find(s=>s.planSnapshot.sections.some(sec=>sec.modules.some(mod=>mod.tasks.some(t=>t.groupId===email.id))));
  assert.equal(saved.answers[email.questions[0].id].answer,'Alpha beta gamma.');
  pass('Cut, Paste, Undo and Redo preserve native editing history, and Hide Word Count preserves the saved response');

  await enter('academic_discussion');
  const layout=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};};return {teacher:box('.exam-professor-post'),left:box('.exam-writing-directions'),student:box('.exam-student-posts'),editor:box('.exam-editor'),right:box('.exam-writing-response'),overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(layout.teacher.x>=layout.left.x&&layout.teacher.right<=layout.left.right+1);
  assert.ok(layout.student.x>=layout.right.x&&layout.student.bottom<=layout.editor.y+1);
  assert.equal(layout.overflow,false);
  assert.equal(await page.locator('.exam-discussion-post').count(),3);
  await page.screenshot({path:path.join(out,'discussion.png')});
  pass('Professor remains in the left pane; both student responses sit above the editor in the right pane');
  assert.deepEqual(errors,[]);
}catch(error){errors.push(error.stack);console.error(error.stack);process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));console.log('RESULT_DIR '+out);await browser?.close();await server?.close();}
