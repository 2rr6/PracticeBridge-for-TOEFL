import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicWrite} from './store.mjs';
import {inspectOcrAssets,hash,ocrError} from './ocr-policy.mjs';
import {ocrInstallPreview,installOcrLanguage} from './ocr-install.mjs';
import {createOcrWorker} from './workers/ocr.mjs';

/** Optional local capability lifecycle. Material execution is separately
 * registered with T06; the settings self-test uses only authored synthetic text. */
export function createOcrService({dataDir,getEpoch,inspectAssets=inspectOcrAssets,installLanguage=installOcrLanguage,createWorker=createOcrWorker}={}){
  const assetDir=path.join(dataDir,'optional','ocr'),artifactDir=path.join(dataDir,'processing-artifacts'),settingsPath=path.join(assetDir,'settings.json');
  let enabled=false,active=null,last=null,ready,saveQueue=Promise.resolve();
  const guard=expectedEpoch=>{if(typeof expectedEpoch!=='string'||expectedEpoch!==getEpoch())throw ocrError('OCR_STALE_WORKSPACE','工作区已改变，请重新打开 OCR 设置。',409);};
  ready=(async()=>{try{const value=JSON.parse(await fs.readFile(settingsPath,'utf8'));enabled=value.version===1&&value.enabled===true;}catch(e){if(e.code!=='ENOENT')enabled=false;}})();
  const publicOperation=op=>op?{id:op.id,kind:op.kind,state:op.state,code:op.code||null,detail:op.detail||null,result:op.result||null}:null;
  async function status(){await ready;const assets=await inspectAssets({assetDir});return {expectedEpoch:getEpoch(),state:active?'running':!assets.available?'unavailable':enabled?'enabled':'disabled',installed:assets.available,enabled:enabled&&assets.available,detail:assets.available?'英语 OCR 在本机运行；结果需要对照原图校对。':assets.detail,code:assets.code||null,assetDir,preview:ocrInstallPreview(assetDir),engine:{backend:'tesseract.js',packageVersion:'7.0.0',language:'eng',languageVersion:'1.0.0'},active:publicOperation(active),last:publicOperation(last),networkPolicy:'仅安装动作下载公开语言数据；处理材料时不主动请求网络，未建立操作系统网络隔离。',memoryPolicy:'独立进程监视总内存并可终止；采样限制不是操作系统硬内存配额。'};}
  async function configure({enabled:next,expectedEpoch}={}){
    await ready;guard(expectedEpoch);if(typeof next!=='boolean')throw ocrError('OCR_CONFIG_INVALID','OCR 启用状态无效。');
    const operation=saveQueue.then(async()=>{guard(expectedEpoch);if(next&&!(await inspectAssets({assetDir})).available)throw ocrError('OCR_ASSETS_MISSING','请先完成英语 OCR 安装与校验。',503);guard(expectedEpoch);await fs.mkdir(assetDir,{recursive:true});await atomicWrite(settingsPath,JSON.stringify({version:1,enabled:next}));enabled=next;if(!next)active?.controller.abort();return status();});saveQueue=operation.catch(()=>{});return operation;
  }
  async function start(kind,input){
    await ready;guard(input.expectedEpoch);if(active)throw ocrError('OCR_BUSY','已有 OCR 安装或自检正在进行。',409);
    if(!['install','selftest'].includes(kind))throw ocrError('OCR_ACTION_INVALID','OCR 动作无效。');
    if(kind==='install'&&(input.confirmed!==true||input.previewId!==ocrInstallPreview(assetDir).previewId))throw ocrError('OCR_INSTALL_CONFIRMATION','请确认本次下载上限与本机安装位置。');
    if(kind==='selftest'&&(!enabled||!(await inspectAssets({assetDir})).available))throw ocrError('OCR_ASSETS_MISSING','英语 OCR 尚未安装并启用；基础练习仍可使用。',503);
    guard(input.expectedEpoch);if(active)throw ocrError('OCR_BUSY','已有 OCR 作业正在进行。',409);
    const op={id:crypto.randomUUID(),kind,state:'running',controller:new AbortController()};active=op;
    op.done=(async()=>{
      try{
        if(kind==='install')op.result=await installLanguage({assetDir,confirmed:input.confirmed,previewId:input.previewId,signal:op.controller.signal});
        else{
          const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(1100,280),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1100,280);ctx.fillStyle='black';ctx.font='36px Arial';ctx.fillText('The red door is NOT open.',40,100);ctx.fillText('Original local OCR self-test 27.',40,190);
          const bytes=canvas.toBuffer('image/png'),id=hash(bytes);await fs.mkdir(artifactDir,{recursive:true});const inputPath=path.join(artifactDir,id);try{await fs.writeFile(inputPath,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
          const worker=createWorker({assetDir,artifactDir,inspectAssets,resolveAsset:async assetId=>{if(assetId!==id)throw ocrError('OCR_INPUT_INVALID','自检资产无效。');return {path:inputPath,hash:id,size:bytes.length};},checkGuard:async()=>{guard(input.expectedEpoch);if(op.controller.signal.aborted)throw ocrError('OCR_CANCELLED','OCR 自检已取消。',409);}});
          const result=await worker.runMaterialTool({jobId:op.id,expectedEpoch:input.expectedEpoch,sourceRevision:id,toolId:'document.ocr',inputAssetIds:[id],parameters:{pages:[{page:1}],language:'eng'},budget:{timeoutMs:60000,maxPages:1,maxPixels:1000000,maxOutputBytes:4*1024*1024,maxMemoryBytes:768*1024*1024},cancelToken:op.controller.signal});
          const record=result.evidence.find(e=>e.state==='needs_review');const evidence=record?JSON.parse(await fs.readFile(path.join(artifactDir,record.ref),'utf8')):null;
          op.result={...result,recognizedText:evidence?.text||'',wordCount:evidence?.words.length||0,engine:evidence?.engine||null,expectedText:'The red door is NOT open.\nOriginal local OCR self-test 27.',accuracyClaim:false};
          if(!record)throw ocrError('OCR_SELFTEST_EMPTY','自检未产生可审阅的文字与坐标。',422);
        }
        guard(input.expectedEpoch);if(op.controller.signal.aborted)throw ocrError('OCR_CANCELLED','OCR 操作已取消。',409);op.state='completed';op.detail=kind==='install'?'英语语言数据已安装；请单独启用后运行自检。':'真实英语 OCR 自检完成；请检查文字和词框，结果不代表材料识别准确率。';
      }catch(e){op.state=op.controller.signal.aborted?'cancelled':'failed';op.code=e.code||'OCR_OPERATION_FAILED';op.detail=e.status?e.message:'OCR 操作未完成；原件与基础练习不受影响。';}
      finally{if(active===op){active=null;last=op;}}
    })();
    return {operation:publicOperation(op),expectedEpoch:input.expectedEpoch};
  }
  async function cancel({operationId,expectedEpoch}={}){guard(expectedEpoch);if(active&&active.id!==operationId)throw ocrError('OCR_OPERATION_STALE','OCR 作业已改变，请刷新状态。',409);active?.controller.abort();return {cancelRequested:Boolean(active)};}
  async function close(){active?.controller.abort();await active?.done;await saveQueue;}
  async function reset(){await close();last=null;}
  return {ready,status,configure,start,cancel,close,reset,assetDir,artifactDir};
}
