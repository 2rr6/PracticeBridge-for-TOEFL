import {createHash} from 'node:crypto';

const RESPONSE_LIMIT=2*1024*1024;
const fail=(message,status=400,code='invalid_request')=>Object.assign(new Error(message),{status,code});
const finiteUsage=value=>Number.isSafeInteger(value)&&value>=0;
const finishReasons=new Set(['stop','length','tool_calls','function_call','content_filter','max_output_tokens','completed','incomplete','failed','cancelled']);
const safeFinish=value=>finishReasons.has(value)?value:value===undefined||value===null?null:'other';
const usageOf=(value,official)=>{
  const input=official?value?.input_tokens:value?.prompt_tokens;
  const output=official?value?.output_tokens:value?.completion_tokens;
  return finiteUsage(input)&&finiteUsage(output)?{inputTokens:input,outputTokens:output}:null;
};
const retryDelay=response=>{
  const raw=response.headers?.get?.('retry-after');
  if(!raw)return null;
  const seconds=Number(raw),delay=Number.isFinite(seconds)?seconds*1000:Date.parse(raw)-Date.now();
  return Number.isFinite(delay)?Math.min(30000,Math.max(0,Math.ceil(delay))):null;
};

async function boundedText(response,signal){
  if(Number(response.headers?.get?.('content-length'))>RESPONSE_LIMIT){await response.body?.cancel?.().catch(()=>{});throw fail('模型响应过大，已停止读取。',502,'response_too_large');}
  if(!response.body?.getReader){const text=await response.text();signal.throwIfAborted();if(Buffer.byteLength(text)>RESPONSE_LIMIT)throw fail('模型响应过大，已停止读取。',502,'response_too_large');return text;}
  const reader=response.body.getReader(),buffers=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{while(true){signal.throwIfAborted();const {value,done}=await reader.read();signal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>RESPONSE_LIMIT){await reader.cancel();throw fail('模型响应过大，已停止读取。',502,'response_too_large');}buffers.push(Buffer.from(value));}return Buffer.concat(buffers).toString('utf8');}
  finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

/** Fixed text-only transport. Host jobs own approval, reservation and retry policy. */
export function createModelTransport({waitSettings,getConnection,assertBinding,assertRequestScope=()=>{},fetchImpl,controllers,schemaExample}){
  const prepared=new WeakMap();
  async function prepareStructured({messages,schema,expectedBinding,outputLimit}={}){
    await waitSettings();assertBinding(expectedBinding);assertRequestScope();
    const {config,binding}=getConnection();
    if(!['compatible','openai'].includes(config.provider))throw fail('这条分块作业需要具备预算元数据的 API 连接；没有切换服务。',503,'capability_unavailable');
    if(!config.model)throw fail('请先填写模型名称。');
    if(!Array.isArray(messages)||messages.length<1||messages.length>100||messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'))throw fail('模型文字输入格式无效。');
    messages=messages.map(m=>({role:m.role,content:m.content}));
    if(schema&&(!schema.schema||typeof schema.schema!=='object'||typeof schema.name!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(schema.name)))throw fail('模型输出 schema 无效。');
    const official=config.provider==='openai',mode=config.structuredOutputMode;
    if(schema&&!official&&mode==='json_object'){
      const instructions=`只返回一个符合下面 JSON Schema 的完整 JSON 对象，不要 Markdown 或额外文字。示例只展示字段形状，实际内容必须来自本次资料。\nJSON Schema:\n${JSON.stringify(schema.schema)}\nJSON 格式示例:\n${JSON.stringify(schemaExample(schema.schema))}`;
      if(messages[0].role==='system')messages[0].content+=`\n${instructions}`;else messages.unshift({role:'system',content:instructions});
    }
    const maxOutputTokens=outputLimit??config.maxOutputTokens;
    if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>config.maxOutputTokens)throw fail('单次输出预算无效。');
    const body=official?{model:config.model,input:messages,max_output_tokens:maxOutputTokens,store:false,tools:[],tool_choice:'none',...(schema?{text:{format:{type:'json_schema',name:schema.name,schema:schema.schema,strict:true}}}:{})}
      :{model:config.model,messages,max_tokens:maxOutputTokens,stream:false,tools:[],tool_choice:'none',...(schema?{response_format:mode==='json_object'?{type:'json_object'}:{type:'json_schema',json_schema:{name:schema.name,schema:schema.schema,strict:true}}}:{})};
    const wire=JSON.stringify(body),bytes=Buffer.byteLength(wire);
    if(bytes>512000)throw fail('本次模型文字输入过大，请按完整来源题组分块。',413,'input_too_large');
    const endpoint=`${config.baseUrl}/${official?'responses':'chat/completions'}`;
    const handle=Object.freeze({});
    const inputEstimate={tokens:bytes+64,method:'conservative_utf8_bytes_plus_envelope',exact:false};
    prepared.set(handle,{wire,binding:structuredClone(binding),endpoint,official,timeoutMs:config.timeoutSeconds*1000,used:false});
    return {handle,binding:structuredClone(binding),endpoint,requestDigest:createHash('sha256').update(wire).digest('hex'),inputEstimate,maxOutputTokens,responseMode:mode,requestArtifact:JSON.parse(wire)};
  }

  async function sendPrepared(handle,{consent=false,signal,deadlineAt=Infinity}={}){
    const item=handle&&prepared.get(handle);
    if(!item||item.used)throw fail('准备好的模型请求无效或已使用。',409,'prepared_request_invalid');
    item.used=true;
    let started=false,httpStatus=null,usage=null,finishReason=null;
    const base=()=>({provider:item.binding.provider,model:item.binding.model,httpStatus,finishReason,usage,usageKnown:usage!==null,requestStarted:started,outcomeUnknown:started&&usage===null});
    const local=(kind,code)=>({...base(),kind,code,outcomeUnknown:false});
    if(consent!==true)return local('not_sent','consent_required');
    try{await waitSettings();assertBinding(item.binding);}catch(error){return local('not_sent',error.code||'binding_changed');}
    try{assertRequestScope();}catch(error){return local('not_sent',error.code||'request_scope_changed');}
    if(signal?.aborted)return local('cancelled','model_cancelled');
    const remaining=deadlineAt-Date.now();
    if(remaining<=0)return local('timeout','model_timeout');
    const {secret}=getConnection();
    if(item.official&&!secret)return local('not_sent','credential_missing');
    const controller=new AbortController();controllers.add(controller);
    const abort=()=>controller.abort('caller_cancelled');signal?.addEventListener('abort',abort,{once:true});
    let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
    const onAbort=()=>rejectAbort(Object.assign(new Error('Request aborted'),{name:'AbortError'}));
    controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort('timeout'),Math.max(1,Math.min(item.timeoutMs,remaining)));
    try{
      // No await occurs between the final authority check and outbound dispatch.
      assertBinding(item.binding);assertRequestScope();controller.signal.throwIfAborted();started=true;
      const operation=(async()=>{
        const response=await fetchImpl(item.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(secret?{Authorization:`Bearer ${secret}`}:{})},body:item.wire,signal:controller.signal,redirect:'error'});
        controller.signal.throwIfAborted();httpStatus=response.status;
        if(!response.ok){try{await response.body?.cancel?.();}catch{}return {...base(),kind:'http_error',code:'provider_error',outcomeUnknown:false,retryAfterMs:retryDelay(response)};}
        let value;
        try{value=JSON.parse(await boundedText(response,controller.signal));}catch(error){if(error.code||controller.signal.aborted)throw error;return {...base(),kind:'invalid_envelope',code:'invalid_model_output'};}
        if(!value||typeof value!=='object'||Array.isArray(value))return {...base(),kind:'invalid_envelope',code:'invalid_model_output'};
        usage=usageOf(value.usage,item.official);
        let text,kind='completed';
        if(item.official){
          finishReason=safeFinish(value.incomplete_details?.reason||value.status);
          if(value.output?.some?.(part=>part?.type==='refusal'||part?.content?.some?.(p=>p?.type==='refusal')))kind='refusal';
          else if(value.output?.some?.(part=>['function_call','computer_call','web_search_call','file_search_call'].includes(part?.type)))kind='unsupported_tool_calls';
          else if(value.status==='incomplete'&&value.incomplete_details?.reason==='max_output_tokens')kind='length';
          else if(value.status&&value.status!=='completed')kind='incomplete';
          text=Array.isArray(value.output)?value.output.filter(part=>part?.type==='message').flatMap(part=>Array.isArray(part.content)?part.content:[]).filter(part=>part?.type==='output_text').map(part=>typeof part.text==='string'?part.text:'').join('\n'):undefined;
          if(!text&&typeof value.output_text==='string')text=value.output_text;
        }else{
          const choice=value.choices?.[0],message=choice?.message;finishReason=safeFinish(choice?.finish_reason);
          if(message?.refusal||choice?.finish_reason==='content_filter')kind='refusal';
          else if(message?.tool_calls?.length||message?.function_call||['tool_calls','function_call'].includes(choice?.finish_reason))kind='unsupported_tool_calls';
          else if(choice?.finish_reason==='length')kind='length';
          else if(choice?.finish_reason&&choice.finish_reason!=='stop')kind='incomplete';
          text=message?.content;
        }
        if(kind==='completed'&&(typeof text!=='string'||!text.trim()))kind='empty';
        controller.signal.throwIfAborted();assertBinding(item.binding);
        return {...base(),kind,outcomeUnknown:false,...(['completed','length','incomplete'].includes(kind)&&typeof text==='string'?{text}:{}),...(kind!=='completed'?{code:kind==='refusal'?'model_refusal':kind==='empty'?'invalid_model_output':'incomplete_model_output'}:{})};
      })();
      // Racing abort also bounds fetch implementations that ignore AbortSignal.
      // The detached operation remains observed and cannot publish state.
      return await Promise.race([operation,aborted]);
    }catch(error){
      const timed=controller.signal.reason==='timeout'||(error.name==='AbortError'&&!controller.signal.aborted);
      const kind=timed?'timeout':controller.signal.aborted?'cancelled':error.code==='response_too_large'?'response_too_large':error.code==='binding_changed'?'cancelled':'network_error';
      return {...base(),kind,code:timed?'model_timeout':kind==='cancelled'?'model_cancelled':error.code==='response_too_large'?error.code:'connection_failed'};
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);controllers.delete(controller);}
  }
  return {prepareStructured,sendPrepared};
}
