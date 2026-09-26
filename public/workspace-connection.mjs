const epochPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const staleMessage='工作区已从备份恢复。当前页面的输入仍保留；请先复制或导出未保存内容，再重新载入页面。';

// A page owns one immutable connection. A response can invalidate it, never
// replace it: queued old payloads must not acquire a freshly restored epoch.
export function createWorkspaceConnection({fetch:fetcher=(...args)=>globalThis.fetch(...args),onStale=()=>{},broadcast=()=>{}}={}) {
  let pending,connection,stale=false,observedEpoch;
  const invalidate=()=>{if(!stale){stale=true;onStale(staleMessage);}};
  const usable=()=>{if(stale)throw new Error(staleMessage);};
  function observeEpoch(epoch){
    if(!epochPattern.test(epoch||''))return;
    if((connection&&epoch!==connection.workspaceEpoch)||(observedEpoch&&epoch!==observedEpoch))invalidate();
    observedEpoch=epoch;
  }
  async function connect(){
    usable();
    if(!pending)pending=(async()=>{
      const response=await fetcher('/api/bootstrap',{headers:{'X-PracticeBridge':'1'},redirect:'error',cache:'no-store'});
      if(!response.ok)throw new Error('无法初始化本机连接，请刷新页面。');
      const value=await response.json();
      if(!epochPattern.test(value.workspaceEpoch||'')||!/^[a-f0-9]{64}$/.test(value.bootToken||''))throw new Error('本机连接信息无效，请重新载入页面。');
      connection=Object.freeze({bootToken:value.bootToken,workspaceEpoch:value.workspaceEpoch});
      if((observedEpoch&&observedEpoch!==connection.workspaceEpoch)||(response.headers.get('X-PracticeBridge-Epoch')!==connection.workspaceEpoch))invalidate();
      usable();return connection;
    })();
    // A failed bootstrap also requires an explicit reload. No automatic retry
    // may reassign payloads that were already waiting on the first bootstrap.
    return pending;
  }
  async function send(path,data,method){
    const captured=await connect();usable();
    const verb=method||(data!==undefined?'POST':'GET');
    return fetcher(path,{method:verb,redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json','X-PracticeBridge':'1','X-PracticeBridge-Epoch':captured.workspaceEpoch,...(['POST','PATCH','PUT','DELETE'].includes(verb)?{'X-PracticeBridge-Token':captured.bootToken}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  }
  function check(response,body,{required=true}={}){
    const epoch=response.headers.get('X-PracticeBridge-Epoch');
    if((epoch&&epoch!==connection.workspaceEpoch)||(body?.workspaceEpoch&&body.workspaceEpoch!==connection.workspaceEpoch))invalidate();
    usable();
    if(required&&!epoch)throw new Error('本机返回的信息缺少工作区标识，请重新载入页面。');
  }
  return {
    get stale(){return stale;},observeEpoch,
    async json(path,data,method){
      const response=await send(path,data,method);
      let restoreEpoch;
      if(path==='/api/restore'&&response.ok){
        usable();
        restoreEpoch=response.headers.get('X-PracticeBridge-Epoch');
        if(!epochPattern.test(restoreEpoch||'')||restoreEpoch===connection.workspaceEpoch)throw new Error('恢复结果无法确认，请重新载入页面检查。');
        // New headers already invalidate every pending old response. Only this
        // authorized restore receipt may finish, solely to trigger a new page.
        invalidate();
      }else check(response);
      const body=await response.json().catch(()=>({error:'服务器没有返回有效结果。'}));
      if(restoreEpoch){
        if(body.restored!==true||body.workspaceEpoch!==restoreEpoch)throw new Error('恢复结果无法确认，请重新载入页面检查。');
        broadcast(restoreEpoch);return body;
      }
      check(response,body);
      if(!response.ok)throw new Error(body.error||`请求未完成 (${response.status})`);
      return body;
    },
    async blob(path){
      const response=await send(path);check(response,null,{required:path.startsWith('/api/')});
      if(!response.ok)throw new Error('导出失败，请稍后重试。');
      const blob=await response.blob();check(response,null,{required:path.startsWith('/api/')});return blob;
    },
  };
}
