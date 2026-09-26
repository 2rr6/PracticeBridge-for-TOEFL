import {esc} from './ui.mjs';

export async function renderOcrSettings(root,{api,isCurrent=()=>root.isConnected}={}){
  let current=null,busy=false,timer=null,message='',fetchGeneration=0;
  const alive=()=>root.isConnected&&isCurrent();
  const notice=text=>{message=text;if(alive()){root.querySelector('[data-ocr-message]').textContent=text;}};
  const mib=value=>(value/1024/1024).toFixed(1);
  const refresh=async()=>{
    const generation=++fetchGeneration;clearTimeout(timer);
    try{const s=await api('/ocr/status');if(!alive()||generation!==fetchGeneration)return;current=s;draw();if(s.active)timer=setTimeout(refresh,800);}
    catch(e){notice(e.message);}
  };
  const action=async(name,body={})=>{
    if(busy||!current)return;busy=true;message='';const snapshot=current;draw();
    try{await api(`/ocr/${name}`,{...body,expectedEpoch:snapshot.expectedEpoch});if(alive())await refresh();}
    catch(e){notice(e.message);}
    finally{busy=false;if(alive())draw();}
  };
  function draw(){
    if(!alive()||!current)return;const s=current,oldMessage=message;
    root.innerHTML=`<div class="section-heading"><h2>本机扫描件 OCR</h2><span class="pill muted">${({unavailable:'尚不可用',enabled:'已启用',disabled:'已安装 · 已停用',running:'正在处理'})[s.state]}</span></div><p class="hint">${esc(s.detail)}</p><p class="hint">英语 · Tesseract.js ${esc(s.engine.packageVersion)}。启用不会自动处理已有材料。</p><details class="details" data-ocr-install-details><summary>安装范围与位置</summary><p class="hint">下载来源：官方 npm 语言包。压缩下载大小尚未实测；本次下载最多 ${mib(s.preview.downloadLimitBytes)} MiB，解包文件合计约 ${mib(s.preview.unpackedPackageBytes)} MiB。运行组件需由已验证版本的应用提供。不会发送材料、图片、账号或录音。</p><p class="hint" data-ocr-path>位置：${esc(s.assetDir)}</p><label class="hint"><input type="checkbox" data-ocr-install-consent> 我确认上述下载上限和安装位置</label><div class="button-row mt"><button class="button" data-ocr-install ${busy||s.active?'disabled':''}>下载并安装英语数据</button></div></details><div class="button-row mt"><button class="button" data-ocr-enable ${busy||s.active||!s.installed?'disabled':''}>${s.enabled?'停用 OCR':'启用 OCR'}</button><button class="button" data-ocr-test ${busy||s.active||!s.enabled?'disabled':''}>运行自编英文图片自检</button><button class="button" data-ocr-refresh ${busy?'disabled':''}>刷新状态</button>${s.active?'<button class="button" data-ocr-cancel>取消当前操作</button>':''}</div><p class="hint mt">${esc(s.networkPolicy)}</p><details class="details"><summary>处理限制与保存</summary><p class="hint">${esc(s.memoryPolicy)} 停用后保留已审阅题目、原图和派生证据；不会自动切换云 OCR。</p></details><div class="notice mt" data-ocr-message>${esc(oldMessage||s.last?.detail||'自检只识别应用自编的英文图片，不会读取你的材料。')}</div>${s.last?.result?.recognizedText?`<details class="details" open><summary>自检实际结果</summary><p class="hint">实际引擎：${esc(s.last.result.engine?.engineVersion||'未知')} · 词框 ${s.last.result.wordCount} 个 · 不作为准确率评分</p><pre class="prewrap">${esc(s.last.result.recognizedText)}</pre></details>`:''}`;
    root.querySelector('[data-ocr-install]').onclick=()=>{if(!root.querySelector('[data-ocr-install-consent]').checked){notice('请先确认这里显示的下载上限和安装位置。');return;}action('install',{confirmed:true,previewId:s.preview.previewId});};
    root.querySelector('[data-ocr-enable]').onclick=()=>action('configure',{enabled:!s.enabled});
    root.querySelector('[data-ocr-test]').onclick=()=>action('selftest');
    root.querySelector('[data-ocr-refresh]').onclick=()=>{message='';refresh();};
    root.querySelector('[data-ocr-cancel]')?.addEventListener('click',()=>action('cancel',{operationId:s.active.id}));
  }
  root.innerHTML='<h2>本机扫描件 OCR</h2><p data-ocr-message>正在检查可选组件…</p>';await refresh();
  return {close(){clearTimeout(timer);}};
}
