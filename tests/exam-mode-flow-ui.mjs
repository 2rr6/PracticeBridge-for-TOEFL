import {appFetch} from './auth-client.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, _electron as electron } from 'playwright';
import { startServer } from '../src/server.mjs';
const root=path.resolve(import.meta.dirname,'..'),packaged=process.argv[2]==='--packaged';
const output=await fs.mkdtemp(path.join(root,'test-results','exam-mode-flow-')),dataDir=path.join(output,'data');
const report={checks:[],errors:[],externalRequests:[],packaged};
const pass=text=>{report.checks.push(text);console.log('PASS '+text);};
const source='Original mode-transition regression fixture.';
const timing=(scope,seconds=null)=>({scope,durationSeconds:seconds,prepareSeconds:null,basis:seconds===null?'unknown':'document',source});
const choice=id=>({id,type:'single_choice',prompt:'Which item belongs in the original garden?',options:[{id:'A',text:'A tree.'},{id:'B',text:'A ship.'}],answer:'A',source});
const group=(id,section,kind,questions,seconds=null)=>({id,section,taskKind:kind,title:id,passage:section==='reading'?'An original tree grows in a garden.':'',timing:timing(section==='reading'?'inherit_module':section==='writing'?'task':'question',seconds),questions});
const module=(id,ids,section)=>({id,title:id,sourceNumber:null,taskIds:ids,timing:timing(section==='reading'?'module':'none',section==='reading'?900:null),navigation:{back:section==='reading'?'module':section==='writing'?'task':'none',review:section==='reading'?'module':section==='writing'?'task':'none',lockOnAdvance:true}});
const fixture={schemaVersion:1,examContractVersion:1,minReaderVersion:'0.3.0',id:'original-mode-flow',version:'1',title:'Original full mode flow',groups:[
  group('reading-one','reading','read_daily',Array.from({length:20},(_,i)=>choice('r'+(i+1)))),
  group('reading-two','reading','read_daily',[choice('r21')]),
  group('listening','listening','listen_response',[{...choice('l1'),audio:'tone.wav'}]),
  group('sentence','writing','build_sentence',[{id:'w1',type:'sentence_order',prompt:'Describe the original tree.',options:[{id:'a',text:'The tree'},{id:'b',text:'is tall.'}],answer:['a','b'],source}],360),
  group('email','writing','write_email',[{id:'w2',type:'email',prompt:'Write an original email about a garden.',source}]),
  group('discussion','writing','academic_discussion',[{id:'w3',type:'discussion',prompt:'Discuss why gardens matter.',source}]),
  group('repeat','speaking','listen_repeat',Array.from({length:7},(_,i)=>({id:'s'+(i+1),type:'listen_repeat',prompt:'Repeat the original sentence.',answer:'The tree is tall.',audio:'tone.wav',source}))),
  group('interview','speaking','interview',[{id:'i1',type:'interview',prompt:'Describe an original garden.',audio:'tone.wav',source}]),
],examSets:[{id:'whole',title:'Original whole test',sections:[
  {id:'rd',section:'reading',title:'Reading',modules:[module('rm1',['reading-one'],'reading'),module('rm2',['reading-two'],'reading')]},
  {id:'ls',section:'listening',title:'Listening',modules:[module('lm',['listening'],'listening')]},
  {id:'wr',section:'writing',title:'Writing',modules:[module('wm',['sentence','email','discussion'],'writing')]},
  {id:'sp',section:'speaking',title:'Speaking',modules:[module('sm',['repeat','interview'],'speaking')]},
]}]};
const tone=Buffer.alloc(3244);tone.write('RIFF');tone.writeUInt32LE(tone.length-8,4);tone.write('WAVEfmt ',8);tone.writeUInt32LE(16,16);tone.writeUInt16LE(1,20);tone.writeUInt16LE(1,22);tone.writeUInt32LE(8000,24);tone.writeUInt32LE(16000,28);tone.writeUInt16LE(2,32);tone.writeUInt16LE(16,34);tone.write('data',36);tone.writeUInt32LE(tone.length-44,40);
for(let i=0;i<1600;i++)tone.writeInt16LE(Math.round(Math.sin(i/8000*2*Math.PI*440)*1000),44+i*2);
let instance,browser,app,page,origin,context,currentCase='initialization';
const api=async(route,body)=>{const response=await appFetch(origin+'/api'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
const at=(qid,phase)=>page.waitForFunction(({qid,phase})=>{const shell=document.querySelector('.exam-shell');return shell?.dataset.questionId===qid&&shell.dataset.phase===phase;},{qid,phase});
const next=()=>page.locator('#exam-next').click();
const run=id=>api('/sessions/'+id).then(value=>value.session);
const snap=async name=>{if(app){const bytes=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.showInactive();await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');return (await w.webContents.capturePage()).toPNG().toString('base64');});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(bytes,'base64'));}else await page.screenshot({path:path.join(output,name+'.png')});};
try{
  if(packaged){const executablePath=path.resolve(process.argv[3],'PracticeBridge.exe'),env={...process.env,PRACTICEBRIDGE_DATA_DIR:dataDir,PRACTICEBRIDGE_TEST_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath,env,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});context=app.context();page=await app.firstWindow();await page.locator('.hero').waitFor();origin=new URL(page.url()).origin;}
  else{instance=await startServer({dataDir});origin=instance.url;browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});context=await browser.newContext({permissions:['microphone'],viewport:{width:1180,height:850}});page=await context.newPage();}
  page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){report.externalRequests.push(url.href);return route.abort();}return route.continue();});
  const upload=(name,bytes)=>({name,data:Buffer.from(bytes).toString('base64')});
  const importPack=async pack=>{const preview=await api('/import/preview',{files:[upload('practicebridge.json',JSON.stringify(pack)),upload('tone.wav',tone)]});assert.deepEqual(preview.issues.filter(i=>i.severity==='error'),[]);return (await api('/import/commit',{draftId:preview.draftId,pack:preview.pack,acknowledged:true})).library;};
  const library=await importPack(fixture);
  const enter=async(library,mode,selection={},preset='document')=>{const session=(await api('/sessions',{sessionVersion:2,libraryId:library.libraryId,mode,preset,...selection})).session;await page.goto(`${origin}/#exam/${library.libraryId}/${session.planSnapshot.id}/all/${mode}/${session.id}`);await at(session.cursor.questionId,'instructions');return session;};
  currentCase='Reading Review Continue advances from question twenty to module two';
  const practice=await enter(library,'practice',{setId:'whole',sectionId:'rd'});await next();
  for(let i=1;i<=20;i++){await at('r'+i,'response');await next();}
  await at('r20','review');assert.equal(await page.locator('.exam-review-link').count(),20);await next();await at('r21','instructions');
  const advanced=await run(practice.id);assert.equal(advanced.cursor.moduleId,'rm2');assert.equal(advanced.moduleStates.rm1.status,'submitted');assert.equal((await api('/state')).attempts.length,20);await snap('01-next-module');
  pass('Top Continue submits the twenty-question reading module once and opens module two instead of returning to question twenty');

  currentCase='Non-speaking PRACTICE expiry leaves editable answers on the same page';
  const expiry=structuredClone(fixture);expiry.id+='-expiry';for(const g of expiry.groups)if(['email','discussion'].includes(g.id))g.timing=timing('task',1);
  const expiryLibrary=await importPack(expiry);
  for(const [groupId,qid] of [['reading-one','r1'],['listening','l1'],['sentence','w1'],['email','w2'],['discussion','w3']]){
    const saved=await enter(expiryLibrary,'practice',{groupId},{readingModuleSeconds:1,listeningQuestionSeconds:1,sentenceTaskSeconds:1});await next();await at(qid,'response');await page.waitForTimeout(1450);await at(qid,'response');assert.equal(await page.locator('#exam-time').innerText(),'00:00:00');
    if(['r1','l1'].includes(qid))await page.locator('input[name=answer][value=A]').check();else if(qid==='w1'){await page.locator('[data-token=a]').click();await page.locator('[data-token=b]').click();}else await page.locator('#answer-input').fill('An original answer written after the practice countdown.');
    let stored;for(const deadline=Date.now()+10000;;){stored=await run(saved.id);if(stored.answers[qid]?.answer?.length||Date.now()>deadline)break;await page.waitForTimeout(150);}assert.ok(stored.answers[qid]?.answer?.length);assert.equal(stored.cursor.questionId,qid);assert.equal(stored.finished,false);assert.equal(stored.answers[qid].attemptId,null);
    await page.reload();await page.locator('#exam-resume').waitFor();await page.locator('#exam-resume').click();await at(qid,'response');assert.equal(await page.locator('#exam-time').innerText(),'00:00:00');
  }
  pass('Reading, listening, sentence building, email and discussion stay at zero without advancing, accept later practice drafts, and restore those drafts');

  currentCase='All four TEST sections complete without injected Review or finish dialogs';
  const before=(await api('/state')).attempts.length,full=await enter(library,'exam',{setId:'whole'});
  await page.evaluate(()=>{window.__flowPhases=[];new MutationObserver(()=>{const phase=document.querySelector('.exam-shell')?.dataset.phase;if(phase)window.__flowPhases.push(phase);}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-phase']});});
  const modules=full.planSnapshot.sections.flatMap(s=>s.modules.map(m=>({...m,section:s.section}))),durations=[];
  for(const m of modules){
    await at(m.tasks[0].questionIds[0],'instructions');
    if(m.section==='speaking'){assert.match(await page.locator('.exam-intro table').innerText(),/00:08.*00:10.*00:12/s);await page.locator('#check-microphone').click();await page.waitForFunction(()=>document.querySelector('#microphone-status')?.textContent.includes('ready'));}
    await next();
    for(const task of m.tasks)for(const qid of task.questionIds){
      await at(qid,'response');assert.equal(await page.locator('#exam-review').count(),0);assert.equal(await page.locator('.exam-modal').count(),0);
      const current=await run(full.id),timer=current.timers[current.activeTimerId];
      if(m.section==='reading')assert.equal(timer.durationSeconds,720);
      if(task.kind==='build_sentence')assert.equal(timer.durationSeconds,410);
      if(m.section==='speaking'){
        const expected=qid==='i1'?45:[8,8,10,10,10,12,12][Number(qid.slice(1))-1];assert.equal(timer.durationSeconds,expected);durations.push({qid,seconds:timer.durationSeconds});await page.waitForTimeout(250);await page.locator('#record-toggle').click();await at(qid,'recorded');
      }else if(task.kind==='build_sentence'){await page.locator('[data-token=a]').click();await page.locator('[data-token=b]').click();}
      else if(m.section==='writing')await page.locator('#answer-input').fill('An original complete-test response.');
      else await page.locator('input[name=answer][value=A]').check();
      await next();
    }
  }
  await page.locator('.exam-completed').waitFor();assert.equal((await run(full.id)).finished,true);assert.equal((await api('/state')).attempts.length-before,33);assert.equal((await page.evaluate(()=>window.__flowPhases)).includes('review'),false);assert.equal(await page.locator('.exam-modal').count(),0);await snap('02-whole-test-complete');
  report.durations=durations;pass('A complete 33-question four-section TEST uses 12:00 and 6:50 plus all seven Repeat defaults, retains speaking saves, and reaches completion without intermediate Review pages');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.ok=true;
}catch(error){report.ok=false;report.failure={currentCase,message:error.message,stack:error.stack};process.exitCode=1;await snap('failure').catch(()=>{});console.error(report.failure);}
finally{await app?.close();await browser?.close();await instance?.close();await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log('RESULT_DIR '+output);}
