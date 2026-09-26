import {$,$$,esc,typeName,busy,notify} from './ui.mjs';
import {mountDocumentSourceReview} from './document-source-review.mjs';
import {renderMediaMappingSummary} from './media-review.mjs';

/** Production material review: every edit is a guarded persisted revision. */
export async function renderCandidateReview(container,{api,refresh,materialId,isCurrent=()=>true}){
  let view,viewAuthor=false,author=false,generation=0,selected=new Set(),selectionInitialized=false;
  const fieldDrafts=new Map(),mappingDrafts=new Map(),expanded=new Map(),pending=new Set(),errors=new Map();
  const alive=()=>container.isConnected&&isCurrent();
  const base=`/materials/${encodeURIComponent(materialId)}`;
  const current=version=>container.isConnected&&isCurrent()&&version===generation;
  async function load(){const version=++generation,requestedAuthor=author;const result=await api(`${base}/candidates${requestedAuthor?'?author=1':''}`);if(!current(version))return;view=result;viewAuthor=requestedAuthor;if(!selectionInitialized){selected=new Set(view.candidates.filter(c=>c.readiness.canAnswer).map(c=>c.candidateId));selectionInitialized=true;}render();}
  function render(){
    const ready=view.candidates.filter(c=>c.readiness.canAnswer&&c.readiness.canScore),unscored=view.candidates.filter(c=>c.readiness.canAnswer&&!c.readiness.canScore),pending=view.candidates.filter(c=>!c.readiness.canAnswer);
    container.innerHTML=`<div class="page-heading"><div><h1>集中校对与部分练习</h1><p class="subtitle">先练已经可用的题目，其余候选和原件留在这批材料中，稍后继续补齐。</p></div><a class="button" href="#import/${esc(materialId)}/originals">材料与原件</a></div><section class="card"><div class="button-row"><span class="pill">可判分 ${ready.length}</span><span class="pill">可练但不计分 ${unscored.length}</span><span class="pill warn">待补 ${pending.length}</span></div><p class="hint mt">这是所选材料的部分练习；完整考试范围尚未确认。来源定位不等于答案正确。</p><label class="consent"><input id="candidate-author" type="checkbox" ${author?'checked':''}>作者校对视图（会显示题面与答案）</label><div class="button-row"><button class="button primary" id="compile-candidates" ${ready.length+unscored.length?'':'disabled'}>加入所选可用部分</button><button class="button" id="select-answerable">选择全部可用题</button></div><div id="candidate-result" role="status" aria-live="polite"></div></section>${[['可练习并判分',ready],['可练习，不计分',unscored],['待补材料',pending]].map(([label,items])=>`<section class="card mt"><h2>${label} · ${items.length}</h2>${items.length?items.map(card).join(''):'<p class="hint">此组暂无候选。</p>'}</section>`).join('')}`;
    $('#candidate-author',container).onchange=async event=>{author=event.target.checked;try{await load();}catch(error){notify(error.message,true);}};
    $('#select-answerable',container).onclick=()=>{selected=new Set(view.candidates.filter(c=>c.readiness.canAnswer).map(c=>c.candidateId));render();};
    $$('[data-candidate-select]',container).forEach(input=>input.onchange=()=>{if(input.checked)selected.add(input.dataset.candidateSelect);else selected.delete(input.dataset.candidateSelect);});
    $('#compile-candidates',container).onclick=compile;
    const jobsLink=document.createElement('a');jobsLink.className='button mt';jobsLink.href=`#material-jobs/${encodeURIComponent(materialId)}`;jobsLink.textContent='分块继续整理与本地转写';container.querySelector('section.card').append(jobsLink);
    if(author&&viewAuthor){const originals=Object.values(view.artifactIndex).find(entry=>entry.kind==='document')?.value.originals||[],links=document.createElement('div');links.className='button-row mt';for(const [index,original] of originals.entries()){const link=document.createElement('a');link.className='button tiny';link.textContent=`原件：${original.name}`;link.href=`/api${base}/originals/${index}`;link.download=original.name;links.append(link);}container.querySelector('section.card').append(links);}
    if(author&&viewAuthor)bindEditors();
  }
  function card(candidate){
    const label=`原题 ${candidate.sourceQuestionNumber??candidate.originalOrdinalInTask??'序号未知'} · ${typeName(candidate.answerType)}`;
    return `<article class="question-preview" data-candidate="${esc(candidate.candidateId)}"><h3><label><input type="checkbox" data-candidate-select="${esc(candidate.candidateId)}" ${selected.has(candidate.candidateId)?'checked':''} ${candidate.readiness.canAnswer?'':'disabled'}> ${esc(label)}</label></h3><p class="hint">候选修订 ${candidate.revision}${candidate.readiness.canSimulateOriginal?' · 已满足原型材料条件':' · 不宣称完整原考模拟'}</p>${candidate.blockingIssues.map(issue=>`<p class="notice warn">${esc(issue.reason)}</p>`).join('')}${author&&viewAuthor?editor(candidate):'<p class="hint">题面与答案已隐藏。需要核对时打开作者视图。</p>'}</article>`;
  }
  function editor(candidate){
    // Draft values and option controls must use the same captured revision.
    const f=(fieldDrafts.get(candidate.candidateId)?.base||candidate).fields,media=Object.entries(view.artifactIndex).filter(([,entry])=>entry.kind==='media');
    return `<details class="details candidate-editor" ${candidate.candidateId===view.candidates[0]?.candidateId?'open':""}><summary>校对本题字段、来源与媒体</summary><form data-candidate-form="${esc(candidate.candidateId)}"><label class="field"><span>题干</span><textarea name="prompt">${esc(f.prompt||'')}</textarea></label>${(f.options||[]).map((option,i)=>`<label class="field"><span>选项 ${esc(option.id)}</span><input type="text" name="option-${i}" value="${esc(option.text)}"></label>`).join('')}<label class="field"><span>答案（未核实则留空；多项用每行一项）</span><textarea name="answer">${esc(Array.isArray(f.answer)?f.answer.join('\n'):f.answer||'')}</textarea></label><label class="field"><span>解释</span><textarea name="explanation">${esc(f.explanation||'')}</textarea></label><label class="consent"><input type="checkbox" name="answer-reviewed">我已对照来源核实此答案</label><button class="button" type="submit">保存字段校对</button><p class="hint">人工保存为新候选修订。已导入题库和历史练习保持原快照。</p></form><div data-media-editor="${esc(candidate.candidateId)}"><h4>媒体对应关系</h4>${renderMediaMappingSummary(candidate.mappings.map(item=>{const asset=view.artifactIndex[item.assetId]?.value;return {...item,assetName:asset?.name,decodeState:asset?.evidence?.decodeState};}))}<label class="field"><span>媒体角色</span><select name="media-role"><option value="audio">当前题音频</option><option value="groupAudio">共享题组刺激音频（影响同组候选）</option><option value="image">当前题图片</option><option value="groupImage">共享题组图片（影响同组候选）</option></select></label><label class="field"><span>配套媒体</span><select name="audio-asset"><option value="">选择配套媒体</option>${media.map(([ref,entry])=>`<option value="${esc(ref)}" ${candidate.fields.audio===entry.value.name?'selected':''}>${esc(entry.value.name)}</option>`).join('')}</select></label><label><input type="checkbox" name="content-checked">我已核对内容并确认对应本题</label><button class="button tiny" data-save-mapping="${esc(candidate.candidateId)}">保存对应关系</button></div><div data-source-review="${esc(candidate.candidateId)}"></div><div data-candidate-error role="status"></div></details>`;
  }
  function bindEditors(){
    for(const candidate of view.candidates){
      const cardRoot=$(`[data-candidate="${candidate.candidateId}"]`,container),form=$('form',cardRoot);
      const id=candidate.candidateId,details=$('.candidate-editor',cardRoot);
      if(expanded.has(id))details.open=expanded.get(id);
      details.ontoggle=()=>{if(details.isConnected)expanded.set(id,details.open);};
      const readFields=()=>Object.fromEntries([...form.elements].filter(el=>el.name).map(el=>[el.name,el.type==='checkbox'?el.checked:el.value]));
      const restoreFields=values=>{for(const [name,value] of Object.entries(values)){const el=form.elements[name];if(el)el.type==='checkbox'?el.checked=value:el.value=value;}};
      const fieldDefaults=readFields();
      if(fieldDrafts.has(id))restoreFields(fieldDrafts.get(id).values);
      form.oninput=()=>{const old=fieldDrafts.get(id),values=readFields();if(!old&&JSON.stringify(values)===JSON.stringify(fieldDefaults))return;fieldDrafts.set(id,{base:old?.base||candidate,epoch:old?.epoch||view.expectedEpoch,values});};
      const dependencies=candidate.dependencyRefs.map(ref=>view.artifactIndex[ref]),group=dependencies.find(d=>d?.kind==='group');
      const source=Object.values(view.artifactIndex).find(d=>d.kind==='document')?.value;
      const fieldEvidence=[...(source?.fieldEvidence||[]).filter(entry=>entry.path===`groups.${group?.sourceGroupIndex}.passage`).map(entry=>({...entry,path:'groups.0.passage'})),...candidate.fieldEvidence.map(entry=>({...entry,path:`groups.0.questions.0.${entry.path}`}))];
      mountDocumentSourceReview($('[data-source-review]',cardRoot),{pack:{groups:[{...(group?.value||{}),questions:[candidate.fields]}]},fieldEvidence,documentLayout:source?.documentLayout},{author:true});
      const mediaSelect=$('[name=audio-asset]',cardRoot),preview=document.createElement('div');preview.className='candidate-media-preview';mediaSelect.parentElement.after(preview);
      const role=$('[name=media-role]',cardRoot),checked=$('[name=content-checked]',cardRoot);
      const mappingDraft=mappingDrafts.get(id);
      if(mappingDraft){role.value=mappingDraft.values.role;mediaSelect.value=mappingDraft.values.assetId;checked.checked=mappingDraft.values.contentChecked;}
      const rememberMapping=()=>{const old=mappingDrafts.get(id);mappingDrafts.set(id,{base:old?.base||candidate,epoch:old?.epoch||view.expectedEpoch,values:{role:role.value,assetId:mediaSelect.value,contentChecked:checked.checked}});};
      const previewMedia=()=>{preview.replaceChildren();const asset=view.artifactIndex[mediaSelect.value]?.value;if(!asset)return;const player=document.createElement(asset.blob.mime.startsWith('audio/')?'audio':'img');if(player.tagName==='AUDIO'){player.controls=true;player.preload='none';}else{player.alt='所选材料图片';player.width=500;}player.src=`/api${base}/candidates/media/${encodeURIComponent(mediaSelect.value)}`;preview.append(player);};
      mediaSelect.onchange=()=>{checked.checked=false;rememberMapping();previewMedia();};role.onchange=()=>{checked.checked=false;rememberMapping();};checked.onchange=rememberMapping;previewMedia();
      const errorBox=$('[data-candidate-error]',cardRoot);errorBox.textContent=errors.get(id)||'';
      const stale=[fieldDrafts.get(id),mappingDrafts.get(id)].some(d=>d&&(d.base.revision!==candidate.revision||d.epoch!==view.expectedEpoch));
      if(stale){const note=document.createElement('p');note.className='notice warn';note.textContent='本题已有新修订。未保存修改仍保留原修订号；保存时会检查冲突。';errorBox.append(note);const reset=document.createElement('button');reset.className='button tiny';reset.textContent='放弃未保存修改并载入最新修订';reset.onclick=()=>{fieldDrafts.delete(id);mappingDrafts.delete(id);errors.delete(id);render();};errorBox.append(reset);}
      if(pending.has(id))$$('input,textarea,select,button',cardRoot).forEach(el=>el.disabled=true);
      form.onsubmit=async event=>{
        event.preventDefault();const draft=fieldDrafts.get(id),base=draft?.base||candidate,fields={prompt:form.elements.prompt.value,explanation:form.elements.explanation.value};
        const text=form.elements.answer.value.trim();fields.answer=!text?null:base.answerType==='sentence_order'||Array.isArray(base.fields.answer)?text.split('\n'):text;
        if(base.fields.options)fields.options=base.fields.options.map((option,i)=>({...option,text:form.elements[`option-${i}`].value}));
        const changed=Object.fromEntries(Object.entries(fields).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(base.fields[key]??(key==='answer'?null:key==='options'?[]:''))));
        await save(base,{fields:changed,reviewFields:form.elements['answer-reviewed'].checked?['answer']:[]},cardRoot,form.querySelector('button'),fieldDrafts,draft);
      };
      $('[data-save-mapping]',cardRoot).onclick=async event=>{const assetId=mediaSelect.value;if(!assetId){notify('请选择配套媒体。',true);return;}const draft=mappingDrafts.get(id);await save(draft?.base||candidate,{fields:{},mapping:{targetId:role.value,assetId,contentChecked:checked.checked}},cardRoot,event.currentTarget,mappingDrafts,draft);};
    }
  }
  async function save(candidate,patch,cardRoot,button,drafts,draft){
    const id=candidate.candidateId;if(pending.has(id))return;
    pending.add(id);errors.delete(id);
    const expectedEpoch=draft?.epoch||view.expectedEpoch,done=busy(button,'正在保存…');$$('input,textarea,select,button',cardRoot).forEach(el=>el.disabled=true);
    try{await api(`${base}/candidates/${encodeURIComponent(id)}/patch`,{...patch,expectedRevision:candidate.revision,expectedEpoch});if(drafts.get(id)===draft)drafts.delete(id);if(alive()){await refresh();await load();}}
    catch(error){errors.set(id,error.message);}
    finally{pending.delete(id);done();if(alive())render();}
  }
  async function compile(event){
    const version=generation,chosen=view.candidates.filter(c=>selected.has(c.candidateId)&&c.readiness.canAnswer),box=$('#candidate-result',container);
    if(!chosen.length){box.textContent='尚未选择可用题目。原件和待补候选已保留。';return;}
    const request={sourceRevision:view.sourceRevision,selectedIds:chosen.map(c=>c.candidateId),candidateRevisions:Object.fromEntries(chosen.map(c=>[c.candidateId,c.revision])),expectedEpoch:view.expectedEpoch};
    const key=`candidate-import:${materialId}:${JSON.stringify(request)}`;
    let operationId=sessionStorage.getItem(key);if(!operationId){operationId=crypto.randomUUID();sessionStorage.setItem(key,operationId);}
    const done=busy(event.currentTarget,'正在加入题库…');
    try{const result=await api(`${base}/compile`,{...request,importOperationId:operationId});if(!current(version))return;await refresh();if(!current(version))return;box.innerHTML=result.receipt?`<div class="notice success">本次新增 ${result.receipt.added??result.receipt.selected} 道题；已加入的相同版本保持原位置。仍有 ${result.completeness.pending} 道待补候选保留在本页。</div><a class="button primary" href="#collection/${esc(result.receipt.libraryId)}">打开部分练习</a>`:'原件和候选已保留，目前没有可加入的题目。';}
    catch(error){if(current(version))box.textContent=error.message;}
    finally{done();}
  }
  await load();
}
