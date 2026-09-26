import {$,$$,esc} from './ui.mjs';

const confirmations=[
  ['completeQuestion','我已核对完整题干、所有选项和本题边界。'],
  ['completeDependencies','我已保留完整说明及本题依赖的全部共享材料。'],
  ['readable','我已放大检查原图，文字可读且没有遗漏。'],
  ['answerSafe','我已确认提供给练习者的来源内容不泄露答案或答案解析。'],
  ['fieldsConfirmed','我已逐项确认下方人工填写或修正的字段。'],
  ['criticalDifferencesResolved','我已核对否定词、数字及其他关键差异。'],
];
const states={needs_review:'已识别，待人工校对',empty:'未读到文字',text_layer:'使用可靠文字层',rendered:'已保存选区原图',unavailable:'本页识别暂不可用',failed:'本页未完成'};
const blank=()=>({title:'',instructions:'',passage:'',prompt:'',options:[{id:'',text:''},{id:'',text:''}],sourceQuestionNumber:'',originalOrdinalInTask:'',review:Object.fromEntries(confirmations.map(([key])=>[key,false]))});

/** Isolated production view. Host mounts it after the material/job controls and
 * calls destroy() when navigating away. No OCR result is auto-parsed into fields. */
export async function mountMaterialOcrReview(container,{api,materialId,refresh=async()=>{},isCurrent=()=>true}={}){
  if(!container||typeof api!=='function'||typeof materialId!=='string')throw TypeError('Material OCR view requires its material and API.');
  const base=`/materials/${encodeURIComponent(materialId)}/ocr`,drafts=new Map();
  let view=null,author=false,opened=null,saved=null,compiled=null,error='',loading=false,saving=false,compiling=false,disposed=false,imageOriginalSize=false,version=0,loadVersion=0;
  const alive=()=>!disposed&&container.isConnected&&isCurrent();
  const same=serial=>alive()&&serial===version;
  const draftKey=value=>`${value.expectedEpoch}:${value.sourceRevision}:${value.evidenceRef}`;
  const draft=()=>opened?drafts.get(draftKey(opened)):null;
  const closeRemote=token=>token?api(`${base}/author/close`,{reviewToken:token}).catch(()=>{}):Promise.resolve();
  const context=value=>Object.fromEntries(['materialId','expectedEpoch','sourceRevision','expectedSetRevision'].map(key=>[key,value[key]]));
  const stale=()=>opened&&view&&['expectedEpoch','sourceRevision','expectedSetRevision'].some(key=>opened[key]!==view[key]);

  function readDraft(form){
    const value=draft();if(!value)return;
    for(const field of ['title','instructions','passage','prompt','sourceQuestionNumber','originalOrdinalInTask'])value[field]=form.elements.namedItem(field).value;
    value.options=$$('[data-ocr-option]',form).map(row=>({id:$('[data-option-id]',row).value,text:$('[data-option-text]',row).value}));
    for(const [key] of confirmations)value.review[key]=form.elements.namedItem(key).checked;
  }
  function complete(value){
    return value&&['instructions','passage','prompt'].every(key=>value[key].trim())&&value.options.length>=2&&value.options.length<=10&&value.options.every(option=>option.id.trim()&&option.id.trim().length<=10&&option.text.trim())&&new Set(value.options.map(option=>option.id.trim())).size===value.options.length&&confirmations.every(([key])=>value.review[key]===true)&&(!value.originalOrdinalInTask.trim()||/^\d+$/.test(value.originalOrdinalInTask.trim())&&Number(value.originalOrdinalInTask)>=1&&Number(value.originalOrdinalInTask)<=1000);
  }
  function formHtml(){
    const value=draft(),evidence=opened.evidence,source=evidence.source;
    return `<section class="card mt" data-ocr-author-panel><h3>原件第 ${esc(source.page)} 页：人工校对</h3><p class="notice warn">原图和原始识别文字可能含答案。只有你完成下方确认后，才会建立可导入的候选；本模块不会填写答案。</p><button type="button" class="button tiny" data-ocr-zoom aria-pressed="${imageOriginalSize}">${imageOriginalSize?'缩小以适应页面':'按原始大小查看，可滚动'}</button><div class="material-ocr-image-frame${imageOriginalSize?' is-original-size':''}" data-ocr-image-frame><img data-ocr-image class="material-ocr-image" alt="所选材料的 OCR 选区原图" src="/api${base}/image/${encodeURIComponent(opened.reviewToken)}"></div><details class="details mt"><summary>查看原始识别文字和疑点</summary><pre data-ocr-raw class="material-ocr-raw">${esc(evidence.text??evidence.textLayer??'')}</pre><p class="hint">已保留 ${Array.isArray(evidence.words)?evidence.words.length:0} 个词框；需要对照原图确认。</p>${(evidence.issues||[]).map(issue=>`<p class="notice warn">${esc(issue.reason)}</p>`).join('')}</details>${stale()?'<p class="notice warn">候选或来源已有变化。输入保留原版本；请关闭本页并重新打开后再次核对。</p>':''}${opened.canReview?`<form data-ocr-form><p class="hint">请手动填写完整字段。下列输入不会按识别结果自动猜测题界、题号或正确答案。</p><label class="field"><span>练习标题（可空）</span><input type="text" name="title" maxlength="300" value="${esc(value.title)}"></label><label class="field"><span>完整作答说明</span><textarea name="instructions" rows="3" maxlength="20000" required>${esc(value.instructions)}</textarea></label><label class="field"><span>完整共享文章或通知</span><textarea name="passage" rows="6" maxlength="100000" required>${esc(value.passage)}</textarea></label><label class="field"><span>完整题干</span><textarea name="prompt" rows="3" maxlength="100000" required>${esc(value.prompt)}</textarea></label><fieldset><legend>全部选项（至少两项，最多十项）</legend>${value.options.map((option,index)=>`<div class="button-row mt" data-ocr-option><label class="field"><span>选项标识</span><input type="text" data-option-id aria-label="第 ${index+1} 行选项标识" maxlength="10" value="${esc(option.id)}" required></label><label class="field material-ocr-option-text"><span>完整选项文字</span><textarea data-option-text aria-label="第 ${index+1} 行选项文字" maxlength="20000" required>${esc(option.text)}</textarea></label><button type="button" class="button tiny" data-remove-option="${index}" ${value.options.length<=2?'disabled':''}>移除此行</button></div>`).join('')}<button type="button" class="button tiny mt" data-add-option ${value.options.length>=10?'disabled':''}>添加选项</button></fieldset><label class="field"><span>原题号（不清楚就留空）</span><input type="text" name="sourceQuestionNumber" maxlength="100" value="${esc(value.sourceQuestionNumber)}"></label><label class="field"><span>原题组内序号（不清楚就留空）</span><input type="text" name="originalOrdinalInTask" inputmode="numeric" value="${esc(value.originalOrdinalInTask)}"></label><fieldset><legend>逐项完成来源确认</legend>${confirmations.map(([key,label])=>`<label class="consent"><input type="checkbox" name="${key}" ${value.review[key]?'checked':''}>${label}</label>`).join('')}</fieldset><button type="submit" class="button primary mt" data-save-ocr ${saving||stale()||!complete(value)?'disabled':''}>${saving?'正在保存校对…':'保存为不计分练习候选'}</button></form>`:'<p class="hint">此页可查看原图，当前还没有可恢复为题目的 OCR 文字。</p>'}<button type="button" class="button mt" data-close-ocr>关闭本页校对</button></section>`;
  }
  function render(){
    if(!alive())return;
    container.innerHTML=`<section class="card"><h2>扫描页与原图校对</h2><p class="hint">先选择材料处理得到的页面，再核对完整题干、说明和共享材料。</p><p class="hint">${view?.enabled?'本机英语 OCR 已启用。':'本机 OCR 尚未启用；已保存的页面证据仍保留。'}</p><label class="consent"><input data-ocr-author type="checkbox" ${author?'checked':''}>打开作者校对视图（原图和识别文字可能含答案）</label><button type="button" class="button tiny" data-refresh-ocr ${loading?'disabled':''}>${loading?'正在刷新…':'刷新页面证据'}</button><div data-ocr-status role="status" aria-live="polite">${esc(error)}</div>${view?.entries.length?`<div class="mt">${view.entries.map(row=>`<article class="question-preview"><h3>原件第 ${esc(row.page)} 页</h3><p>${esc(states[row.state]||'页面证据已保留')}</p><button type="button" class="button tiny" data-open-ocr="${esc(row.evidenceRef)}" ${!author||!row.hasImage||loading||saving?'disabled':''}>${row.canReview?'打开原图并人工校对':'查看已保存的选区原图'}</button></article>`).join('')}</div>`:'<p class="hint mt">尚无当前材料成功作业保存的 OCR 页面证据。完成本地处理后可刷新。</p>'}</section>${author&&opened?formHtml():''}${saved&&author?`<section class="card mt"><p class="notice success">校对已保存。答案与未知原序号保持空值，可加入不计分练习。</p><button type="button" class="button primary" data-compile-ocr ${compiling||compiled?'disabled':''}>${compiling?'正在加入练习…':compiled?'已加入练习':'加入练习'}</button><a class="button" href="#import/${encodeURIComponent(materialId)}/candidates">查看全部候选</a>${compiled?.receipt?.libraryId?`<a class="button primary" href="#collection/${encodeURIComponent(compiled.receipt.libraryId)}">打开练习</a>`:''}</section>`:''}`;
    $('[data-ocr-author]',container).onchange=async event=>{
      author=event.target.checked;version++;error='';
      if(!author){const token=opened?.reviewToken;opened=null;saved=null;compiled=null;render();await closeRemote(token);}else render();
    };
    $('[data-refresh-ocr]',container).onclick=()=>reload();
    $$('[data-open-ocr]',container).forEach(button=>button.onclick=()=>openPage(button.dataset.openOcr));
    const zoom=$('[data-ocr-zoom]',container);if(zoom)zoom.onclick=()=>{imageOriginalSize=!imageOriginalSize;$('[data-ocr-image-frame]',container).classList.toggle('is-original-size',imageOriginalSize);zoom.setAttribute('aria-pressed',String(imageOriginalSize));zoom.textContent=imageOriginalSize?'缩小以适应页面':'按原始大小查看，可滚动';};
    const form=$('[data-ocr-form]',container);
    if(form){
      form.oninput=()=>{readDraft(form);$('[data-save-ocr]',form).disabled=saving||stale()||!complete(draft());};
      form.onsubmit=save;
      $('[data-add-option]',form).onclick=()=>{readDraft(form);if(draft().options.length<10)draft().options.push({id:'',text:''});render();};
      $$('[data-remove-option]',form).forEach(button=>button.onclick=()=>{readDraft(form);if(draft().options.length>2)draft().options.splice(Number(button.dataset.removeOption),1);render();});
      if(saving)$$('input,textarea,button',form).forEach(element=>element.disabled=true);
    }
    const close=$('[data-close-ocr]',container);if(close)close.onclick=async()=>{const token=opened?.reviewToken;version++;opened=null;error='';render();await closeRemote(token);};
    const compile=$('[data-compile-ocr]',container);if(compile)compile.onclick=compileSaved;
  }
  async function reload(){
    const serial=++loadVersion;loading=true;error='';render();
    try{const result=await api(base);if(alive()&&serial===loadVersion){view=result;error='';}}
    catch(failure){if(alive()&&serial===loadVersion)error=failure.message;}
    finally{if(alive()&&serial===loadVersion){loading=false;render();}}
  }
  async function openPage(evidenceRef){
    if(!author||!view||saving)return;
    const serial=++version,previous=opened?.reviewToken;opened=null;saved=null;compiled=null;error='正在打开已授权的页面证据…';render();await closeRemote(previous);
    if(!same(serial)||!author)return;
    try{
      const result=await api(`${base}/author`,{...context(view),evidenceRef,author:true});
      if(!same(serial)||!author){await closeRemote(result.reviewToken);return;}
      opened=result;imageOriginalSize=false;const key=draftKey(result),previousDraft=drafts.get(key)||blank();
      previousDraft.review=Object.fromEntries(confirmations.map(([field])=>[field,false]));drafts.set(key,previousDraft);error='';render();
    }catch(failure){if(same(serial)){error=failure.message;render();}}
  }
  async function save(event){
    event.preventDefault();const form=event.currentTarget;readDraft(form);
    if(!opened||!author||saving||stale()||!complete(draft()))return;
    const serial=version,value=structuredClone(draft()),baseContext=context(opened),reviewToken=opened.reviewToken;
    const proposal={title:value.title.trim(),instructions:value.instructions,prompt:value.prompt,passage:value.passage,options:value.options.map(option=>({id:option.id.trim(),text:option.text})),sourceQuestionNumber:value.sourceQuestionNumber.trim()||null,originalOrdinalInTask:value.originalOrdinalInTask.trim()?Number(value.originalOrdinalInTask):null};
    saving=true;error='';render();
    try{
      const result=await api(`${base}/review`,{...baseContext,reviewToken,author:true,proposal,review:value.review});
      if(!same(serial)||!author)return;
      saved={...result,importOperationId:crypto.randomUUID()};opened=null;loadVersion++;loading=false;view={...view,expectedSetRevision:result.expectedSetRevision};error='';
      try{await refresh();}catch{if(same(serial))error='校对已保存，列表刷新失败；可稍后刷新。';}
    }catch(failure){if(same(serial))error=failure.message+' 未保存输入仍保留。';}
    finally{saving=false;if(alive())render();}
  }
  async function compileSaved(){
    if(!saved?.canCompile||!author||compiling||compiled)return;
    const serial=version,selected={...saved};compiling=true;error='';render();
    try{
      const result=await api(`/materials/${encodeURIComponent(materialId)}/compile`,{sourceRevision:selected.sourceRevision,selectedIds:[selected.candidateId],candidateRevisions:{[selected.candidateId]:selected.candidateRevision},expectedEpoch:selected.expectedEpoch,importOperationId:selected.importOperationId});
      if(!same(serial)||!author)return;compiled=result;try{await refresh();}catch{if(same(serial))error='练习已加入，列表刷新失败；可稍后刷新。';}
    }catch(failure){if(same(serial))error=failure.message;}
    finally{compiling=false;if(alive())render();}
  }
  const workspaceChanged=()=>{const token=opened?.reviewToken;version++;loadVersion++;author=false;opened=null;saved=null;compiled=null;error='工作区已经改变，请刷新页面证据并重新核对。';loading=false;render();void closeRemote(token);};
  window.addEventListener('practicebridge-workspace-stale',workspaceChanged);
  async function destroy(){disposed=true;version++;loadVersion++;window.removeEventListener('practicebridge-workspace-stale',workspaceChanged);const token=opened?.reviewToken;opened=null;container.replaceChildren();await closeRemote(token);}
  await reload();return {reload,destroy};
}
