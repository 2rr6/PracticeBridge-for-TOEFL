import crypto from 'node:crypto';
import { InputError } from './package.mjs';
import { validPreference, preferenceOptions } from '../public/assistant-preferences.mjs';

const fail=(message,status=409)=>{throw new InputError(message,status);};
const live=record=>record.confirmed===true && (record.expiresAt===null || record.expiresAt>Date.now());
const fresh=()=>({version:1,profileId:crypto.randomUUID(),revision:0,preferences:[],tombstones:{}});
export function assertMemoryShape(memory) {
  if(memory===undefined)return;
  if(!memory || memory.version!==1 || typeof memory.profileId!=='string' || !/^[a-f0-9-]{36}$/.test(memory.profileId) || !Number.isSafeInteger(memory.revision) || memory.revision<0 || !Array.isArray(memory.preferences) || memory.preferences.length>3 || !memory.tombstones || Array.isArray(memory.tombstones))fail('本地偏好记录格式无效。',400);
  const keys=new Set();
  for(const record of memory.preferences){
    if(!record || !validPreference(record.key,record.value) || keys.has(record.key) || record.profileId!==memory.profileId || record.memoryId!==`${memory.profileId}:${record.key}` || !Number.isSafeInteger(record.revision) || record.revision<1 || record.revision>memory.revision || typeof record.confirmed!=='boolean' || !(record.expiresAt===null || Number.isSafeInteger(record.expiresAt)))fail('本地偏好字段无效。',400);
    keys.add(record.key);
  }
  for(const [key,revision] of Object.entries(memory.tombstones))if(!Object.hasOwn(preferenceOptions,key)||!Number.isSafeInteger(revision)||revision<1||revision>memory.revision)fail('偏好删除记录无效。',400);
}
export function exportConfirmedPreferences(state,{includeConfirmedPreferences=false}={}) {
  if(includeConfirmedPreferences!==true)return undefined;
  const memory=state.assistantMemory;assertMemoryShape(memory);
  return {version:1,preferences:(memory?.preferences||[]).filter(live).map(({key,value})=>({key,value}))};
}
// Restore never imports authorization, profile identity, revisions or upstream IDs.
// Current tombstones survive even if the selected backup predates deletion.
export function restorePreferencePolicy(currentState,backup) {
  const current=currentState.assistantMemory||fresh();assertMemoryShape(current);
  const restored={...structuredClone(current),revision:current.revision+1,preferences:[]};
  if(backup!==undefined){
    if(!backup || backup.version!==1 || !Array.isArray(backup.preferences)||backup.preferences.length>3)fail('偏好备份格式无效。',400);
    const seen=new Set();
    for(const item of backup.preferences){
      if(!item||!validPreference(item.key,item.value)||seen.has(item.key))fail('偏好备份包含无效字段。',400);
      seen.add(item.key);
      if(current.tombstones[item.key])continue;
      restored.preferences.push({key:item.key,value:item.value,memoryId:`${current.profileId}:${item.key}`,profileId:current.profileId,revision:restored.revision,confirmed:false,expiresAt:null});
    }
  }
  assertMemoryShape(restored);return restored;
}
export async function createAssistantMemory({store,getEpoch,provider=null}) {
  if(!store.read().assistantMemory)await store.transact(state=>{state.assistantMemory??=fresh();});
  const epoch=state=>state.workspaceEpoch??getEpoch();
  const preview=()=>{const state=store.read(),m=state.assistantMemory;return {profileId:m.profileId,memoryRevision:m.revision,expectedEpoch:epoch(state),preferences:structuredClone(m.preferences),provider:'local',externalRecall:false};};
  function authorize(state,{profileId,expectedRevision,expectedEpoch}){
    const m=state.assistantMemory;
    if(profileId!==m.profileId)fail('此偏好不属于当前本地档案。',403);
    if(expectedEpoch!==epoch(state)||expectedRevision!==m.revision)fail('偏好或工作区已变化，请刷新偏好后重试。');
    return m;
  }
  const saveConfirmedPreference=async input=>store.transact(state=>{
    const m=authorize(state,input);
    if(input.confirmed!==true||!validPreference(input.key,input.value))fail('请明确确认有效的偏好选项。',400);
    m.revision++;
    const record={key:input.key,value:input.value,memoryId:`${m.profileId}:${input.key}`,profileId:m.profileId,revision:m.revision,confirmed:true,expiresAt:null};
    m.preferences=m.preferences.filter(item=>item.key!==input.key);m.preferences.push(record);
    return {profileId:m.profileId,memoryRevision:m.revision,expectedEpoch:epoch(state),preferences:m.preferences};
  });
  const deletePreference=async input=>store.transact(state=>{
    const m=authorize(state,input),record=m.preferences.find(item=>item.memoryId===input.preferenceId);
    if(!record)fail('找不到当前偏好。',404);
    m.revision++;m.tombstones[record.key]=m.revision;m.preferences=m.preferences.filter(item=>item!==record);
    return {profileId:m.profileId,memoryRevision:m.revision,expectedEpoch:epoch(state),preferences:m.preferences};
  });
  async function readAllowedPreferences(input){
    if(['exam','TEST'].includes(input.mode)&&input.phase!=='finished')return [];
    const guard={...input,expectedRevision:input.memoryRevision};
    const initial=authorize(store.read(),guard),namespace=`preferences:${initial.profileId}`;
    let candidates;
    if(provider){try{candidates=await provider.recallCandidates({namespace,query:'confirmed preferences',limit:3});}catch{candidates=[];}}
    const current=authorize(store.read(),guard);
    const allowed=current.preferences.filter(item=>live(item)&&(current.tombstones[item.key]||0)<item.revision);
    if(!provider)return allowed.map(({key,value})=>({key,value}));
    const accepted=new Set((Array.isArray(candidates)?candidates:[]).slice(0,3).filter(candidate=>candidate?.namespace===namespace&&candidate.profileId===current.profileId&&live(candidate)&&allowed.some(item=>item.memoryId===candidate.memoryId&&item.revision===candidate.revision)).map(item=>item.memoryId));
    return allowed.filter(item=>accepted.has(item.memoryId)).map(({key,value})=>({key,value}));
  }
  return {preview,saveConfirmedPreference,deletePreference,readAllowedPreferences};
}
