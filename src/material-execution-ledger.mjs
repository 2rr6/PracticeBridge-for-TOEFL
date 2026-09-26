import {createHash} from 'node:crypto';
import {canonicalJSON,InputError} from './package.mjs';

// A v1 job UUID identifies the original consent grant. Continue may replace its
// transport binding, but never its grant, limits, or request execution IDs.
const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9-]{1,300}$/;
const STATES=['reserved','in_flight','outcome_unknown','settled','not_sent'];
const MAX_GRANTS=10000,MAX_REQUESTS=100000;
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const equal=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const error=(code,message)=>Object.assign(new InputError(message,400),{code});
const invalid=()=>{throw error('INVALID_EXECUTION_LEDGER','请求扣账记录格式无效；工作区未被替换。');};
const conflict=()=>{throw error('EXECUTION_LEDGER_CONFLICT','同一授权或请求身份对应了不同的扣账记录；工作区未被替换。');};
function shape(value,keys){if(!plain(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();}
function count(value){if(!Number.isSafeInteger(value)||value<0)invalid();return value;}
function sum(a,b){return count(a+b);}
function validateRecord(record){
  shape(record,['requestDigest','reservation','state','usage','acknowledgedAt']);
  if(!HASH.test(record.requestDigest)||!STATES.includes(record.state))invalid();
  shape(record.reservation,['input','output']);count(record.reservation.input);count(record.reservation.output);
  if(record.usage!==null){shape(record.usage,['inputTokens','outputTokens']);count(record.usage.inputTokens);count(record.usage.outputTokens);if(['reserved','in_flight','not_sent'].includes(record.state))invalid();}
  if(record.acknowledgedAt!==null)count(record.acknowledgedAt);
}
export function validateExecutionLedger(ledger){
  if(ledger===undefined)return;
  shape(ledger,['version','grants']);if(ledger.version!==1||!plain(ledger.grants)||Object.keys(ledger.grants).length>MAX_GRANTS)invalid();
  const executions=new Map();let total=0;
  for(const [grantId,grant] of Object.entries(ledger.grants)){
    if(!ID.test(grantId))invalid();shape(grant,['identityHash','elapsedMs','requests']);if(!HASH.test(grant.identityHash)||!plain(grant.requests)||Object.keys(grant.requests).length>1000)invalid();count(grant.elapsedMs);
    for(const [requestId,record] of Object.entries(grant.requests)){
      if(!ID.test(requestId)||++total>MAX_REQUESTS)invalid();validateRecord(record);
      if(executions.has(requestId)&&executions.get(requestId)!==grantId)conflict();executions.set(requestId,grantId);
    }
  }
}
function identity(job){
  if(typeof job.jobId!=='string'||!ID.test(job.jobId)||!HASH.test(job.jobKey)||!HASH.test(job.sourceRevision)||!plain(job.budget?.limits))invalid();
  return createHash('sha256').update(canonicalJSON({grantId:job.jobId,jobKey:job.jobKey,sourceRevision:job.sourceRevision,limits:job.budget.limits})).digest('hex');
}
function recordOf(request){
  if(!plain(request)||typeof request.requestId!=='string'||!ID.test(request.requestId)||request.usageKnown!==(request.usage!==null)||request.outcomeUnknown!==(request.state==='outcome_unknown'))invalid();
  const record={requestDigest:request.requestDigest,reservation:structuredClone(request.reservation),state:request.state,usage:structuredClone(request.usage),acknowledgedAt:request.acknowledgedAt??null};validateRecord(record);return record;
}
function mergeRecord(a,b){
  if(!a)return structuredClone(b);
  if(a.requestDigest!==b.requestDigest||!equal(a.reservation,b.reservation))conflict();
  if(a.usage!==null&&b.usage!==null&&!equal(a.usage,b.usage))conflict();
  const noSend=a.state==='not_sent'||b.state==='not_sent';
  if(noSend&&(a.state==='settled'||b.state==='settled'||a.usage!==null||b.usage!==null))conflict();
  const state=noSend?'not_sent':[...STATES].slice(0,4).reverse().find(value=>a.state===value||b.state===value);
  return {requestDigest:a.requestDigest,reservation:structuredClone(a.reservation),state,usage:structuredClone(a.usage??b.usage),acknowledgedAt:a.acknowledgedAt===null?b.acknowledgedAt:b.acknowledgedAt===null?a.acknowledgedAt:Math.max(a.acknowledgedAt,b.acknowledgedAt)};
}
function mergeGrant(target,id,incoming,{keepRecordedOutcomes=false}={}){
  const current=target[id];
  if(!current){target[id]=structuredClone(incoming);return;}
  if(current.identityHash!==incoming.identityHash)conflict();current.elapsedMs=Math.max(current.elapsedMs,incoming.elapsedMs);
  for(const [requestId,record] of Object.entries(incoming.requests)){
    const recorded=current.requests[requestId],merged=mergeRecord(recorded,record);
    // A restored file is not a local transport settlement. It can contribute
    // missing execution IDs, but cannot refund or resolve an observed request.
    current.requests[requestId]=keepRecordedOutcomes&&recorded?structuredClone(recorded):merged;
  }
}
function fromJob(job){
  if(!Array.isArray(job.requests)||job.requests.length>1000)invalid();
  const grant={identityHash:identity(job),elapsedMs:count(job.budget.elapsedMs),requests:{}};
  for(const request of job.requests){const record=recordOf(request);if(Object.hasOwn(grant.requests,request.requestId))conflict();grant.requests[request.requestId]=record;}
  return grant;
}
function collect(state,{keepRecordedOutcomes=false}={}){
  validateExecutionLedger(state.materialExecutionLedger);
  const ledger=structuredClone(state.materialExecutionLedger||{version:1,grants:{}});
  if(state.materialJobs!==undefined&&!plain(state.materialJobs))invalid();
  for(const [id,job] of Object.entries(state.materialJobs||{})){if(!plain(job)||id!==job.jobId)invalid();mergeGrant(ledger.grants,id,fromJob(job),{keepRecordedOutcomes});}
  validateExecutionLedger(ledger);return ledger;
}
function effectiveGrant(job,ledger){
  const grant=fromJob(job),recorded=ledger?.grants?.[job.jobId];
  if(!recorded)return grant;
  const result={[job.jobId]:structuredClone(recorded)};mergeGrant(result,job.jobId,grant,{keepRecordedOutcomes:true});return result[job.jobId];
}
export function executionBudget(job,ledger){
  const grant=effectiveGrant(job,ledger),budget={elapsedMs:grant.elapsedMs,requestCount:0,reservedInput:0,reservedOutput:0,knownInput:0,knownOutput:0,unknownInput:0,unknownOutput:0};
  for(const request of Object.values(grant.requests)){
    if(request.state==='not_sent')continue;budget.requestCount++;
    const category=request.usage!==null?'known':['reserved','in_flight'].includes(request.state)?'reserved':'unknown';
    budget[category+'Input']=sum(budget[category+'Input'],request.usage?.inputTokens??request.reservation.input);
    budget[category+'Output']=sum(budget[category+'Output'],request.usage?.outputTokens??request.reservation.output);
  }
  budget.chargedInput=sum(sum(budget.reservedInput,budget.knownInput),budget.unknownInput);budget.chargedOutput=sum(sum(budget.reservedOutput,budget.knownOutput),budget.unknownOutput);return budget;
}
/** Same JSON writer as the learning state. Restore unions charge identities even
 * when its replacement omits the associated material/job; no CAS or credentials
 * are retained here. A failed atomic publish commits neither half. */
export function synchronizeExecutionLedger(next,{previous,restoring=false}={}){
  if(next.materialExecutionLedger===undefined&&previous?.materialExecutionLedger===undefined&&!Object.keys(next.materialJobs||{}).length&&!Object.keys(previous?.materialJobs||{}).length)return next;
  const ledger=previous?collect(previous,{keepRecordedOutcomes:true}):{version:1,grants:{}};
  for(const [id,grant] of Object.entries(collect(next,{keepRecordedOutcomes:restoring}).grants))mergeGrant(ledger.grants,id,grant,{keepRecordedOutcomes:restoring});
  if(restoring)for(const grant of Object.values(ledger.grants))for(const record of Object.values(grant.requests)){
    if(['reserved','in_flight'].includes(record.state))record.state='outcome_unknown';
    if(record.state==='outcome_unknown')record.acknowledgedAt=null;
  }
  validateExecutionLedger(ledger);next.materialExecutionLedger=ledger;
  for(const job of Object.values(next.materialJobs||{})){
    // Keep restored live rows consistent with the retained authority, so a
    // subsequent calculation or writer cannot revive their older claims.
    for(const request of job.requests){const record=ledger.grants[job.jobId].requests[request.requestId];request.state=record.state;request.usage=structuredClone(record.usage);request.usageKnown=record.usage!==null;request.outcomeUnknown=record.state==='outcome_unknown';if(record.acknowledgedAt===null)delete request.acknowledgedAt;else request.acknowledgedAt=record.acknowledgedAt;if(request.code==='request_outcome_unknown'&&!request.outcomeUnknown)request.code=null;}
    Object.assign(job.budget,executionBudget(job,ledger));
  }
  return next;
}
export function unacknowledgedExecutions(state,jobId){
  const job=state.materialJobs?.[jobId],grant=job?effectiveGrant(job,state.materialExecutionLedger):state.materialExecutionLedger?.grants?.[jobId];
  return Object.values(grant?.requests||{}).filter(record=>record.state==='outcome_unknown'&&record.acknowledgedAt===null).length;
}
export function acknowledgeExecutions(state,jobId,time){
  count(time);synchronizeExecutionLedger(state);
  for(const record of Object.values(state.materialExecutionLedger?.grants?.[jobId]?.requests||{}))if(record.state==='outcome_unknown')record.acknowledgedAt=time;
  for(const request of state.materialJobs?.[jobId]?.requests||[])if(request.outcomeUnknown)request.acknowledgedAt=time;
}
