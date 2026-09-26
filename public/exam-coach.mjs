import { esc } from './ui.mjs';
import { preferenceOptions,preferenceLabels,describePreference } from './assistant-preferences.mjs';

const stores = new Map();
export function createExamCoach({ sessionId, epoch, api, settings, current, capture }) {
  const key=`exam-coach:${epoch}:${sessionId}`;
  let store=stores.get(key);
  if(!store){
    let saved;try{saved=JSON.parse(sessionStorage.getItem(key));}catch{}
    store={turns:Array.isArray(saved?.turns)?saved.turns.slice(-40):[],drafts:saved?.drafts||{},rooms:saved?.rooms||{},pending:new Set(),listeners:new Set()};stores.set(key,store);
  }
  const host=document.createElement('aside');host.className='exam-coach';host.id='exam-coach';
  host.innerHTML=`<button id="exam-coach-pill" class="exam-coach-pill" aria-expanded="false" aria-controls="exam-coach-panel">✦ AI 对话</button><section id="exam-coach-panel" class="exam-coach-panel" aria-label="当前题 AI 对话" hidden><header class="exam-coach-head"><strong>AI 学习助手</strong><button id="exam-coach-collapse" aria-label="折叠 AI 对话">—</button></header><div class="exam-coach-context" id="exam-coach-context"></div><label class="exam-coach-history">查看对话 <select id="exam-coach-history" aria-label="查看哪一页的对话"></select></label><div class="exam-coach-log" id="exam-coach-log" role="log" aria-live="polite"></div><form id="exam-coach-form"><textarea id="exam-coach-input" aria-label="向 AI 提问" placeholder="问问当前题目，或讨论你的回答…" maxlength="12000" rows="3"></textarea><div class="exam-coach-sendrow"><small id="exam-coach-sendhint"></small><button id="exam-coach-send" type="submit">发送</button></div></form></section>`;
  document.body.append(host);
  const $=selector=>host.querySelector(selector), panel=$('#exam-coach-panel'), input=$('#exam-coach-input'), log=$('#exam-coach-log');
  const preferencePanel=document.createElement('div');preferencePanel.className='coach-preferences';
  preferencePanel.innerHTML=`<label><input type="checkbox" id="coach-preference-include" disabled> 本次发送带入已确认偏好</label><small id="coach-preference-preview">本次不带入偏好。</small><details><summary id="coach-preference-settings">确认与管理本地偏好</summary><p>只保存下面的固定选项。选择后点击“确认保存”才生效；不会从聊天自动记忆。</p><div id="coach-preference-fields"></div><p id="coach-preference-status" role="status"></p><button type="button" id="coach-preference-refresh">刷新偏好</button></details>`;
  $('#exam-coach-context').after(preferencePanel);
  let preferenceState=null,preferenceLoading=false,includePreferences=false;
  function renderPreferencePreview(){
    const confirmed=(preferenceState?.preferences||[]).filter(item=>item.confirmed&&(!item.expiresAt||item.expiresAt>Date.now()));
    $('#coach-preference-preview').textContent=includePreferences?(confirmed.length?`发送预览：${confirmed.map(describePreference).join('；')}`:'没有可带入的已确认偏好。'):'本次不带入偏好。';
    $('#coach-preference-include').disabled=!preferenceState;
  }
  function renderPreferenceFields(){
    $('#coach-preference-fields').innerHTML=Object.entries(preferenceOptions).map(([name,options])=>{
      const saved=preferenceState?.preferences.find(item=>item.key===name);
      return `<div class="coach-preference-field"><label>${esc(preferenceLabels[name])}<select data-preference-key="${name}"><option value="">请选择</option>${Object.entries(options).map(([value,label])=>`<option value="${esc(value)}" ${saved?.value===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label><small>${saved?(saved.confirmed?'已确认':'恢复的选项，需重新确认'):'尚未保存'}</small><div><button type="button" data-preference-save="${name}">确认保存</button><button type="button" data-preference-delete="${name}" ${saved?'':'disabled'}>删除</button></div></div>`;
    }).join('');
    for(const button of host.querySelectorAll('[data-preference-save],[data-preference-delete]'))button.onclick=async()=>{
      if(preferenceLoading||!preferenceState)return;
      const deleting=Boolean(button.dataset.preferenceDelete),name=button.dataset.preferenceDelete||button.dataset.preferenceSave;
      const captured={profileId:preferenceState.profileId,expectedRevision:preferenceState.memoryRevision,expectedEpoch:preferenceState.expectedEpoch};
      const payload=deleting?{...captured,preferenceId:preferenceState.preferences.find(item=>item.key===name)?.memoryId}:{...captured,key:name,value:$(`[data-preference-key="${name}"]`).value,confirmed:true};
      preferenceLoading=true;button.disabled=true;
      try{preferenceState=await api(deleting?'/assistant/preferences/delete':'/assistant/preferences',payload);if(disposed)return;renderPreferenceFields();renderPreferencePreview();$('#coach-preference-status').textContent=deleting?'已删除；旧备份不会自动恢复这项偏好。':'已确认保存。';}
      catch(error){if(!disposed)$('#coach-preference-status').textContent=error.message;}
      finally{preferenceLoading=false;if(button.isConnected)button.disabled=false;}
    };
  }
  async function loadPreferences(){
    if(preferenceLoading)return;preferenceLoading=true;
    try{const loaded=await api('/assistant/preferences');if(disposed)return;preferenceState=loaded;renderPreferenceFields();renderPreferencePreview();}
    catch(error){if(!disposed)$('#coach-preference-status').textContent=error.message;}
    finally{preferenceLoading=false;}
  }
  $('#coach-preference-refresh').onclick=loadPreferences;
  $('#coach-preference-include').onchange=event=>{includePreferences=event.target.checked;renderPreferencePreview();};
  let open=false,disposed=false,selected=null,lastScope=null,previousFocus=null;
  const save=()=>{try{sessionStorage.setItem(key,JSON.stringify({turns:store.turns.slice(-40),drafts:store.drafts,rooms:store.rooms}));}catch{}};
  const emit=()=>{save();for(const fn of store.listeners)fn();};
  function update() {
    if(disposed)return;
    const context=current();host.hidden=!context.allowed;
    const changed=context.key!==lastScope;
    if(changed){if(lastScope)store.drafts[lastScope]=input.value;lastScope=context.key;if(selected===null)input.value=store.drafts[context.key]||'';}
    const visibleKey=selected||context.key;
    const rooms=new Map([[context.key,context.label]]);
    for(const turn of store.turns)rooms.set(turn.scope,turn.label);
    $('#exam-coach-context').textContent=`发送时自动附带：${context.label} · 当前页文字与草稿`;
    const select=$('#exam-coach-history');select.innerHTML=[...rooms].map(([id,label])=>`<option value="${esc(id)}" ${id===visibleKey?'selected':''}>${esc(label)}${id===context.key?'（当前页）':''}</option>`).join('');
    const turns=store.turns.filter(turn=>turn.scope===visibleKey),nearEnd=log.scrollHeight-log.scrollTop-log.clientHeight<40, oldTop=log.scrollTop;
    log.innerHTML=turns.length?turns.map(turn=>`<article class="exam-coach-turn" data-turn-id="${esc(turn.id)}"><p class="exam-coach-user">${esc(turn.message)}</p><p class="exam-coach-reply ${turn.error?'error':''}">${esc(turn.reply||turn.error||(store.pending.has(turn.scope)?'正在思考…':'这次请求已中断。可重新发送。'))}</p></article>`).join(''):'<p class="exam-coach-empty">可以直接提问。展开窗口不会发送内容，也不会暂停倒计时。</p>';
    if(changed&&!selected)log.scrollTop=log.scrollHeight;else if(nearEnd)log.scrollTop=log.scrollHeight;else log.scrollTop=oldTop;
    const oldPage=visibleKey!==context.key, available=Boolean(settings?.capabilities?.chat);
    input.disabled=oldPage||!available;$('#exam-coach-send').disabled=oldPage||!available||store.pending.has(context.key);
    $('#exam-coach-sendhint').textContent=oldPage?'正在查看之前的对话；选择当前页可继续提问。':available?`发送到已配置的 ${settings.model||'AI'}；不发送音频或图片。`:'请先在“模型与数据”中连接 AI。';
  }
  function toggle(force) {
    open=typeof force==='boolean'?force:!open;panel.hidden=!open;$('#exam-coach-pill').hidden=open;$('#exam-coach-pill').setAttribute('aria-expanded',String(open));
    if(open){previousFocus=document.activeElement;update();input.focus();if(!preferenceState)void loadPreferences();}
    else if(previousFocus?.isConnected&&previousFocus.closest('.exam-shell')&&document.activeElement?.closest('#exam-coach'))previousFocus.focus();
  }
  $('#exam-coach-pill').onclick=()=>toggle(true);$('#exam-coach-collapse').onclick=()=>toggle(false);
  $('#exam-coach-history').onchange=event=>{store.drafts[current().key]=input.value;selected=event.target.value===current().key?null:event.target.value;if(!selected)input.value=store.drafts[current().key]||'';update();};
  input.oninput=()=>{store.drafts[current().key]=input.value;save();};
  input.onkeydown=event=>{event.stopPropagation();if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){$('#exam-coach-form').requestSubmit();event.preventDefault();}};
  $('#exam-coach-form').onsubmit=async event=>{
    event.preventDefault();const context=current(),message=input.value.trim();
    const expectedBinding=structuredClone(settings?.binding);
    if(!message||selected||!context.allowed||!settings?.capabilities?.chat||store.pending.has(context.key))return;
    const memorySnapshot=preferenceState?{include:includePreferences,profileId:preferenceState.profileId,memoryRevision:preferenceState.memoryRevision,expectedEpoch:preferenceState.expectedEpoch}:undefined;
    const roomKey=`${context.key}:${JSON.stringify(memorySnapshot||null)}`;
    const turn={id:crypto.randomUUID(),scope:context.key,label:context.label,message,reply:null,error:null};
    store.turns.push(turn);store.turns=store.turns.slice(-40);store.pending.add(context.key);store.drafts[context.key]='';input.value='';emit();
    try{
      const ref=await capture(context.key);
      const reply=await api('/chat',{consent:true,message,context:ref,requestId:turn.id,conversationId:store.rooms[roomKey]||undefined,memory:memorySnapshot,expectedBinding});
      turn.reply=reply.reply;turn.snapshotId=reply.contextSnapshotId;turn.memorySnapshot=reply.memorySnapshot;store.rooms[roomKey]=reply.conversationId;
    }catch(error){turn.error=error.message;store.drafts[context.key]=store.drafts[context.key]||message;}
    finally{store.pending.delete(context.key);emit();}
  };
  // Keep dragging independent from the task DOM and keyboard handlers.
  const header=$('.exam-coach-head');let drag=null;
  header.onpointerdown=event=>{if(event.target.closest('button'))return;const rect=host.getBoundingClientRect();drag={x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};header.setPointerCapture(event.pointerId);};
  header.onpointermove=event=>{if(!drag)return;host.style.left=`${Math.max(0,Math.min(innerWidth-host.offsetWidth,drag.left+event.clientX-drag.x))}px`;host.style.top=`${Math.max(0,Math.min(innerHeight-host.offsetHeight,drag.top+event.clientY-drag.y))}px`;host.style.right='auto';host.style.bottom='auto';};
  header.onpointerup=()=>{drag=null;};
  const clamp=()=>{if(!host.style.left)return;const rect=host.getBoundingClientRect();host.style.left=`${Math.max(0,Math.min(innerWidth-rect.width,rect.left))}px`;host.style.top=`${Math.max(0,Math.min(innerHeight-rect.height,rect.top))}px`;};
  window.addEventListener('resize',clamp);store.listeners.add(update);update();
  return {toggle,update,destroy(){store.drafts[current().key]=input.value;save();disposed=true;store.listeners.delete(update);host.remove();window.removeEventListener('resize',clamp);}};
}
