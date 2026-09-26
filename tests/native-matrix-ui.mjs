// Run: node tests/native-matrix-ui.mjs
// Real server, material/candidate/compiler routes and current exam shell. The
// only media substitutes are fixture tones and Edge's synthetic microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';
import {appFetch} from './auth-client.mjs';
import {saveAndProcessLocal} from './material-ui-helpers.mjs';
import {createNativeMatrixFixture,NATIVE_MATRIX_TASKS} from './helpers/native-matrix-fixture.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputRoot=path.join(project,'test-results','native-matrix-ui');await fs.mkdir(outputRoot,{recursive:true});
const output=await fs.mkdtemp(path.join(outputRoot,'run-')),dataDir=path.join(output,'data'),fixture=createNativeMatrixFixture();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=args=>{try{return execFileSync('git',args,{cwd:project,encoding:'utf8',windowsHide:true}).trim();}catch{return 'unavailable';}};
const report={ok:false,startedAt:new Date().toISOString(),sourceCommit:git(['rev-parse','HEAD']),sourceStatusBefore:git(['status','--short']),checks:[],matrix:[],pageErrors:[],httpErrors:[],externalRequests:[],modelRequests:[],screenshots:[],limits:{...fixture.limits,microphone:'Edge synthetic capture device; not a real microphone acceptance test',stimulus:'Generated local 0.8-second WAV tone; not speech or ASR quality evidence',ime:'No composition event simulation or real Windows IME claim',deadline:'Existing deadline, recording-cap and IME regressions remain separate gates'},inputFiles:[...fixture.files].map(([name,bytes])=>({name,size:bytes.length,sha256:sha(bytes)}))};
const pass=message=>{report.checks.push(message);console.log('PASS '+message);};
let instance,browser,context,page,currentCase='empty workspace';
const poll=async(work,predicate,label,timeout=12000)=>{const until=Date.now()+timeout;let value;do{value=await work();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,40));}while(Date.now()<until);throw new Error(label+': '+JSON.stringify(value));};
const screenshot=async(name,{fullPage=true}={})=>{const filename=path.join(output,name);await page.screenshot({path:filename,fullPage});const bytes=await fs.readFile(filename);report.screenshots.push({name,sha256:sha(bytes),size:bytes.length});return name;};
try{
  assert.equal(await fs.stat(dataDir).then(()=>true,()=>false),false,'The server starts with a nonexistent disposable data directory');
  instance=await startServer({dataDir});
  const api=async(route,body,{method=body===undefined?'GET':'POST',status=200}={})=>{const response=await appFetch(instance.url+'/api'+route,{method,headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,status,route+': '+JSON.stringify(result));return result;};
  const state=()=>api('/state'),session=id=>api('/sessions/'+id).then(result=>result.session);
  browser=await chromium.launch({channel:process.env.PRACTICEBRIDGE_BROWSER_CHANNEL||'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});
  context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['microphone','clipboard-read','clipboard-write'],serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==instance.url){report.externalRequests.push(url.href);return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.pageErrors.push(error.message));
  page.on('response',response=>{if(response.status()>=400&&response.url().includes('/api/'))report.httpErrors.push({status:response.status(),url:response.url()});});
  page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(request.method()==='POST'&&(/\/api\/(?:chat(?:\/|$)|settings\/test$)/.test(pathname)||/\/feedback$/.test(pathname)))report.modelRequests.push(pathname);});
  await page.goto(instance.url);await page.locator('.hero').waitFor();
  const initial=await state();assert.equal(initial.libraries.length,0);assert.equal(initial.attempts.length,0);assert.equal(initial.materials.length,0);assert.equal(initial.settings.provider,'none');assert.equal(Boolean(initial.settings.capabilities?.chat),false);
  report.emptyState={libraries:0,attempts:0,materials:0,provider:initial.settings.provider};await screenshot('00-empty-library.png');pass('An empty disposable workspace has no library, material, attempt or configured AI provider');

  currentCase='actual upload and local candidate processing';
  await page.goto(instance.url+'/#import');await page.locator('#import-files').setInputFiles([...fixture.files].map(([name,buffer])=>({name,buffer,mimeType:name.endsWith('.json')?'application/json':'audio/wav'})));
  await saveAndProcessLocal(page);
  const received=await state();assert.equal(received.materials.length,1);const materialId=received.materials[0].id;
  const candidates=await api(`/materials/${materialId}/candidates?author=1`);
  assert.equal(candidates.candidates.length,13);assert.equal(candidates.candidates.filter(candidate=>candidate.readiness.canAnswer).length,12);
  const pending=candidates.candidates.find(candidate=>candidate.sourceQuestionId===fixture.pendingQuestionId);assert.ok(pending);assert.equal(pending.readiness.canAnswer,false);assert.ok(pending.blockingIssues.some(issue=>['missing_audio','missing_media'].includes(issue.code)));
  const noKey=candidates.candidates.find(candidate=>candidate.sourceQuestionId===fixture.noKeyQuestionId);assert.equal(noKey.readiness.canAnswer,true);assert.equal(noKey.readiness.canScore,false);assert.equal(noKey.fields.answer,null);
  assert.equal(await page.locator('[data-candidate]').count(),13);assert.equal(await page.locator('[data-candidate-select]:disabled').count(),1);assert.equal(await page.locator('textarea[name=answer]').count(),0);
  await screenshot('01-candidate-review.png');report.candidateReview={materialId,total:13,answerable:12,pending:{candidateId:pending.candidateId,questionId:fixture.pendingQuestionId,issues:pending.blockingIssues},unscoredCandidateId:noKey.candidateId};
  pass('Visible upload and local processing produce 12 answerable candidates, one missing-audio pending candidate and a playable question without a key');

  currentCase='strict compilation through candidate review';
  await page.locator('#select-answerable').click();await page.locator('#compile-candidates').click();await page.locator('#candidate-result .success').waitFor();
  let published=await state();assert.equal(published.libraries.length,1);const library=published.libraries[0],originalLibraryHash=library.contentHash;
  assert.equal(library.groups.flatMap(group=>group.questions).length,12);assert.deepEqual([...new Set(library.groups.map(group=>group.taskKind))].sort(),NATIVE_MATRIX_TASKS.map(row=>row.taskKind).sort());
  assert.equal(library.groups.some(group=>group.questions.some(question=>question.id===fixture.pendingQuestionId)),false);
  for(const row of fixture.rows){const group=library.groups.find(group=>group.id===row.groupId),question=group?.questions.find(question=>question.id===row.questionId);assert.ok(question,row.taskKind+' retains original question identity');assert.equal(question.type,row.answerType);assert.deepEqual(question.sourcePositionV1,row.sourcePosition);}
  const compiledWords=library.groups.find(group=>group.taskKind==='complete_words'),anchor=compiledWords.inlineBlanks.anchors[0];assert.equal(compiledWords.inlineBlanks.offsetUnit,'utf16');assert.equal(sha(compiledWords.passage),compiledWords.inlineBlanks.textHash);assert.equal(compiledWords.passage.slice(anchor.prefixStart,anchor.prefixEnd),'stud');assert.equal(compiledWords.passage.slice(anchor.start,anchor.end),'____');assert.ok(compiledWords.passage.indexOf('🌿')<anchor.prefixStart);
  await page.locator('#compile-candidates').click();await page.locator('#candidate-result .success').waitFor();assert.equal((await state()).libraries.length,1);await screenshot('02-compiled-subset.png');
  report.compilation={libraryId:library.libraryId,contentHash:originalLibraryHash,questions:12,pendingExcluded:true,wordAnchor:anchor,wordOffsetUnit:'utf16'};pass('The candidate review compiles all 12 task kinds with their original positions and UTF-16 word-gap anchors while retaining the pending source');

  const at=(row,phase)=>page.locator(`.exam-shell[data-task-kind="${row.taskKind}"][data-question-id="${row.questionId}"][data-phase="${phase}"]`).waitFor();
  const saved=(id,row,value)=>poll(()=>session(id),run=>JSON.stringify(run.answers[row.questionId]?.answer)===JSON.stringify(value),'The control answer did not persist for '+row.taskKind);
  const assertTestIsolation=async row=>{assert.equal(await page.locator('#exam-ai,#exam-answers,#exam-transcript,#exam-review,.exam-help-panel').count(),0);const text=await page.locator('#main').innerText();assert.equal(text.includes(row.reviewOnlyText),false);if(row.taskKind==='listen_repeat')assert.equal(text.includes(row.expectedAnswer),false);assert.equal(await page.locator('#request-feedback').count(),0);};
  for(const [index,row] of fixture.rows.entries()){
    currentCase='exam shell: '+row.taskKind;
    const run=(await api('/sessions',{sessionVersion:2,libraryId:library.libraryId,groupId:row.groupId,mode:'exam',preset:'document'})).session;
    await page.goto(`${instance.url}/#exam/${library.libraryId}/${run.planSnapshot.id}/all/exam/${run.id}`);await at(row,'instructions');
    const rowResult={taskKind:row.taskKind,answerType:row.answerType,groupId:row.groupId,questionId:row.questionId,sessionId:run.id,mode:'exam',phases:['instructions'],sourcePosition:row.sourcePosition,controlActions:[],testIsolation:true};
    assert.equal(run.planSnapshot.sections.flatMap(section=>section.modules).flatMap(module=>module.tasks).length,1);
    if(row.section==='speaking'){await page.locator('#check-microphone').click();await page.waitForFunction(()=>document.querySelector('#microphone-status')?.textContent==='Microphone is ready.');rowResult.microphone='Edge synthetic device checked through the production microphone control';}
    await page.locator('#exam-next').click();
    if(['listening','speaking'].includes(row.section)){
      await at(row,'stimulus');await page.waitForFunction(()=>{const audio=document.querySelector('#prompt-audio');return audio&&audio.currentTime>0.03&&Number.isFinite(audio.duration);});
      rowResult.stimulus=await page.locator('#prompt-audio').evaluate(audio=>({currentTime:audio.currentTime,duration:audio.duration,readyState:audio.readyState,paused:audio.paused,error:audio.error?.message||null}));
      assert.ok(rowResult.stimulus.currentTime>0);assert.ok(Math.abs(rowResult.stimulus.duration-fixture.media.durationSeconds)<0.02);assert.equal(rowResult.stimulus.error,null);rowResult.phases.push('stimulus');
    }
    await at(row,'response');rowResult.phases.push('response');await assertTestIsolation(row);
    if(row.answerType==='fill_blank'){
      const cell=index=>page.locator(`[data-qid="${row.questionId}"][data-letter-index="${index}"]`),values=()=>page.locator(`[data-qid="${row.questionId}"][data-letter-index]`).evaluateAll(elements=>elements.map(element=>element.value));
      assert.equal(await page.locator('.exam-word').count(),1);assert.equal(await page.locator('.exam-letter').count(),4);await cell(0).focus();await page.keyboard.type('en');await page.keyboard.press('ArrowLeft');assert.equal(await cell(1).evaluate(element=>element===document.activeElement),true);await page.keyboard.press('Home');assert.equal(await cell(0).evaluate(element=>element===document.activeElement),true);await page.keyboard.press('End');assert.equal(await cell(3).evaluate(element=>element===document.activeElement),true);await page.keyboard.press('Backspace');assert.equal(await cell(2).evaluate(element=>element===document.activeElement),true);await page.keyboard.type('ts');assert.deepEqual(await values(),['e','n','t','s']);rowResult.controlActions.push('Four native letter cells; keyboard typing, ArrowLeft, Home, End and Backspace focus');
    }else if(row.answerType==='single_choice'){
      const a=page.locator('input[name=answer][value=A]'),b=page.locator('input[name=answer][value=B]');assert.equal(await page.locator('input[name=answer]').count(),2);await a.focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowDown');assert.equal(await b.isChecked(),true);await page.keyboard.press('ArrowUp');assert.equal(await a.isChecked(),true);rowResult.controlActions.push('Native radio selection with Space and arrow keys');
    }else if(row.answerType==='sentence_order'){
      assert.equal(await page.locator('[data-slot]').count(),3);for(const id of fixture.responses[row.taskKind]){await page.locator(`[data-token="${id}"]`).focus();await page.keyboard.press(id==='B'?'Space':'Enter');}assert.equal(await page.locator('[data-slot].filled').count(),3);assert.deepEqual((await page.locator('[data-slot]').allTextContents()).map(text=>text.trim()),['can','read','write']);rowResult.controlActions.push('Three sentence slots filled from original word IDs with Enter/Space');
    }else if(['email','discussion'].includes(row.answerType)){
      const input=page.locator('#answer-input');await input.focus();await input.pressSequentially('Temporary draft');await page.keyboard.press('Control+A');await page.keyboard.type(fixture.responses[row.taskKind]);assert.equal(await input.inputValue(),fixture.responses[row.taskKind]);await page.locator('#toggle-word-count').click();assert.equal(await page.locator('#word-count').isVisible(),false);await page.locator('#toggle-word-count').click();assert.ok(Number(await page.locator('#word-count').innerText())>20);assert.equal(await input.evaluate(element=>element.spellcheck),false);rowResult.controlActions.push('Native textarea, replacement typing and word-count toggle');
      if(row.answerType==='email')assert.match(await page.locator('.exam-email-head').innerText(),/Mira[\s\S]*Map for the club walk/);else assert.equal(await page.locator('.exam-discussion-post').count(),3);
    }else{
      await page.locator('.exam-recorder.recording').waitFor();assert.equal(await page.locator('#exam-next').isDisabled(),true);await page.waitForTimeout(400);rowResult.controlActions.push('Production recorder auto-started after real tone ended; Edge synthetic microphone only');
    }
    if(row.section!=='speaking')await saved(run.id,row,fixture.responses[row.taskKind]);
    await assertTestIsolation(row);const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}));assert.ok(geometry.scrollWidth<=geometry.width+1,JSON.stringify(geometry));rowResult.viewport=geometry;
    rowResult.screenshot=await screenshot(`${String(index+3).padStart(2,'0')}-${row.taskKind}.png`);
    if(row.taskKind==='academic_discussion'){await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);rowResult.narrowScreenshot=await screenshot('discussion-narrow.png');await page.setViewportSize({width:1440,height:1000});}
    if(row.section==='speaking'){
      await page.locator('#record-toggle').click();await at(row,'recorded');rowResult.phases.push('recorded');const recorded=await session(run.id),entry=recorded.answers[row.questionId];assert.ok(entry.recordingId);const response=await appFetch(instance.url+entry.recordingUrl),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);assert.ok(bytes.length>128);assert.equal(bytes.toString('ascii',0,4),'RIFF');rowResult.recording={id:entry.recordingId,size:bytes.length,sha256:sha(bytes),synthetic:true};rowResult.controlActions.push('Stop Recording saved an actual WAV through the recording API');
    }
    await page.locator('#exam-next').click();await page.locator('.exam-completed').waitFor();const finalRun=await session(run.id);assert.equal(finalRun.finished,true);
    const after=await state(),attempt=after.attempts.find(attempt=>attempt.runContext?.sessionId===run.id&&attempt.questionId===row.questionId);assert.ok(attempt,row.taskKind+' produced a submitted attempt');assert.equal(attempt.assisted,false);assert.equal(attempt.mode,'exam');assert.equal(attempt.questionSnapshot.type,row.answerType);
    if(row.section==='speaking')assert.ok(attempt.recordingId);else assert.deepEqual(attempt.answer,fixture.responses[row.taskKind]);
    if(row.questionId===fixture.noKeyQuestionId||['email','discussion','listen_repeat','interview'].includes(row.answerType))assert.deepEqual(attempt.objective,{status:'unscored',correct:null,total:null});else assert.equal(attempt.objective.status,'correct');
    rowResult.attempt={id:attempt.id,objective:attempt.objective,assisted:attempt.assisted,recordingId:attempt.recordingId||null};rowResult.phases.push('completed');rowResult.ok=true;report.matrix.push(rowResult);pass(`${row.taskKind} / ${row.answerType}: actual TEST control, source identity, saved answer and hidden reference checks`);
  }
  currentCase='final matrix and source preservation';
  published=await state();assert.equal(published.attempts.length,12);assert.equal(published.libraries.length,1);assert.equal(published.libraries[0].contentHash,originalLibraryHash);assert.equal(published.jobs.length,0);assert.equal(published.settings.provider,'none');assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.modelRequests,[]);assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.httpErrors,[]);
  assert.equal(new Set(report.matrix.map(row=>row.taskKind)).size,12);assert.equal(new Set(report.matrix.map(row=>row.answerType)).size,7);
  const finalCandidates=await api(`/materials/${materialId}/candidates?author=1`);assert.equal(finalCandidates.candidates.find(candidate=>candidate.sourceQuestionId===fixture.pendingQuestionId).readiness.canAnswer,false);
  assert.deepEqual(published.materials[0].files.map(file=>file.id).sort(),report.inputFiles.map(file=>file.sha256).sort());
  report.totals={taskKinds:12,answerTypes:7,attempts:12,recordings:report.matrix.filter(row=>row.recording).length,pending:1,modelCalls:0};report.ok=true;pass('All 12 task kinds and seven answer types save through the current exam shell; originals, library and pending candidate remain intact');await screenshot('15-matrix-complete.png');
}catch(error){report.failure={currentCase,message:error.message,stack:error.stack};console.error('FAIL '+currentCase+'\n'+error.stack);process.exitCode=1;await screenshot('failure.png').catch(()=>{});}
finally{
  await context?.close();await browser?.close();await instance?.close();
  report.finishedAt=new Date().toISOString();report.sourceStatusAfter=git(['status','--short']);report.testFiles=[];for(const name of ['tests/native-matrix-ui.mjs','tests/helpers/native-matrix-fixture.mjs'])report.testFiles.push({name,sha256:sha(await fs.readFile(path.join(project,name)))});
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n');console.log('RESULT_DIR '+output);
}
