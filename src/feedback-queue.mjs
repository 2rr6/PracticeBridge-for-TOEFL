import {InputError,canonicalJSON} from './package.mjs';

/** A renderer-free queue with a captured workspace, cancellable local wait and
 * no automatic replay when a remote result remains unknown. */
export function createFeedbackQueue({store,getBinding,request,evaluate,now=()=>new Date().toISOString()}){
  let active=null,paused=false,generation=0;
  const interrupted=()=>new InputError('工作区处理已中断；远程请求结果可能未知，请检查后手动重新分析。',409);
  function run(){
    if(paused)return Promise.resolve();if(active)return active.promise;
    const epoch=store.captureEpoch(),version=generation,controller=new AbortController(),operation={controller,promise:null};active=operation;
    const current=()=>!paused&&!controller.signal.aborted&&generation===version&&store.getWorkspaceEpoch()===epoch;
    let rejectCancelled;const cancelled=new Promise((_,reject)=>{rejectCancelled=reject;});
    controller.signal.addEventListener('abort',()=>rejectCancelled(interrupted()),{once:true});
    // Cancellation may precede the first request. Keep a rejection handler while
    // still racing that same promise for every actual request below.
    void cancelled.catch(()=>{});
    operation.promise=store.withEpoch(epoch,async()=>{
      while(current()){
        const waiting=store.read().jobs.find(job=>job.status==='queued');if(!waiting)break;
        await store.transact(state=>{const job=state.jobs.find(j=>j.id===waiting.id);if(job?.status==='queued')job.status='running';});
        if(!current())break;
        const state=store.read(),job=state.jobs.find(j=>j.id===waiting.id);if(job?.status!=='running')continue;
        const attempt=state.attempts.find(a=>a.id===job.attemptId);if(!attempt)throw new InputError('反馈作业引用的作答缺失。',500);
        try{
          if(canonicalJSON(job.modelBinding)!==canonicalJSON(getBinding()))throw new InputError('模型设置在排队期间改变；此请求未发送，请确认当前设置后手动重新分析。');
          const output=await Promise.race([Promise.resolve().then(()=>{if(!current())throw interrupted();return request({attempt:{...structuredClone(attempt),...job.request},consent:true,expectedBinding:structuredClone(job.modelBinding),signal:controller.signal});}),cancelled]);
          if(!current())break;
          const evaluation=evaluate(output,attempt,job.request);
          await store.transact(next=>{if(!current())throw interrupted();const target=next.jobs.find(j=>j.id===job.id);if(target?.status!=='running')return;next.attempts.find(a=>a.id===job.attemptId).evaluations.push(evaluation);target.status='completed';target.completedAt=now();delete target.error;});
        }catch(error){
          if(!current())break;
          await store.transact(next=>{if(!current())throw interrupted();const target=next.jobs.find(j=>j.id===job.id);if(target?.status!=='running')return;target.status='failed';target.error=String(error.message||'反馈失败，请检查设置后手动重试。').slice(0,20000);target.completedAt=now();});
        }
      }
    }).finally(()=>{if(active===operation)active=null;});
    return operation.promise;
  }
  async function pause(reason='workspace_restore'){
    paused=true;generation++;const operation=active;operation?.controller.abort();await operation?.promise.catch(()=>{});
    await store.transact(state=>{for(const job of state.jobs)if(['queued','running'].includes(job.status)){job.status='interrupted';job.error=reason==='workspace_restore'?'恢复前已停止等待反馈；远程结果可能未知，未自动重发。':'应用已停止等待反馈；请按需手动重新分析。';}});
  }
  return {run,pause,resume:()=>{paused=false;},busy:()=>Boolean(active)};
}
