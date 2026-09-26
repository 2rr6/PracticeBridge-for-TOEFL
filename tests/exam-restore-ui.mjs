import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';
import {appFetch} from './auth-client.mjs';

// Real MediaRecorder and a browser-provided synthetic microphone. The final
// event is deliberately delayed after physical stop across workspace restore.
const root=path.resolve('test-results/exam-restore-ui');await fs.mkdir(root,{recursive:true});const run=await fs.mkdtemp(path.join(root,'run-'));
const tone=Buffer.alloc(16044);tone.write('RIFF');tone.writeUInt32LE(tone.length-8,4);tone.write('WAVEfmt ',8);tone.writeUInt32LE(16,16);tone.writeUInt16LE(1,20);tone.writeUInt16LE(1,22);tone.writeUInt32LE(16000,24);tone.writeUInt32LE(32000,28);tone.writeUInt16LE(2,32);tone.writeUInt16LE(16,34);tone.write('data',36);tone.writeUInt32LE(16000,40);
for(let i=0;i<8000;i++)tone.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*1200),44+i*2);
const upload=(name,bytes)=>({name,data:Buffer.from(bytes).toString('base64')});
const pack={schemaVersion:1,examContractVersion:1,minReaderVersion:'0.3.0',id:'restore-microphone',version:'1',title:'Self-authored restoration test',groups:[{id:'speaking',section:'speaking',taskKind:'interview',title:'Original interview',timing:{scope:'question',durationSeconds:45,prepareSeconds:0,basis:'user',source:'Self-authored timing fixture.'},questions:[{id:'q1',type:'interview',prompt:'Describe a park you enjoy.',answer:null,audio:'tone.wav',prepareSeconds:0,ordinalInTask:1}]}],examSets:[{id:'restore-set',title:'Restore test',sections:[{id:'speaking-section',section:'speaking',title:'Speaking',modules:[{id:'module',title:'Interview',sourceNumber:null,taskIds:['speaking'],instructions:{text:'Check the synthetic microphone, then begin.',audio:null,source:'Self-authored fixture.',basis:'user',verifiedContent:true},navigation:{back:'none',review:'none',lockOnAdvance:true}}]}]}]};
let instance,browser;const errors=[];let oldUploads=0;
try{
  instance=await startServer({dataDir:path.join(run,'data')});
  const post=async(route,body)=>{const response=await appFetch(instance.url+'/api'+route,{method:'POST',headers:{'X-PracticeBridge':'1','Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
  const preview=await post('/import/preview',{files:[upload('practicebridge.json',JSON.stringify(pack)),upload('tone.wav',tone)]});assert.equal(preview.issues.filter(i=>i.severity==='error').length,0,JSON.stringify(preview.issues));
  const {library}=await post('/import/commit',{draftId:preview.draftId,pack:preview.pack,acknowledged:true});
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--mute-audio']});
  const context=await browser.newContext({permissions:['microphone'],acceptDownloads:true,viewport:{width:1180,height:820}});
  await context.addInitScript(()=>{
    const nativeGet=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),NativeRecorder=window.MediaRecorder;
    window.__restoreAudio={streams:[],recorders:[]};
    navigator.mediaDevices.getUserMedia=async options=>{const stream=await nativeGet(options);window.__restoreAudio.streams.push(stream);return stream;};
    window.MediaRecorder=class{
      static isTypeSupported(type){return NativeRecorder.isTypeSupported(type);}
      constructor(stream,options){this.native=new NativeRecorder(stream,options);this.parts=[];this.held=[];this.hold=true;this.nativeStopped=false;window.__restoreAudio.recorders.push(this);
        this.native.ondataavailable=event=>{this.parts.push(event.data);if(this.stopping&&this.hold)this.held.push(event.data);else this.ondataavailable?.(event);};
        this.native.onstop=()=>{this.nativeStopped=true;if(!this.hold)this.onstop?.(new Event('stop'));};this.native.onerror=event=>this.onerror?.(event);
      }
      get state(){return this.native.state;}get mimeType(){return this.native.mimeType;}
      start(timeslice){this.startedAt=performance.now();this.native.start(timeslice);}
      stop(){this.stoppedAt=performance.now();this.stopping=true;this.native.stop();}
      async releaseFinal(){this.hold=false;for(const data of this.held.splice(0))this.ondataavailable?.({data});if(this.nativeStopped)await this.onstop?.(new Event('stop'));}
    };
  });
  const page=await context.newPage(),restorer=await context.newPage();page.setDefaultTimeout(10000);
  for(const item of [page,restorer])item.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().endsWith('/api/recordings')&&request.method()==='POST')oldUploads++;});
  await page.goto(`${instance.url}/#exam/${library.libraryId}/restore-set/speaking-section/practice`);await page.locator('#check-microphone').click();await page.getByText('Microphone is ready.',{exact:true}).waitFor();await page.locator('#exam-next').click();
  await page.locator('.exam-recorder.recording').waitFor();await page.waitForFunction(()=>window.__restoreAudio.recorders[0].parts.length>=3);
  const backupPath=path.join(run,'self-authored-backup.zip');await fs.writeFile(backupPath,Buffer.from(await(await fetch(instance.url+'/api/backup')).arrayBuffer()));
  await restorer.goto(instance.url+'/#settings');await restorer.getByText('从个人备份恢复',{exact:true}).click();await restorer.locator('#backup-file').setInputFiles(backupPath);await restorer.locator('#restore-confirm').check();
  await restorer.locator('#backup-restore').click();await restorer.waitForURL('**/#dashboard');await restorer.getByText('今天练点什么',{exact:true}).waitFor();
  await page.locator('#workspace-recovery-notice').waitFor();
  await page.waitForFunction(()=>window.__restoreAudio.recorders[0].nativeStopped&&window.__restoreAudio.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')),{},{timeout:5000});
  assert.equal(oldUploads,0);await page.evaluate(()=>window.__restoreAudio.recorders[0].releaseFinal());
  await page.locator('#export-pending-recording').waitFor();assert.equal(await page.locator('#export-pending-recording').isEnabled(),true);
  assert.equal(await page.locator('#exam-next').isDisabled(),true);
  const time=await page.locator('#exam-time').textContent();await page.waitForTimeout(1200);assert.equal(await page.locator('#exam-time').textContent(),time,'old timer remains stopped');
  const download=page.waitForEvent('download');await page.locator('#export-pending-recording').click();const saved=await download,filename=path.join(run,saved.suggestedFilename());await saved.saveAs(filename);
  const bytes=await fs.readFile(filename);assert.equal(bytes.toString('ascii',0,4),'RIFF');const sampleRate=bytes.readUInt32LE(24),frames=bytes.readUInt32LE(40)/2;
  assert.ok(frames>0&&frames/sampleRate<=45);assert.equal(bytes.length,44+frames*2);
  const comparison=await page.evaluate(async({frames,sampleRate})=>{const recorder=window.__restoreAudio.recorders[0],decoder=new OfflineAudioContext(1,1,sampleRate),raw=await decoder.decodeAudioData(await new Blob(recorder.parts).arrayBuffer());return {rawFrames:raw.length,exportedFrames:frames,captureSeconds:(recorder.stoppedAt-recorder.startedAt)/1000};},{frames,sampleRate});
  assert.ok(frames<=comparison.rawFrames);assert.ok(Math.abs(frames/sampleRate-Math.min(comparison.rawFrames/sampleRate,comparison.captureSeconds))<.1);
  const state=JSON.parse(await fs.readFile(path.join(run,'data','state.json'),'utf8'));assert.equal(Object.keys(state.recordings).length,0);assert.equal(state.attempts.length,0);assert.equal(state.sessions.length,1);assert.equal(state.sessions[0].paused,true);assert.equal(oldUploads,0);assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>document.querySelector('.exam-shell').getBoundingClientRect().bottom<=innerHeight+1),true,'recovery banner must not push the exam shell below the non-scrolling window');
  await page.screenshot({path:path.join(run,'old-recording-export.png'),fullPage:true});await fs.writeFile(path.join(run,'result.json'),JSON.stringify({passed:true,oldUploads,frames,sampleRate,comparison,errors},null,2));console.log('PASS physical stop, delayed final event, old timer freeze and local WAV export: '+run);
}finally{await browser?.close();await instance?.close();}
