import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createWorkerHost} from '../src/workers/host.mjs';

test('worker host denies program selection outside its fixed paths and scrubs credentials',async()=>{
  let options;const host=createWorkerHost({executablePaths:[process.execPath],spawnProcess:(file,args,opts)=>{options=opts;const child=new EventEmitter();child.pid=123;queueMicrotask(()=>child.emit('close',0));return child;},sampleProcessMemory:async()=>0,terminateProcess:async()=>true});
  assert.throws(()=>host.spawnProcess(process.execPath,[]));
  await host.run({jobId:'job',budget:{timeoutMs:1000}},async()=>{
    assert.throws(()=>host.spawnProcess('powershell.exe',['arbitrary script']));
    await new Promise(resolve=>{const child=host.spawnProcess(process.execPath,['--version'],{shell:false,env:{API_KEY:'private',PATH:'host-path'}});child.once('close',resolve);});
  });assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.env.API_KEY,undefined);assert.equal(host.busy(),false);
});

test('cancellation awaits owned-process close and surfaces unconfirmed termination within a bound',async()=>{
  let child,kills=0;const host=createWorkerHost({executablePaths:[process.execPath],spawnProcess:()=>{child=new EventEmitter();child.pid=123;return child;},terminateProcess:async c=>{kills++;setTimeout(()=>c.emit('close',null),10);return true;},sampleProcessMemory:async()=>0,terminationGraceMs:50});
  const controller=new AbortController();const work=host.run({jobId:'job',signal:controller.signal,budget:{timeoutMs:1000}},()=>{host.spawnProcess(process.execPath,['--version']);return new Promise(()=>{});});
  controller.abort();await assert.rejects(work,/取消|资源/);assert.equal(kills,1);assert.equal(host.busy(),false);
  const unconfirmed=createWorkerHost({executablePaths:[process.execPath],spawnProcess:()=>{const c=new EventEmitter();c.pid=1;return c;},terminateProcess:async()=>false,sampleProcessMemory:async()=>0,terminationGraceMs:20});
  const timed=unconfirmed.run({jobId:'stuck',budget:{timeoutMs:10}},()=>{unconfirmed.spawnProcess(process.execPath,[]);return new Promise(()=>{});});
  await assert.rejects(timed,error=>error.code==='worker_termination_unconfirmed');
});

test('actual fixed Node child is terminated before cancellation returns',async()=>{
  const host=createWorkerHost({executablePaths:[process.execPath],terminationGraceMs:2500});let child;
  const controller=new AbortController();
  const work=host.run({jobId:'self-authored-real-process',signal:controller.signal,budget:{timeoutMs:10000,maxMemoryBytes:512*1024*1024}},()=>{child=host.spawnProcess(process.execPath,['-e','console.log("ready");setInterval(() => {}, 1000)'],{stdio:['ignore','pipe','pipe'],env:process.env});return new Promise(()=>{});});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('close',code=>reject(new Error(`Child exited before ready: ${code}`)));});controller.abort();await assert.rejects(work,/取消|资源/);assert.equal(host.busy(),false);assert.throws(()=>process.kill(child.pid,0));
});
