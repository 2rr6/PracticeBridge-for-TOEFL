import {$,esc,busy,notify} from './ui.mjs';

/** Offer for a material with scanned pages: proofread them with the connected
 * image-capable model. Nothing is sent before the user ticks the consent box. */
export function scanProofreadMarkup(material,settings){
  const scan=material?.scan;
  if(!scan?.pages)return '';
  const remaining=scan.pages-(scan.proofread||0);
  if(remaining<=0)return `<div class="notice success mt" id="scan-proofread">这批材料的 ${scan.pages} 页扫描页已由 AI 对照页面图片校对。</div>`;
  const service=settings?.model?`${settings.model}`:'当前 AI 服务';
  const offer=settings?.capabilities?.proofreadScans
    ?`<label class="consent"><input type="checkbox" id="scan-proofread-consent">把这 ${remaining} 页扫描页的图片和本机识别的文字发送给 ${esc(service)}。费用按该服务的价格计算，用便宜的看图模型校对一套 35 页的试卷大约几毛钱。</label><button class="button primary" id="scan-proofread-run">用 AI 看图校对扫描页</button>`
    :'<p class="hint">需要先在「模型与数据」中连接一个支持图片输入的 API 服务（看图模型）。</p><a class="button" href="#settings">去连接 AI</a>';
  return `<div class="notice mt" id="scan-proofread"><p><b>这批材料有 ${scan.pages} 页扫描页。</b>本机识别没有把握的答案已经留空，没有猜测。让 AI 对照页面图片校对后，大部分留空的答案可以补全。</p>${offer}<div id="scan-proofread-status" role="status" aria-live="polite"></div></div>`;
}

export function bindScanProofread(container,{api,materialId,settings,onDone}){
  const run=$('#scan-proofread-run',container);
  if(!run)return;
  run.onclick=async()=>{
    if(!$('#scan-proofread-consent',container)?.checked){notify('请先确认把扫描页图片发送给 AI 服务。',true);return;}
    const status=$('#scan-proofread-status',container),done=busy(run,'正在校对…'),path=`/materials/${encodeURIComponent(materialId)}`;
    const poll=setInterval(async()=>{
      try{const progress=(await api(path)).material?.progress;if(progress&&status.isConnected)status.innerHTML=`<p class="hint"><span class="spinner"></span>${progress.stage==='proofread'?'正在用 AI 校对扫描页':'正在读取扫描页'} ${progress.done}/${progress.total}</p>`;}catch{}
    },2000);
    try{
      const result=await api(`${path}/proofread-scans`,{consent:true,expectedBinding:structuredClone(settings.binding)});
      clearInterval(poll);
      const failed=result.failed.length?`，${result.failed.length} 页没有完成（${esc(result.failed.slice(0,3).map(item=>`第 ${item.page} 页：${item.message}`).join('；'))}）`:'';
      status.innerHTML=`<p class="hint">已校对 ${result.proofread}/${result.total} 页${failed}。正在按校对结果重新整理…</p>`;
      await onDone(result);
    }catch(error){status.innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
    finally{clearInterval(poll);done();}
  };
}
