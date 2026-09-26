import {$,$$,esc,icon,sectionName,typeName,date,notify,fileData,busy,consent,download} from './ui.mjs';

export const materialStatusName = status => ({received:'原件已保存',analyzing:'正在评估',assessed:'评估已完成',needs_information:'需要补充材料',unsupported:'暂时无法整理',converting:'正在整理草稿',draft_ready:'草稿待检查',imported:'已加入题库',failed:'处理未完成',interrupted:'处理已中断'}[status] || '等待处理');
export const materialStatusTone = status => ['failed','unsupported','interrupted'].includes(status)?'error':['needs_information'].includes(status)?'warn':['analyzing','converting'].includes(status)?'blue':['received'].includes(status)?'muted':'';
export const materialFileSize = bytes => bytes>=1024*1024?`${(bytes/(1024*1024)).toFixed(1)} MB`:bytes>=1024?`${(bytes/1024).toFixed(1)} KB`:`${bytes || 0} B`;
const activeStatuses = new Set(['analyzing','converting']);
const assessmentName = status => ({processable:'可以整理',partially_processable:'可整理其中一部分',needs_information:'需要补充信息',unsupported:'当前无法整理'}[status] || '评估结果');

export async function renderImport(container,{api,refresh,settings,materialId=null,openReview=true,isCurrent=()=>true}) {
  let selected=[],material=null,draft=null,author=false,editedPack=null,jsonDraftText='',dirty=false,actionVersion=0,runningAction=false,pollTimer=null;
  container.innerHTML=`<div class="material-import-page"><div class="page-heading"><div><div class="eyebrow">我的材料</div><h1><span>先留好原件，</span><span>再整理成练习。</span></h1><p class="subtitle">文件先保存在本机材料库。评估与整理的结果也会保留，稍后可以继续。</p></div><a class="button ghost" href="#materials">${icon('back')} 返回材料库</a></div><div class="progress-steps"><span class="active" id="step-1"><b>1</b> 保存原件</span><span id="step-2"><b>2</b> 评估与整理</span><span id="step-3"><b>3</b> 检查并练习</span></div><div id="import-content"></div></div>`;
  const page=$('.material-import-page',container),content=$('#import-content',page);
  const current=version=>page.isConnected&&isCurrent()&&(version===undefined||version===actionVersion);
  const setStep=number=>{for(let i=1;i<=3;i++)$('#step-'+i,page)?.classList.toggle('active',i===number);};
  const updateState=()=>refresh().catch(()=>{});
  const cancelPoll=()=>{clearTimeout(pollTimer);pollTimer=null;};
  const fileList=files=>`<ul class="material-file-list">${(files||[]).map(f=>`<li>${icon('file')}<span>${esc(f.name)}</span><small>${materialFileSize(f.size)}</small></li>`).join('')}</ul>`;

  function sourceView(){
    cancelPoll();setStep(1);
    content.innerHTML=`<div class="panel-split"><section class="card"><h2 class="mb">把材料放进来</h2><fieldset id="source-inputs" class="material-fieldset"><label class="field"><span>材料名称（可选）</span><input type="text" id="import-title" placeholder="例如：本周整套练习与配套音频" maxlength="300"></label><label class="dropzone" id="dropzone">${icon('upload')}<strong>拖入文件，或点击选择</strong><p>可同时选择文档、压缩包和配套媒体，任何格式都可以先保存。<br>PDF / DOCX 最多 64 MB，其他文件最多 25 MB，ZIP 最多 80 MB；每批合计最多 80 MB、200 个文件。</p><input type="file" id="import-files" multiple></label><label class="button tiny mt">${icon('folder')} 选择材料文件夹<input type="file" id="import-folder" webkitdirectory multiple hidden></label><div class="file-list" id="selected-files"></div><details class="details"><summary>或者，粘贴文字材料</summary><textarea id="import-text" placeholder="粘贴题目、文章、答案说明或其他原始材料。" maxlength="500000"></textarea></details><div class="notice">保存原件不需要连接模型，也不要求文件预先整理成题库格式。保存后，再决定如何处理。</div><button class="button primary wide" id="save-material">${icon('folder')} 保存原件到材料库</button></fieldset><div id="import-error" role="status" aria-live="polite"></div></section><aside><div class="card"><div class="small-heading">材料会经过这三步</div><div class="steps"><div class="step-item"><span class="step-number">01</span><div><h4>先保存原件</h4><p>文档与音频可以放在同一批次。原始文件保存在本机，之后可以重新处理。</p></div></div><div class="step-item"><span class="step-number">02</span><div><h4>评估后整理</h4><p>AI 说明哪些内容能整理、缺少什么，再把可用部分整理成练习草稿。</p></div></div><div class="step-item"><span class="step-number">03</span><div><h4>检查后加入题库</h4><p>检查题目、答案与媒体关联。你确认后，草稿才会进入正式题库。</p></div></div></div></div><div class="card assistant-card"><h3>用自编样本体验</h3><p>样本仅在你主动保存后进入材料库，也可直接选择现有 PDF 和配套音频 ZIP。</p><button class="button wide" id="get-sample">${icon('download')} 下载普通文档样本</button><button class="button wide mt" id="get-example-pack">${icon('download')} 下载含音频的练习包</button></div></aside></div>`;
    const displayFiles=()=>{
      const list=$('#selected-files',content);
      list.innerHTML=selected.map((f,i)=>`<span class="file-chip">${esc(f.webkitRelativePath||f.name)} <button type="button" aria-label="移除 ${esc(f.name)}" data-index="${i}">×</button></span>`).join('');
      $$('[data-index]',list).forEach(button=>button.onclick=()=>{selected.splice(Number(button.dataset.index),1);displayFiles();});
    };
    const addFiles=files=>{selected.push(...files);displayFiles();};
    $('#import-files',content).onchange=e=>{addFiles(e.target.files);e.target.value='';};
    $('#import-folder',content).onchange=e=>{addFiles(e.target.files);e.target.value='';};
    const zone=$('#dropzone',content);
    zone.ondragover=e=>{e.preventDefault();if(!runningAction)zone.classList.add('over');};
    zone.ondragleave=()=>zone.classList.remove('over');
    zone.ondrop=e=>{e.preventDefault();zone.classList.remove('over');if(!runningAction)addFiles(e.dataTransfer.files);};
    $('#get-sample',content).onclick=()=>download('/examples/ordinary-materials.zip','PracticeBridge-普通文档样本.zip').catch(e=>notify(e.message,true));
    $('#get-example-pack',content).onclick=()=>download('/examples/getting-started.zip','PracticeBridge-自编样本.zip').catch(e=>notify(e.message,true));
    $('#save-material',content).onclick=async e=>{
      const text=$('#import-text',content).value,title=$('#import-title',content).value.trim(),picked=[...selected];
      if(!picked.length&&!text.trim()){notify('请选择原文件或粘贴材料文字。',true);return;}
      const version=++actionVersion,fieldset=$('#source-inputs',content),errorBox=$('#import-error',content),done=busy(e.currentTarget,'正在保存原件…');
      runningAction=true;fieldset.disabled=true;errorBox.textContent='';
      try{
        if(picked.length>200)throw new Error('每批最多保存 200 个文件。');
        if(picked.reduce((n,f)=>n+f.size,0)>80*1024*1024)throw new Error('本次文件总大小请控制在 80 MB 以内。');
        const files=[];for(const f of picked)files.push(await fileData(f));
        const result=await api('/materials',{files,text,title});
        if(!result.material?.id)throw new Error('服务器未返回已保存的材料记录，请保留原件后重试。');
        await updateState();
        if(!current(version))return;
        material=result.material;materialId=material.id;selected=[];
        history.replaceState(null,'',`#import/${encodeURIComponent(materialId)}`);
        materialView();
      }catch(error){if(current(version))errorBox.innerHTML=`<div class="notice error">${esc(error.message)}<br>本页选择的文件和文字仍保留，可以直接重试。</div>`;}
      finally{runningAction=false;fieldset.disabled=false;done();}
    };
    displayFiles();
  }

  function analysisMarkup(){
    const analysis=material.analysis;
    if(!analysis)return '<p class="hint">尚未评估。原件已经保存，可以选择 AI 评估整理，或尝试本地处理。</p>';
    const list=(label,items)=>Array.isArray(items)&&items.length?`<div class="material-analysis-group"><h4>${label}</h4><ul class="hint">${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:'';
    return `<div id="material-analysis"><span class="pill ${analysis.canCreateDraft?'':'warn'}">${assessmentName(analysis.status)}</span><p class="material-summary prewrap">${esc(analysis.summary||'评估结果已保留。')}</p>${analysis.detectedSections?.length?`<p class="hint">识别到的科目：${analysis.detectedSections.map(sectionName).map(esc).join('、')}</p>`:''}${list('需要补充',analysis.missingInformation)}${list('整理时注意',analysis.warnings)}</div>`;
  }

  function materialView(errorMessage=''){
    cancelPoll();setStep(2);
    const active=activeStatuses.has(material.status),hasAI=Boolean(settings.capabilities?.assessMaterials&&settings.capabilities?.structure),hasDraft=Boolean(material.draft);
    content.innerHTML=`<div class="panel-split"><section><div class="card" id="material-detail" data-material-id="${esc(material.id)}"><div class="flex-between mb"><h2 id="material-title">${esc(material.title)}</h2><span class="pill ${materialStatusTone(material.status)}" id="material-status">${materialStatusName(material.status)}</span></div><p class="hint">保存于 ${date(material.createdAt)} · ${(material.files||[]).length} 个原文件${material.text?' · 含粘贴文字':''}</p><div class="notice success">这批原件已保存在本机材料库。评估失败或暂时无法整理时，原件仍会保留。</div>${fileList(material.files)}${material.text?`<details class="details"><summary>查看已保存的文字</summary><div class="source-text">${esc(material.text)}</div></details>`:''}${material.libraryId?`<a class="button primary wide" href="#collection/${encodeURIComponent(material.libraryId)}">打开已整理的题库 ${icon('arrow')}</a>`:''}</div><div class="card mt"><div class="section-heading"><h2>这批材料的处理结果</h2><button class="button tiny" id="material-reload">${icon('refresh')} 刷新</button></div>${analysisMarkup()}${material.error?`<div class="notice error" id="material-saved-error">${esc(material.error)}</div>`:''}<div id="material-operation-error" role="status" aria-live="polite">${errorMessage?`<div class="notice error">${esc(errorMessage)}</div>`:''}</div></div></section><aside><div class="card"><h2>继续整理成练习</h2><p class="hint mt">一次确认后，先评估这批材料；有可整理的内容时，自动继续生成草稿。结果会保留在材料库。</p>${hasDraft?`<button class="button wide mt" id="open-material-draft">${icon('eye')} 打开已保存的草稿</button>`:''}<div id="material-ai-consent">${consent(settings,'本批材料提取出的文字、文件名和格式信息（用于本次评估及整理）')}</div><button class="button primary wide" id="process-material-ai" ${active||!hasAI?'disabled':''}>${icon('spark')} ${material.analysis?'重新评估并整理':'让 AI 评估并整理'}</button>${!hasAI?'<p class="hint mt">原件已保存。使用 AI 前，请先在模型与数据中配置可用服务。</p><a class="button wide mt" href="#settings">配置模型</a>':''}<details class="details"><summary>只在本机处理</summary><p class="hint mb">尝试处理已能识别的练习包和文档结构，不连接模型。未知结构会保留评估结果，供稍后继续。</p><button class="button wide" id="process-material-local" ${active?'disabled':''}>${icon('file')} 本地检查并整理</button></details><div id="material-activity" role="status" aria-live="polite">${active?`<div class="notice"><span class="spinner"></span>${materialStatusName(material.status)}。你可以切换页面，完成后从材料库继续。</div>`:''}</div></div><a class="button ghost wide mt" href="#import">${icon('plus')} 添加另一批材料</a></aside></div>`;
    $('#material-reload',content).onclick=async e=>{
      const version=++actionVersion,done=busy(e.currentTarget,'刷新中…');
      try{const result=await api(`/materials/${encodeURIComponent(materialId)}`);if(!current(version))return;material=result.material;materialView();}
      catch(error){if(current(version))$('#material-operation-error',content).innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
      finally{done();}
    };
    $('#process-material-ai',content).onclick=()=>{if(settings.capabilities?.materialJobs)location.hash=`#material-jobs/${encodeURIComponent(materialId)}`;else void processMaterial(true);};
    if(settings.capabilities?.materialJobs){$('#process-material-ai',content).textContent='准备分块 AI 整理';$('#material-ai-consent',content).innerHTML='<p class="hint">下一页会先列出题组和预算，再一次确认整项作业。此处不会发送模型请求。</p>';}
    const localTools=document.createElement('a');localTools.className='button wide mt';localTools.href=`#material-jobs/${encodeURIComponent(materialId)}`;localTools.textContent='分块作业、OCR 与转写';$('#material-activity',content).before(localTools);
    $('#process-material-local',content).onclick=()=>processMaterial(false);
    if($('#open-material-draft',content))$('#open-material-draft',content).onclick=()=>openSavedDraft();
    if(active&&!runningAction)scheduleMaterialRefresh();
  }

  function scheduleMaterialRefresh(){
    const version=actionVersion,id=materialId;
    pollTimer=setTimeout(async()=>{
      if(!current(version)||runningAction)return;
      try{
        const result=await api(`/materials/${encodeURIComponent(id)}`);
        if(!current(version))return;
        material=result.material;
        if(material.status==='draft_ready'&&material.draft)await openSavedDraft();else materialView();
      }catch(error){if(current(version))materialView(error.message);}
    },3500);
  }

  async function processMaterial(useAI){
    if(runningAction||activeStatuses.has(material.status))return;
    if(useAI&&!$('[name=consent]',content)?.checked){notify('请确认这批材料用于本次 AI 评估及整理的发送范围。',true);return;}
    const version=++actionVersion,id=materialId,request={useAI,consent:useAI,expectedBinding:structuredClone(settings.binding)};
    runningAction=true;cancelPoll();
    for(const button of $$('#process-material-ai,#process-material-local,#material-reload,#open-material-draft',content))button.disabled=true;
    const accepted=$('#material-ai-consent input',content);if(accepted)accepted.disabled=true;
    $('#material-operation-error',content).textContent='';
    const activity=$('#material-activity',content);
    activity.innerHTML=`<div class="notice"><span class="spinner"></span>${useAI?'正在评估已保存的材料…':'正在本地检查材料…'} 可以切换页面，处理结果会保留。</div>`;
    try{
      const assessed=await api(`/materials/${encodeURIComponent(id)}/assess`,request);
      let result=null;
      if(assessed.material?.analysis?.canCreateDraft===true){
        if(current(version))activity.innerHTML='<div class="notice"><span class="spinner"></span>评估完成，正在整理练习草稿…</div>';
        result=await api(`/materials/${encodeURIComponent(id)}/convert`,request);
      }
      await updateState();
      if(!current(version))return;
      material=result?.material||assessed.material;
      if(result?.candidateReview){location.hash=`#candidates/${encodeURIComponent(id)}`;}else if(result?.pack){adoptDraft(result);reviewView();}else materialView();
    }catch(error){
      let latest=null;try{latest=(await api(`/materials/${encodeURIComponent(id)}`)).material;}catch{}
      await updateState();
      if(!current(version))return;
      if(latest)material=latest;
      materialView(latest?.error===error.message?'':error.message);
    }finally{runningAction=false;if(current(version)&&activeStatuses.has(material?.status))scheduleMaterialRefresh();}
  }

  function adoptDraft(result){draft=result;editedPack=structuredClone(draft.pack);jsonDraftText=JSON.stringify(draft.pack,null,2);dirty=false;}
  async function openSavedDraft(){
    if(material?.candidateSummary){location.hash=`#candidates/${encodeURIComponent(materialId)}`;return;}
    if(dirty&&draft){actionVersion++;reviewView();return;}
    const version=++actionVersion,id=materialId;cancelPoll();
    const button=$('#open-material-draft',content),done=button?busy(button,'打开草稿…'):()=>{};
    try{const result=await api(`/materials/${encodeURIComponent(id)}/draft`);if(!current(version))return;material=result.material||material;adoptDraft(result);reviewView();}
    catch(error){if(current(version))materialView(error.message);}
    finally{done();}
  }

  function reviewView(){
    cancelPoll();setStep(3);
    const errors=(draft.issues||[]).filter(i=>i.severity==='error'),count=(draft.pack?.groups||[]).reduce((n,g)=>n+(g.questions||[]).length,0);
    content.innerHTML=`<div class="panel-split"><section><div class="card"><div class="flex-between mb"><h2>${esc(draft.pack?.title||'待校对的练习草稿')}</h2><span class="pill ${errors.length?'warn':''}">${errors.length?'需要修正':'待确认'}</span></div><p class="hint">识别到 ${count} 道题，${draft.pack?.groups?.length||0} 个题组，${draft.media?.length||0} 个媒体文件。草稿与原件保存在材料库。</p><div class="notice">${author?'作者视图会显示题干与标准答案。请对照原件修正提取或关联错误。':'当前为考生视图。题干和答案默认折叠，避免提前泄露练习内容。'}</div><label class="hint"><input type="checkbox" id="author-view" ${author?'checked':''}> 切换到作者校对视图（会显示答案）</label><div class="mt">${(draft.pack?.groups||[]).map(g=>`<div class="question-preview"><h3>${sectionName(g.section)} · ${esc(g.title)}</h3><p class="hint">${g.questions?.length||0} 道题${g.audio?' · 已引用音频':''}</p>${(g.questions||[]).map((q,i)=>`<details class="details" ${author?'open':''}><summary>第 ${i+1} 题 · ${typeName(q.type)}${q.answer===null?' · 无标准答案':''}</summary><p>${esc(q.prompt)}</p>${q.sentenceFrame?`<p class="sentence-frame-preview">${esc(q.sentenceFrame)}</p><p class="hint">${q.answerSlots} 个空位</p>`:''}${(q.options||[]).map(o=>`<p class="hint">${esc(o.id)}. ${esc(o.text)}</p>`).join('')}${author?`<div class="notice">答案：${esc(Array.isArray(q.answer)?q.answer.join(' → '):q.answer??'未提供')}\n${esc(q.explanation||'')}</div><p class="hint">来源：${esc(q.source||'待确认')}</p>`:'<p class="hint">标准答案在考生视图中隐藏。</p>'}</details>`).join('')}</div>`).join('')}</div>${author?fieldEditorMarkup():''}${author?`<details class="details"><summary>高级：编辑结构化草稿</summary><p class="hint mb">保留题组和题目的 id。修改后重新校验，校验后的草稿会保存，原件保持不变。</p><textarea class="code" id="draft-json" spellcheck="false">${esc(jsonDraftText)}</textarea><button class="button mt" id="validate-draft">${icon('refresh')} 重新校验草稿</button></details>`:''}</div></section><aside><div class="card"><div class="section-heading"><h2>检查结果</h2><span class="pill muted">${draft.issues?.length||0} 项提示</span></div>${draft.issues?.length?draft.issues.map(i=>`<div class="issue ${i.severity==='error'?'error':''}">${esc(i.message)}${i.path?`<br><small>${esc(i.path)}</small>`:''}</div>`).join(''):'<div class="notice success">结构与引用检查通过。请按需确认来源内容。</div>'}<label class="consent"><input type="checkbox" id="acknowledge"><span>我确认这些是要导入的材料，已检查以上提示。无答案题目仅用于不计分练习。</span></label><button class="button primary wide" id="commit-import" ${errors.length||dirty||draft.canCommit===false?'disabled':''}>确认加入题库 ${icon('arrow')}</button><button class="button ghost wide mt" id="material-details">返回材料详情</button><a class="button ghost wide" href="#materials">查看材料库</a><div id="commit-error" role="status" aria-live="polite"></div></div>${draft.sources?.length?`<details class="card details"><summary>原始提取文字（可能包含答案）</summary>${draft.sources.map(s=>`<h4>${esc(s.name)}</h4><div class="source-text">${esc(s.text)}</div>`).join('')}</details>`:''}<div class="notice">校验检查结构与引用，不等于语义一定正确。正式题库只会在你确认后保存。</div></aside></div>`;
    bindFieldEditor();
    $('#author-view',content).onchange=e=>{author=e.target.checked;reviewView();};
    $('#material-details',content).onclick=()=>{actionVersion++;materialView(dirty?'尚有未校验的编辑，返回草稿可继续校验。':'');};
    if($('#validate-draft',content))$('#validate-draft',content).onclick=validateCurrentDraft;
    $('#commit-import',content).onclick=async e=>{
      if(!$('#acknowledge',content).checked){notify('请确认材料与检查提示。',true);return;}
      if(dirty){notify('草稿已修改，请先重新校验。',true);return;}
      const version=++actionVersion,done=busy(e.currentTarget,'正在保存题库…');
      try{
        const result=await api('/import/commit',{draftId:draft.draftId,pack:draft.pack,acknowledged:true});
        await updateState();if(!current(version))return;
        content.innerHTML=`<div class="card"><div class="empty"><span class="empty-symbol">${icon('check')}</span><h2>材料已就位。</h2><p class="mt">${esc(result.library.title)} 已加入你的题库。<br>原件和整理记录继续保留在材料库。</p><div class="button-row justify-center"><a class="button primary" href="#collection/${encodeURIComponent(result.library.libraryId)}">开始练习 ${icon('arrow')}</a><a class="button" href="#library">查看我的题库</a><a class="button" href="#materials">返回材料库</a></div></div></div>`;
      }catch(error){if(current(version))$('#commit-error',content).innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
      finally{done();}
    };
  }

  function mediaSelect(value,kind,attrs){
    const list=(draft.media||[]).filter(m=>typeof m.mime==='string'&&m.mime.startsWith(kind+'/')).map(m=>m.name);
    if(value&&!list.includes(value))list.unshift(value);
    return `<select ${attrs}><option value="">未关联</option>${list.map(name=>`<option value="${esc(name)}" ${value===name?'selected':''}>${esc(name)}</option>`).join('')}</select>`;
  }

  function fieldEditorMarkup(){
    const pack=editedPack||draft.pack;
    return `<details class="details mt" open><summary>集中修正疑点</summary><p class="hint mb">直接修改有问题的字段。音频只按你选择的文件关联；组句题可分别保留固定句框和需要填写的空位。</p><div id="field-editor">${(pack.groups||[]).map((g,gi)=>`<details class="details"><summary>${esc(g.title)} · 题组材料与 ${(g.questions||[]).length} 道题</summary><label class="field"><span>题组共用音频</span>${mediaSelect(g.audio,'audio',`data-gi="${gi}" data-field="audio"`)}</label><label class="field"><span>共享文章</span><textarea data-gi="${gi}" data-field="passage">${esc(g.passage)}</textarea></label>${(g.questions||[]).map((q,qi)=>`<details class="details question-field-editor" data-question-editor="${gi}-${qi}"><summary>第 ${qi+1} 题 · ${typeName(q.type)}</summary><label class="field"><span>题干</span><textarea data-gi="${gi}" data-qi="${qi}" data-field="prompt">${esc(q.prompt)}</textarea></label>${q.type==='sentence_order'?`<label class="field"><span>固定句框（可选）</span><textarea data-gi="${gi}" data-qi="${qi}" data-field="sentenceFrame" placeholder="例如：I _____ _____ .">${esc(q.sentenceFrame||'')}</textarea><small>用连续下划线表示每个空位。原题固定的文字和标点保留在句框中。</small></label><label class="field"><span>需要填写的空位数（可选）</span><input type="number" min="1" max="30" data-gi="${gi}" data-qi="${qi}" data-field="answerSlots" value="${esc(q.answerSlots??'')}" placeholder="与句框中的空位数一致"><small>不使用固定句框时，这两项都留空。</small></label>`:''}${(q.options||[]).map((o,oi)=>`<label class="field"><span>选项 / 词块 ${esc(o.id)}</span><input type="text" data-gi="${gi}" data-qi="${qi}" data-oi="${oi}" data-field="option" value="${esc(o.text)}"></label>`).join('')}<label class="field"><span>标准答案（未提供则留空；多个值用 | 分隔）</span><input type="text" data-gi="${gi}" data-qi="${qi}" data-field="answer" value="${esc(Array.isArray(q.answer)?q.answer.join(' | '):q.answer||'')}"></label><label class="field"><span>本题音频</span>${mediaSelect(q.audio,'audio',`data-gi="${gi}" data-qi="${qi}" data-field="audio"`)}</label><label class="field"><span>本题配图</span>${mediaSelect(q.image,'image',`data-gi="${gi}" data-qi="${qi}" data-field="image"`)}</label><div class="fields-grid"><label class="field"><span>作答时间（秒，0 为不限时）</span><input type="number" min="0" max="7200" data-gi="${gi}" data-qi="${qi}" data-field="timeLimitSeconds" value="${q.timeLimitSeconds??0}"></label><label class="field"><span>准备时间（秒）</span><input type="number" min="0" max="7200" data-gi="${gi}" data-qi="${qi}" data-field="prepareSeconds" value="${q.prepareSeconds??0}"></label></div><p class="hint">来源：${esc(q.source)}</p></details>`).join('')}</details>`).join('')}</div><button class="button" id="validate-fields">${icon('check')} 应用修改并重新校验</button></details>`;
  }

  async function validateCurrentDraft(e){
    const version=++actionVersion,done=busy(e.currentTarget,'正在校验并保存草稿…');
    try{
      const pack=JSON.parse(jsonDraftText);
      const result=await api('/import/validate',{draftId:draft.draftId,pack});
      if(!current(version))return;
      adoptDraft(result);reviewView();notify('草稿已重新校验并保存');
    }catch(error){if(current(version))notify(error.message,true);}
    finally{done();}
  }

  function bindFieldEditor(){
    $$('#field-editor [data-field]',content).forEach(el=>el.oninput=()=>{
      actionVersion++;editedPack||=structuredClone(draft.pack);
      const {gi,qi,oi,field}=el.dataset,target=qi===undefined?editedPack.groups[Number(gi)]:editedPack.groups[Number(gi)].questions[Number(qi)];
      if(field==='option')target.options[Number(oi)].text=el.value;
      else if(field==='answer')target.answer=!el.value.trim()?null:target.type==='sentence_order'||el.value.includes('|')?el.value.split('|').map(v=>v.trim()):el.value;
      else if(field==='sentenceFrame'||field==='answerSlots'){
        const editor=el.closest('[data-question-editor]'),frame=$('[data-field=sentenceFrame]',editor).value,slots=$('[data-field=answerSlots]',editor).value;
        if(!frame.trim()&&!slots.trim()){delete target.sentenceFrame;delete target.answerSlots;}else{target.sentenceFrame=frame;target.answerSlots=slots.trim()?Number(slots):null;}
      }
      else if(['audio','image'].includes(field))target[field]=el.value||null;
      else if(['timeLimitSeconds','prepareSeconds'].includes(field))target[field]=Number(el.value);
      else target[field]=el.value;
      dirty=true;$('#commit-import',content).disabled=true;jsonDraftText=JSON.stringify(editedPack,null,2);
      if($('#draft-json',content))$('#draft-json',content).value=jsonDraftText;
    });
    if($('#draft-json',content))$('#draft-json',content).oninput=e=>{actionVersion++;jsonDraftText=e.target.value;dirty=true;$('#commit-import',content).disabled=true;try{editedPack=JSON.parse(jsonDraftText);}catch{}};
    if($('#validate-fields',content))$('#validate-fields',content).onclick=validateCurrentDraft;
  }

  if(materialId){
    const version=++actionVersion;
    content.innerHTML='<div class="loading"><span class="spinner"></span>正在读取已保存的材料</div>';
    try{
      const result=await api(`/materials/${encodeURIComponent(materialId)}`);
      if(!current(version))return;
      material=result.material;materialView();
      if(openReview&&(material.candidateSummary||material.status==='draft_ready'&&material.draft))await openSavedDraft();
    }catch(error){if(current(version))content.innerHTML=`<div class="card"><div class="notice error">${esc(error.message)}</div><a class="button" href="#materials">返回材料库</a></div>`;}
  }else sourceView();
}
