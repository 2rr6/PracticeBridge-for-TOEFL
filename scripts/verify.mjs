import {spawn,spawnSync} from 'node:child_process';
import {readdir,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,dirname,relative,win32,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verificationPythonEnvironment(environment=process.env){
 const inherited=Object.fromEntries(Object.entries(environment).filter(([name])=>!/^PYTHON_MANAGER_AUTOMATIC_INSTALL$|^PYLAUNCHER_(?:ALLOW_INSTALL|ALWAYS_INSTALL)$/i.test(name)));
 return {...inherited,PYTHON_MANAGER_AUTOMATIC_INSTALL:'0'};
}
export function sharedVerificationSummary(summary,{projectRoot=root}={}){
 const shared=structuredClone(summary),slash=value=>value.replaceAll('\\','/'),normalizedPath=value=>slash(/^[a-z]:/i.test(value)||value.startsWith('\\')?win32.normalize(value):posix.normalize(value)),project=normalizedPath(projectRoot).replace(/\/$/,''),windows=/^[a-z]:\//i.test(project),key=value=>windows?value.toLowerCase():value;
 const absolute=value=>win32.isAbsolute(value)||posix.isAbsolute(value)||/^[a-z]:/i.test(value);
  const displayPath=value=>{
  if(typeof value!=='string')return value;
  if(!absolute(value)){const normalized=posix.normalize(slash(value));return normalized==='..'||normalized.startsWith('../')?'<external-relative-path>':value;}
  const normalized=normalizedPath(value);if(key(normalized)===key(project))return '.';
  return key(normalized).startsWith(key(project)+'/')?normalized.slice(project.length+1):'<local-absolute-path>';
 };
 for(const result of shared.results||[]){
  if(Array.isArray(result.command)){result.executedCommandSha256=hash(JSON.stringify(result.command));result.command=result.command.map((argument,index)=>index===0?(result.name==='asr-python-unit'?'python':'node'):displayPath(argument));result.commandDisplayOnly=true;}
  if(Array.isArray(result.artifactDirectories))result.artifactDirectories=result.artifactDirectories.map(value=>value.split(/[\\/]/).includes('..')?'<external-artifact-directory>':displayPath(value));
 }
 for(const artifact of shared.artifacts||[])artifact.path=artifact.path.split(/[\\/]/).includes('..')?'<external-artifact>':displayPath(artifact.path);
 shared.pathPrivacy='Shared copy: command runners are labels, project arguments are relative, and external absolute or escaping relative locations are omitted. Exact command digests and original local reports retain the execution evidence.';
 return shared;
}
export function summarizeResults(results){
 const phases={total:results.length,passed:0,failed:0,skipped:0},checks={passed:0,failed:0,skipped:0};
 for(const result of results){
  phases[result.status]++;
  const tap=/^# pass (\d+)$/m.exec(result.output??'');
  if(tap){checks.passed+=Number(tap[1]);checks.failed+=Number(/^# fail (\d+)$/m.exec(result.output)?.[1]??0);checks.skipped+=Number(/^# skipped (\d+)$/m.exec(result.output)?.[1]??0);}
  else if(/^Ran \d+ tests? in /m.test(result.output??'')){
   for(const line of (result.output??'').split(/\r?\n/)){if(/ \.\.\. ok$/.test(line))checks.passed++;else if(/ \.\.\. (FAIL|ERROR)$/.test(line))checks.failed++;else if(/ \.\.\. skipped\b/.test(line))checks.skipped++;}
  }
  else checks.passed+=[...(result.output??'').matchAll(/^PASS .+/gm)].length;
 }
 return {ok:phases.failed===0&&phases.passed>0,phases,checks};
}
// Trust only this explicitly invoked project for this read-only command. This
// handles isolated worktrees owned by a different local test account without
// changing global Git configuration or disabling ownership checks elsewhere.
function git(args){const r=spawnSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8',windowsHide:true});if(r.status!==0)return null;return r.stdout.trim();}
async function run(){
 const args=process.argv.slice(2),profileIndex=args.indexOf('--profile'),profile=profileIndex<0?'full':args[profileIndex+1],packagedIndex=args.indexOf('--packaged'),packaged=packagedIndex<0?null:args[packagedIndex+1];
 const known=['full','pure-js','windows-smoke'];
 if(!known.includes(profile)||args.some((x,i)=>!['--profile','--packaged','--write-summary'].includes(x)&&args[i-1]!=='--profile'&&args[i-1]!=='--packaged'))throw new Error('Usage: node scripts/verify.mjs [--profile full|pure-js|windows-smoke] [--packaged dist/APP] [--write-summary]');
 if(profile==='windows-smoke'&&(!packaged||process.platform!=='win32'))throw new Error('Windows smoke requires Windows and an explicit packaged application path');
 const startedAt=new Date().toISOString(),commit=git(['rev-parse','HEAD']),statusStart=git(['status','--porcelain']),out=resolve(root,'test-results',`verification-${Date.now()}`);await mkdir(out,{recursive:true});
 const unit=(await readdir(resolve(root,'tests'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>resolve(root,'tests',n));
 const browser=['exam-workflow','exam-interactions','exam-resume','exam-followup','exam-mode-flow','exam-full-test','exam-repeat-scope','exam-timing-interruption','exam-recording','exam-audio-deadline','exam-readiness','exam-writing'].map(n=>[n,[`tests/${n}-ui.mjs`]]);
 const materialBrowser=[
  ['native-task-matrix','native-matrix-ui'],
  ['material-jobs-and-local-evidence','material-jobs-v05-ui'],
  ['candidate-review','material-candidates-ui'],['candidate-draft-conflicts','material-candidate-drafts-ui'],
  ['source-review-component','document-source-review-ui'],['credentials-settings','credentials-ui'],
  ['asr-settings-and-comparison','asr-ui'],['asr-unsaved-settings','asr-settings-dirty-ui'],
  ['ocr-settings','ocr-settings-ui'],['ocr-author-component','material-ocr-ui'],
  ['confirmed-assistant-preferences','assistant-memory-browser'],['workspace-restore-pages','workspace-epoch-ui'],
  ['recording-restore-finalize','exam-restore-ui'],
 ].map(([name,file])=>[name,[`tests/${file}.mjs`]]);
 const pythonEnvironment=verificationPythonEnvironment(),python=process.env.PRACTICEBRIDGE_PYTHON||(process.platform==='win32'?'python':'python3'),pythonProbe=profile==='windows-smoke'?null:spawnSync(python,['--version'],{cwd:root,encoding:'utf8',windowsHide:true,env:pythonEnvironment}),pythonVersion=pythonProbe?.status===0?(pythonProbe.stdout||pythonProbe.stderr).trim():null;
 const pythonPhase=['asr-python-unit',['-I','-B','tests/asr-model-preflight.py'],{executable:python,environment:pythonEnvironment,...(!pythonVersion?{skipReason:'A local Python runtime is unavailable; standard-library worker checks were not run. Set PRACTICEBRIDGE_PYTHON to an existing runtime; verification never installs it.'}:{})}];
 const ocrPhase=['real-ocr-material-chain',['tests/material-ocr-chain-ui.mjs'],{...(!process.env.PRACTICEBRIDGE_OCR_ASSETS?{skipReason:'Approved local OCR assets were not supplied. Set PRACTICEBRIDGE_OCR_ASSETS to an already approved installation; verification never downloads assets.'}:{})}];
 const historicalUiTests=['tests/ui-smoke.mjs','tests/ui-races.mjs','tests/ui-question-types.mjs'];
 const phases=profile==='windows-smoke'?[['packaged-inventory',['scripts/audit-release.mjs','--app',packaged]],['windows-electron-synthetic-audio',['tests/desktop-exam-smoke.mjs','--packaged',packaged]],['windows-electron-audio-deadline',['tests/exam-audio-deadline-ui.mjs','--packaged',packaged]]]:[['syntax',['scripts/check.mjs']],['readme-facts',['scripts/verify-readme.mjs']],['unit',['--test','--test-reporter=tap',...unit]],pythonPhase,...(profile==='full'?[...browser,['ordinary-document',['tests/worksheet-ui.mjs']],['view-lifecycle',['tests/ui-view-lifecycle.mjs']],['material-workflow',['tests/material-ui.mjs']],['material-layout',['tests/ui-material-layout.mjs']],['material-media',['tests/material-media-v05-ui.mjs']],...materialBrowser,ocrPhase,...(process.platform==='win32'?[['windows-credentials-runtime',['tests/credentials-electron.mjs']]]:[])]:[]),...(packaged?[['packaged-inventory',['scripts/audit-release.mjs','--app',packaged]]]:[])];
 const results=[];let stopped=false;
 for(const [name,command,options={}] of phases){
  if(stopped){results.push({name,status:'skipped',reason:'Earlier phase failed'});continue;}
  if(options.skipReason){results.push({name,status:'skipped',reason:options.skipReason});console.log(`SKIP ${name}: ${options.skipReason}`);continue;}
  const executable=options.executable||process.execPath;
  console.log(`VERIFY ${name}`);const phaseStart=Date.now();
  const result=await new Promise(done=>{let output='';const child=spawn(executable,command,{cwd:root,shell:false,windowsHide:true,...(options.environment?{env:options.environment}:{})});child.stdout.on('data',c=>{output+=c;process.stdout.write(c);});child.stderr.on('data',c=>{output+=c;process.stderr.write(c);});child.once('error',error=>done({exitCode:1,output:output+'\n'+error.message}));child.once('close',code=>done({exitCode:code??1,output}));});
  const log=`${name}.txt`;await writeFile(resolve(out,log),result.output);
  results.push({name,status:result.exitCode===0?'passed':'failed',exitCode:result.exitCode,startedAt:new Date(phaseStart).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-phaseStart,command:[executable,...command],log:relative(root,resolve(out,log)).replaceAll('\\','/'),logSha256:hash(result.output),output:result.output,artifactDirectories:[...result.output.matchAll(/RESULT_DIR (.+)/g)].map(m=>relative(root,m[1].trim()).replaceAll('\\','/'))});
  if(result.exitCode)stopped=true;
 }
 for(const [name,reason] of [['human-microphone','No human microphone session was performed; synthetic audio does not establish microphone or pronunciation quality.'],['real-windows-ime','Scripted composition events do not establish behavior of a real Windows input method session.'],['real-provider','No real remote provider or paid account call was performed.'],...(profile==='pure-js'?[['browser-ui','Not selected in pure-js profile'],['windows-electron','Run the separate windows-smoke profile against the final application.']]:profile==='full'?[['windows-electron','Run the separate windows-smoke profile against the final application.'],...(process.platform==='win32'?[]:[['windows-credentials-runtime','Windows native credential runtime requires Windows.']])]:[])])results.push({name,status:'skipped',reason});
 const tools={node:process.version,python:pythonVersion,platform:process.platform,arch:process.arch,git:git(['--version'])};
 for(const name of ['electron','@electron/packager','playwright']){try{tools[name]=JSON.parse(await readFile(resolve(root,'node_modules',name,'package.json'),'utf8')).version;}catch{tools[name]=null;}}
 const artifacts=[];
 if(packaged){const app=resolve(root,packaged);for(const file of ['resources/app.asar','PracticeBridge.exe']){const bytes=await readFile(resolve(app,file));artifacts.push({path:relative(root,resolve(app,file)).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});}}
 const statusEnd=git(['status','--porcelain']);
 const counts=summarizeResults(results),summary={schemaVersion:2,version:JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version,commit,dirtyAtStart:statusStart===null?null:Boolean(statusStart),dirtyAtEnd:statusEnd===null?null:Boolean(statusEnd),profile,startedAt,finishedAt:new Date().toISOString(),...counts,counting:'Node TAP cases, Python verbose unittest outcomes and standalone PASS markers; phase failures are counted independently',tools,artifacts,historicalUiTests,results:results.map(({output,...result})=>result)};
 await writeFile(resolve(out,'result.json'),JSON.stringify(summary,null,2)+'\n');
 if(args.includes('--write-summary'))await writeFile(resolve(root,'docs/verification-summary.json'),JSON.stringify(sharedVerificationSummary(summary),null,2)+'\n');
 console.log('VERIFICATION_DIR '+out);if(!summary.ok)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(error=>{console.error(error);process.exitCode=1;});
