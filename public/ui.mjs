import {createWorkspaceConnection} from './workspace-connection.mjs';
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  book:'M4 3h7a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H4z M14 6a3 3 0 0 1 3-3h4v16h-3a4 4 0 0 0-4 2',
  chart:'M4 3v18h17 M9 16v-5 M14 16V7 M19 16v-9',
  spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus:'M12 5v14 M5 12h14', arrow:'M5 12h14 M13 6l6 6-6 6', back:'M19 12H5 M11 6l-6 6 6 6',
  upload:'M12 16V3 M7 8l5-5 5 5 M4 16v5h16v-5', download:'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',
  file:'M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6',
  mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
  pen:'m4 16 11-11 4 4L8 20l-5 1z M13 7l4 4',
  headphones:'M4 13V9a8 8 0 0 1 16 0v4 M4 11H2v8h5v-8z M20 11h2v8h-5v-8z',
  clock:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 2',
  check:'m5 12 4 4L19 6', close:'m6 6 12 12 M6 18 18 6',
  shield:'m12 3 8 3v6c0 6-8 10-8 10S4 18 4 12V6z m-4 9 3 3 5-6',
  play:'m8 4 13 8-13 8z', refresh:'M3 11a9 9 0 0 1 15-7l3 3 M21 3v4h-4 M21 13a9 9 0 0 1-15 7l-3-3 M3 21v-4h4',
  eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search:'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  chevron:'m9 5 7 7-7 7', folder:'M3 5h7l2 3h9v12H3z',
  alert:'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
export const sectionName = s => ({reading:'阅读',listening:'听力',speaking:'口语',writing:'写作'}[s] || s);
export const sectionIcon = s => ({reading:'book',listening:'headphones',speaking:'mic',writing:'pen'}[s] || 'book');
export const typeName = t => ({single_choice:'单项选择',fill_blank:'补全单词',sentence_order:'组句',email:'邮件写作',discussion:'学术讨论',interview:'面谈',listen_repeat:'听后重复'}[t] || t);
export const date = x => x ? new Date(x).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
export const duration = seconds => `${Math.floor(Math.max(0,seconds || 0)/60).toString().padStart(2,'0')}:${Math.floor(Math.max(0,seconds || 0)%60).toString().padStart(2,'0')}`;
let toastTimer;
export function notify(text, error = false) { const e=$('#toast'); e.textContent=text; e.className=`visible ${error?'error':''}`; clearTimeout(toastTimer); toastTimer=setTimeout(()=>e.className='',6000); }
const workspaceChannel=typeof window!=='undefined'&&typeof window.BroadcastChannel==='function'?new window.BroadcastChannel('practicebridge-workspace'):null;
const connection=createWorkspaceConnection({
  broadcast:epoch=>workspaceChannel?.postMessage({workspaceEpoch:epoch}),
  onStale:message=>{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('practicebridge-workspace-stale',{detail:{message}}));},
});
if(workspaceChannel)workspaceChannel.onmessage=event=>connection.observeEpoch(event.data?.workspaceEpoch);
export const workspaceStale=()=>connection.stale;
export async function api(path, data, method) {
  return connection.json(`/api${path}`,data,method);
}
export async function fileData(file, {maxMB = /\.zip$/i.test(file.name)?80:/\.(pdf|docx)$/i.test(file.name)?64:25} = {}) {
  if(file.size>maxMB*1024*1024) throw new Error(`此类文件请控制在 ${maxMB} MB 以内。`);
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('文件读取失败'));r.readAsDataURL(file);});
  return {name:file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name,data};
}
export function saveText(name,text,type='text/plain;charset=utf-8') { saveBlob(name,new Blob([text],{type})); }
export function saveBlob(name,blob) { const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
export async function download(path,name) {saveBlob(name,await connection.blob(path));}
export function empty(title,desc,extra='') {return `<div class="empty"><span class="empty-symbol">${icon('book')}</span><h3>${esc(title)}</h3><p>${esc(desc)}</p>${extra}</div>`;}
export function busy(button,label='处理中…'){const before=button.innerHTML;button.disabled=true;button.textContent=label;return()=>{button.disabled=false;button.innerHTML=before;};}
export const consent = (settings, scope) => `<label class="consent"><input type="checkbox" name="consent"><span>允许本次发送${scope}至 <b>${esc(settings.provider==='codex'?'本机 Codex 配置的服务':settings.baseUrl || '所选模型服务')}</b>。录音原文件留在本机；使用自己的账户额度。</span></label>`;
