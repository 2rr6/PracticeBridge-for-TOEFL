import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {InputError} from '../package.mjs';

const failure=(code,message)=>Object.assign(new InputError(message,409),{code});
const allowedEnvironment=new Set(['systemroot','windir','path','pathext','temp','tmp','tmpdir','lang','lc_all']);
export const scrubWorkerEnvironment=environment=>Object.fromEntries(Object.entries(environment||{}).filter(([key,value])=>allowedEnvironment.has(key.toLowerCase())&&typeof value==='string'));
const after=ms=>new Promise(resolve=>setTimeout(()=>resolve(false),ms));

async function terminate(child,graceMs){
  if(!Number.isSafeInteger(child.pid)||child.pid<=0){try{child.kill('SIGKILL');}catch{}return true;}
  if(process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}return true;}
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
  const killed=await Promise.race([new Promise(resolve=>{
    let killer;try{killer=spawn(executable,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore',env:scrubWorkerEnvironment(process.env)});}catch{resolve(false);return;}
    killer.once('error',()=>resolve(false));killer.once('close',code=>resolve(code===0));
  }),after(graceMs)]);
  if(!killed){try{child.kill('SIGKILL');}catch{}}
  return killed;
}

async function sampleMemory(child){
  if(process.platform!=='win32'||!Number.isSafeInteger(child.pid)||child.pid<=0)return null;
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise(resolve=>{
    let process;try{process=spawn(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',`try { $workerProcess = Get-Process -Id ${child.pid} -ErrorAction Stop; [Math]::Max($workerProcess.WorkingSet64, $workerProcess.PrivateMemorySize64) } catch { 0 }`],{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore'],env:scrubWorkerEnvironment(globalThis.process.env)});}catch{resolve(null);return;}
    let output='';const timer=setTimeout(()=>{try{process.kill('SIGKILL');}catch{}resolve(null);},1500);
    process.stdout.on('data',bytes=>{if(output.length<100)output+=bytes.toString();});process.once('error',()=>{clearTimeout(timer);resolve(null);});process.once('close',()=>{clearTimeout(timer);const bytes=Number(output.trim());resolve(Number.isFinite(bytes)&&bytes>=0?bytes:null);});
  });
}

/** Fixed host executables only. Tool arguments never choose a program or shell. */
export function createWorkerHost({executablePaths=[],spawnProcess=spawn,terminateProcess=terminate,sampleProcessMemory=sampleMemory,terminationGraceMs=2500}={}){
  if(!Array.isArray(executablePaths)||executablePaths.some(file=>typeof file!=='string'||!path.isAbsolute(file)))throw new TypeError('Worker executables must be absolute host paths.');
  const allowed=new Set(executablePaths.map(file=>path.resolve(file).toLowerCase()));
  const contexts=new AsyncLocalStorage(),owned=new Map();
  async function cancelRecord(record){
    if(record.closed)return true;if(record.cancelling)return record.cancelling;
    record.cancelling=(async()=>{const tree=await terminateProcess(record.child,terminationGraceMs);const closed=record.closed||await Promise.race([record.done,after(terminationGraceMs)]);if(!closed||!tree)throw failure('worker_termination_unconfirmed','本机工具终止尚未确认，工作区恢复已停止。');return true;})();return record.cancelling;
  }
  async function cancel(jobId){await Promise.all([...(owned.get(jobId)||[])].map(cancelRecord));}
  function guardedSpawn(executable,args,options={}){
    const context=contexts.getStore();if(!context||context.signal.aborted)throw failure('worker_scope_missing','本机工具没有有效作业范围。');
    if(typeof executable!=='string'||!path.isAbsolute(executable)||!allowed.has(path.resolve(executable).toLowerCase())||!Array.isArray(args)||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||options.shell===true)throw failure('worker_executable_denied','本机工具程序或参数来源无效。');
    const stat=fs.lstatSync(executable);if(!stat.isFile()||stat.isSymbolicLink())throw failure('worker_executable_denied','本机工具程序不可用。');
    if([...(owned.get(context.jobId)||[])].some(record=>!record.closed))throw failure('worker_concurrency','这项作业已有本机进程在运行。');
    const child=spawnProcess(executable,args,{...options,shell:false,windowsHide:true,detached:process.platform!=='win32',env:scrubWorkerEnvironment(options.env||{})});
    let done;const record={child,closed:false,done:new Promise(resolve=>{done=resolve;}),cancelling:null};
    const records=owned.get(context.jobId)||new Set();records.add(record);owned.set(context.jobId,records);
    let sampling=false;const sampler=setInterval(async()=>{
      if(sampling||record.closed)return;sampling=true;
      try{const bytes=await sampleProcessMemory(child);if(bytes!==null&&bytes>context.budget.maxMemoryBytes){context.abort('worker_memory_budget');await cancelRecord(record);}}catch{context.abort('worker_monitor_failure');}finally{sampling=false;}
    },750);sampler.unref?.();
    const finish=()=>{record.closed=true;clearInterval(sampler);records.delete(record);if(!records.size)owned.delete(context.jobId);done(true);};
    child.once('close',finish);child.once('error',()=>{if(!child.pid)finish();});return child;
  }
  async function run({jobId,signal,budget},work){
    if(typeof jobId!=='string'||!jobId||typeof work!=='function'||!Number.isFinite(budget?.timeoutMs)||budget.timeoutMs<=0)throw failure('worker_scope_missing','本机工具作业范围无效。');
    const controller=new AbortController(),abort=()=>controller.abort('caller_cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let reject;const interrupted=new Promise((_,fail)=>{reject=fail;});const onAbort=()=>reject(failure('worker_cancelled','本机工具已取消或达到资源预算。'));controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort('worker_timeout'),budget.timeoutMs);
    const context={jobId,signal:controller.signal,budget:{...budget,maxMemoryBytes:budget.maxMemoryBytes||1024*1024*1024},abort:reason=>controller.abort(reason)};
    try{controller.signal.throwIfAborted();return await Promise.race([contexts.run(context,work),interrupted]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);await cancel(jobId);}
  }
  return {run,spawnProcess:guardedSpawn,cancel,busy:()=>owned.size>0,capability:{networkIsolation:'not_verified',memory:'sampled_native_process_memory',gpuMemory:'not_enforced'}};
}
