import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceConnection} from '../public/workspace-connection.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const result=(body,epoch=A,status=200)=>new Response(JSON.stringify(body),{status,headers:{'X-PracticeBridge-Epoch':epoch}});
const boot=()=>result({bootToken:'a'.repeat(64),workspaceEpoch:A});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('every read and write uses the one connection captured before the first state request',async()=>{
  const seen=[];const connection=createWorkspaceConnection({fetch:async(path,options)=>{seen.push({path,options});return path==='/api/bootstrap'?boot():result({workspaceEpoch:A});}});
  await connection.json('/api/state');await connection.json('/api/settings',{model:'local'});await connection.blob('/api/backup');
  assert.equal(seen.filter(r=>r.path==='/api/bootstrap').length,1);
  for(const request of seen.slice(1))assert.equal(request.options.headers['X-PracticeBridge-Epoch'],A);
  assert.equal(seen[2].options.headers['X-PracticeBridge-Token'],'a'.repeat(64));
});

test('bootstrap A followed by state B never renders or retags the new workspace',async()=>{
  const sent=[];const connection=createWorkspaceConnection({fetch:async(path,options)=>{sent.push({path,options});return path==='/api/bootstrap'?boot():result({workspaceEpoch:B},B);}});
  await assert.rejects(connection.json('/api/state'),/恢复|工作区/);
  await assert.rejects(connection.json('/api/materials',{text:'old draft'}),/恢复|工作区/);
  assert.equal(sent.length,2);assert.equal(connection.stale,true);
});

test('a delayed A body cannot be accepted after another response reveals B',async()=>{
  const held=deferred();let calls=0,bodyEntered=deferred();
  const connection=createWorkspaceConnection({fetch:async path=>{
    if(path==='/api/bootstrap')return boot();
    if(++calls===1)return {ok:true,status:200,headers:new Headers({'X-PracticeBridge-Epoch':A}),json:async()=>{bodyEntered.resolve();await held.promise;return {workspaceEpoch:A,old:true};}};
    return result({workspaceEpoch:B},B);
  }});
  const old=connection.json('/api/state');const refused=assert.rejects(old,/恢复|工作区/);await bodyEntered.promise;
  await assert.rejects(connection.json('/api/state'),/恢复|工作区/);held.resolve();await refused;
});

test('a restore notification received during bootstrap also blocks the old connection',async()=>{
  const held=deferred();let requests=0;
  const connection=createWorkspaceConnection({fetch:async()=>{requests++;await held.promise;return boot();}});
  const old=connection.json('/api/state');const refused=assert.rejects(old,/恢复|工作区/);
  connection.observeEpoch(B);held.resolve();await refused;assert.equal(requests,1);
});

test('a successful own restore returns once, broadcasts B, and requires an explicit new page',async()=>{
  const broadcast=[];let requests=0;
  const connection=createWorkspaceConnection({broadcast:epoch=>broadcast.push(epoch),fetch:async path=>{requests++;return path==='/api/bootstrap'?boot():result({restored:true,workspaceEpoch:B},B);}});
  assert.equal((await connection.json('/api/restore',{file:{name:'synthetic.zip'}})).restored,true);
  assert.deepEqual(broadcast,[B]);assert.equal(connection.stale,true);
  await assert.rejects(connection.json('/api/settings',{model:'old'}),/恢复|工作区/);assert.equal(requests,2);
});

for(const ownRestore of [false,true])test(`${ownRestore?'own restore':'state'} B headers invalidate a delayed A body before B JSON finishes`,async()=>{
  const heldA=deferred(),heldB=deferred(),enteredA=deferred(),announced=[];let calls=0;
  const connection=createWorkspaceConnection({broadcast:epoch=>announced.push(epoch),fetch:async path=>{
    if(path==='/api/bootstrap')return boot();
    const first=++calls===1;
    return {ok:true,status:200,headers:new Headers({'X-PracticeBridge-Epoch':first?A:B}),json:async()=>{
      if(first){enteredA.resolve();await heldA.promise;return {workspaceEpoch:A};}
      await heldB.promise;return ownRestore?{restored:true,workspaceEpoch:B}:{workspaceEpoch:B};
    }};
  }});
  const older=connection.json('/api/state');const oldResult=older.then(value=>({accepted:true,value}),error=>({accepted:false,error}));await enteredA.promise;
  const newer=connection.json(ownRestore?'/api/restore':'/api/state',ownRestore?{file:{name:'synthetic.zip'}}:undefined);
  const newResult=newer.then(value=>({accepted:true,value}),error=>({accepted:false,error}));
  try{
    await new Promise(setImmediate);heldA.resolve();assert.equal((await oldResult).accepted,false,'A cannot be adopted after B headers');
    assert.deepEqual(announced,[],'restore is not announced as complete until its receipt is valid');
    heldB.resolve();assert.equal((await newResult).accepted,ownRestore);assert.deepEqual(announced,ownRestore?[B]:[]);
  }finally{heldA.resolve();heldB.resolve();await newResult;}
});
