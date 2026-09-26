import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateOcrRequest,inspectOcrAssets,assertOcrCoreSelection,OCR_CORE_FILES,OCR_LIMITS,hash,ocrError } from '../ocr-policy.mjs';
import { projectOcrEvidence } from '../ocr-evidence.mjs';
import {createOcrLaunchSpec,verifyOcrLaunchSpec,validateOcrLaunchSpec,ocrLaunchForJob,ocrLaunchEnvironment} from '../ocr-launch.mjs';

const CHILD=fileURLToPath(new URL('./ocr-child.mjs',import.meta.url));
export const ocrEnvironment=ocrLaunchEnvironment;

/** RSS includes Node worker threads and native allocations. Sampling plus kill
 * is an operational limit, not an OS hard memory quota or a network sandbox. */
export function runOcrProcess({config,signal,executable=process.execPath,childPath=CHILD,spawnProcess=spawn,environment=process.env}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(ocrError('OCR_CANCELLED','OCR 已取消。',409));return;}
    const launchSpec=config.launchSpec;
    if(launchSpec){try{validateOcrLaunchSpec(launchSpec);if(launchSpec.writableJobDir!==config.outputDir)throw Error();}catch{reject(ocrError('OCR_LAUNCH_INVALID','OCR 作业与固定启动规格不一致。',503));return;}executable=launchSpec.executable;childPath=launchSpec.entryPath;}
    else if(childPath===CHILD){reject(ocrError('OCR_LAUNCH_INVALID','OCR 缺少宿主固定启动规格。',503));return;}
    const env=ocrEnvironment(environment);if(process.versions.electron)env.ELECTRON_RUN_AS_NODE='1';
    let child,monitor,monitorTimer,timer,failure,finished=false,sent=false,outputBytes=0,monitorBytes=0,rssPeak=0,monitorText='';const output=[];
    const stop=e=>{if(finished||failure)return;failure=e;try{child?.kill('SIGKILL');}catch{}};
    const sample=rss=>{if(!Number.isFinite(rss)||rss<1){stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','无法监视 OCR 进程资源，已停止本次处理。',503));return;}rssPeak=Math.max(rssPeak,rss);if(rss>config.budget.maxMemoryBytes){stop(ocrError('OCR_MEMORY_LIMIT','OCR 进程内存超过本次预算，已停止。',413));return;}if(!sent&&!failure&&!finished){sent=true;child.stdin.end(JSON.stringify(config));}};
    const cleanup=()=>{clearTimeout(timer);clearInterval(monitorTimer);signal?.removeEventListener('abort',abort);try{monitor?.kill('SIGKILL');}catch{}};
    const abort=()=>stop(ocrError('OCR_CANCELLED','OCR 已取消。',409));
    try{child=spawnProcess(executable,['--max-old-space-size=256',childPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env,...(launchSpec?{cwd:launchSpec.cwd}:{})});}
    catch{reject(ocrError('OCR_RUNTIME_UNAVAILABLE','无法启动本机 OCR 进程。',503));return;}
    child.on('error',()=>{failure=ocrError('OCR_RUNTIME_UNAVAILABLE','无法启动本机 OCR 进程。',503);});
    child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>config.budget.maxOutputBytes)stop(ocrError('OCR_OUTPUT_LIMIT','OCR 文字输出超过本次预算。',413));else output.push(chunk);});
    child.stderr.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>config.budget.maxOutputBytes)stop(ocrError('OCR_OUTPUT_LIMIT','OCR 输出超过本次预算。',413));});
    child.stdin.on('error',()=>{});
    child.once('spawn',()=>{
      if(signal?.aborted){abort();return;}
      if(process.platform==='win32'){
        const windowsRoot=environment.SystemRoot||environment.SYSTEMROOT||environment.windir||'C:\\Windows';
        const powershell=path.join(windowsRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
        // The only interpolated value is the owned positive numeric PID.
        const command=`$ErrorActionPreference='Stop'; while ($true) { try { $ocrProcess=[System.Diagnostics.Process]::GetProcessById(${child.pid}); $ocrProcess.Refresh(); [Console]::WriteLine($ocrProcess.WorkingSet64); $ocrProcess.Dispose() } catch { exit 0 }; Start-Sleep -Milliseconds 200 }`;
        try{monitor=spawnProcess(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
          monitor.on('error',()=>stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视不可用。',503)));
          monitor.stdout.on('data',chunk=>{monitorText+=chunk;monitorBytes+=chunk.length;if(monitorBytes>128*1024){stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视输出异常。',503));return;}const lines=monitorText.split(/\r?\n/);monitorText=lines.pop();for(const line of lines)if(line.trim())sample(Number(line));});
          monitor.stderr.on('data',()=>stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视失败。',503)));
          monitor.on('exit',()=>{if(!finished&&child.exitCode===null)stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视提前退出。',503));});
        }catch{stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视不可用。',503));}
      }else if(process.platform==='linux'){
        monitorTimer=setInterval(async()=>{try{const s=await fs.readFile(`/proc/${child.pid}/status`,'utf8');sample(Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024);}catch(e){if(e.code!=='ENOENT')stop(ocrError('OCR_RESOURCE_MONITOR_FAILED','OCR 资源监视失败。',503));}},200);
      }else{stop(ocrError('OCR_RESOURCE_MONITOR_UNAVAILABLE','此平台暂未验证 OCR 资源监视。',503));}
    });
    timer=setTimeout(()=>stop(ocrError('OCR_TIMEOUT','OCR 超时；原件与其他已保存证据仍保留。',408)),config.budget.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('close',code=>{
      if(finished)return;finished=true;cleanup();if(failure){reject(failure);return;}
      if(code!==0){reject(ocrError('OCR_WORKER_FAILED','OCR 进程未完成；这项能力暂不可用。',422));return;}
      try{const value=JSON.parse(Buffer.concat(output).toString('utf8'));if(value.version!==1||!Array.isArray(value.results)||value.results.length>OCR_LIMITS.maxPages)throw Error();resolve({...value,rssPeak,memoryPolicy:'sampled_process_rss_with_termination'});}
      catch{reject(ocrError('OCR_PROTOCOL_INVALID','OCR 返回内容无效。',422));}
    });
  });
}

async function publishCas(dir,bytes){
  const ref=hash(bytes),target=path.join(dir,ref),temp=path.join(dir,`.ocr-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp,bytes,{flag:'wx'});
  try{await fs.link(temp,target);}catch(e){if(e.code!=='EEXIST')throw e;const existing=await fs.readFile(target);if(hash(existing)!==ref)throw ocrError('OCR_ARTIFACT_INVALID','已有 OCR 证据校验失败。',500);}
  finally{await fs.unlink(temp);}
  return ref;
}

/** Host-only asset resolver and guard are mandatory. T06 owns consent, scope,
 * generation and publication transactions; this helper never writes state. */
export function createOcrWorker({assetDir,artifactDir,resolveAsset,checkGuard,launchSpec,inspectAssets=inspectOcrAssets,runProcess=runOcrProcess}={}){
  if(!path.isAbsolute(assetDir||'')||!path.isAbsolute(artifactDir||'')||typeof resolveAsset!=='function'||typeof checkGuard!=='function')throw TypeError('OCR requires host-owned directories, asset resolution and scope guard.');
  return {async runMaterialTool(input){
    const r=validateOcrRequest(input);await checkGuard(r);
    const asset=await resolveAsset(r.inputAssetIds[0],r);
    if(!asset||!path.isAbsolute(asset.path||'')||asset.hash!==r.inputAssetIds[0]||!Number.isInteger(asset.size)||asset.size<1||asset.size>OCR_LIMITS.maxInputBytes)throw ocrError('OCR_INPUT_INVALID','OCR 资产不属于此材料或超过大小限制。');
    const stat=await fs.lstat(asset.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size)throw ocrError('OCR_INPUT_INVALID','OCR 原件无效。');
    const bytes=await fs.readFile(asset.path);if(hash(bytes)!==asset.hash)throw ocrError('OCR_INPUT_INVALID','OCR 原件完整性校验失败。');
    const pdf=bytes.subarray(0,1024).includes(Buffer.from('%PDF-')),png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    // PNG dimensions can be bounded before native decoding. Other standalone
    // image containers are intentionally unavailable until equally bounded.
    if(!pdf&&!png)throw ocrError('OCR_INPUT_UNSUPPORTED','本机 OCR 当前接受 PDF 或 PNG 原图。',422);
    if(png&&(bytes.length<24||bytes.readUInt32BE(16)*bytes.readUInt32BE(20)>r.budget.maxPixels))throw ocrError('OCR_PIXEL_LIMIT','PNG 解码像素超过本次预算。',413);
    await fs.mkdir(artifactDir,{recursive:true});const directoryStat=await fs.lstat(artifactDir);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink())throw ocrError('OCR_ARTIFACT_INVALID','OCR 证据目录无效。',500);const outputDir=await fs.mkdtemp(path.join(artifactDir,'.ocr-run-'));
    try{
      const spec=ocrLaunchForJob(launchSpec||await createOcrLaunchSpec(),outputDir),verifiedLaunch=await verifyOcrLaunchSpec(spec);
      // Rendering uses native canvas/PDF code even when the optional language
      // is absent. Its fixed code closure is verified before every child starts.
      const assets=await inspectAssets({assetDir,launchSpec:spec,verifiedLaunch});
      await checkGuard(r);if(r.cancelToken?.aborted)throw ocrError('OCR_CANCELLED','OCR 已取消。',409);
      const output=await runProcess({signal:r.cancelToken,config:{launchSpec:spec,inputPath:asset.path,assetId:asset.hash,pages:r.parameters.pages,budget:r.budget,toolId:r.toolId,outputDir,assets:assets.available?{runtimeRoot:assets.runtimeRoot,modulePath:assets.modulePath,assetDir:assets.assetDir,coreFiles:assets.files.filter(file=>OCR_CORE_FILES.includes(file.name)).map(file=>({name:file.name,sha256:file.sha256}))}:null}});
      await checkGuard(r);if(r.cancelToken?.aborted)throw ocrError('OCR_CANCELLED','OCR 已取消。',409);
      const artifactRefs=[],evidence=[],issues=[];let publishedBytes=0;
      for(const page of output.results){
        if(!r.parameters.pages.some(p=>p.page===page.page))throw ocrError('OCR_PROTOCOL_INVALID','OCR 返回了范围外页面。',422);
        let imageRef=null;
        if(page.imageName){
          if(page.imageName!==`page-${page.page}.png`)throw ocrError('OCR_PROTOCOL_INVALID','OCR 图像输出名称无效。',422);
          const imagePath=path.join(outputDir,page.imageName),s=await fs.lstat(imagePath);if(!s.isFile()||s.isSymbolicLink()||s.size>r.budget.maxOutputBytes)throw ocrError('OCR_PROTOCOL_INVALID','OCR 图像输出无效。',422);
          const image=await fs.readFile(imagePath);if(hash(image)!==page.imageHash)throw ocrError('OCR_PROTOCOL_INVALID','OCR 图像校验失败。',422);
          publishedBytes+=image.length;if(publishedBytes>r.budget.maxOutputBytes)throw ocrError('OCR_OUTPUT_LIMIT','OCR 图像和证据合计超过本次预算。',413);
          imageRef=await publishCas(artifactDir,image);artifactRefs.push({ref:imageRef,kind:'page-image',mime:'image/png',page:page.page,size:image.length});
        }
        const source={assetId:asset.hash,sourceRevision:r.sourceRevision,page:page.page,region:page.region||null,pixelRect:page.pixelRect||null,pageDimensions:page.pageDimensions||null,imageRef,width:page.width||null,height:page.height||null};
        let value;
        if(page.state==='recognized'){
          const core=assertOcrCoreSelection(page,assets.files);
          value=projectOcrEvidence({data:page.data,source,textLayer:page.textLayer,engine:{backend:'tesseract.js',packageVersion:'7.0.0',language:'eng',languageVersion:'1.0.0',languageHash:assets.language.sha256,runtimeLockHash:assets.runtimeLockHash,launchLockHash:spec.launchLockHash,launchProfile:spec.profile,...core,device:'cpu'}});
        }else value={version:1,kind:'document-region-evidence',state:page.state,source,textLayer:page.textLayer||'',ocrCalled:page.ocrCalled===true,issues:page.code?[{code:page.code,reason:'此页 OCR 暂不可用；原件与已保存页面仍保留。'}]:[]};
        if(page.partialTextItems)value.issues.unshift({code:'ocr_region_partial_text',reason:'选区只覆盖了部分文字项；未读取项内选区外文字，请对照选区原图核对边界。'});
        const json=Buffer.from(JSON.stringify(value));publishedBytes+=json.length;if(publishedBytes>r.budget.maxOutputBytes)throw ocrError('OCR_OUTPUT_LIMIT','OCR 证据超过本次预算。',413);
        const ref=await publishCas(artifactDir,json);artifactRefs.push({ref,kind:value.kind,page:page.page,size:json.length});evidence.push({ref,page:page.page,state:value.state,imageRef});issues.push(...value.issues.map(i=>({...i,page:page.page,evidenceRef:ref})));
      }
      await checkGuard(r);if(r.cancelToken?.aborted)throw ocrError('OCR_CANCELLED','OCR 已取消。',409);
      return {artifactRefs,evidence,issues,actualEngine:output.results.some(p=>p.ocrCalled)?'tesseract.js@7.0.0':output.renderEngine,actualDevice:'cpu',state:evidence.some(e=>['needs_review','text_layer','rendered'].includes(e.state))?'completed':'unavailable',rssPeak:output.rssPeak,memoryPolicy:output.memoryPolicy,networkPolicy:'no_active_network_requests'};
    }finally{const resolved=path.resolve(outputDir);if(!resolved.startsWith(path.resolve(artifactDir)+path.sep)||!path.basename(resolved).startsWith('.ocr-run-'))throw Error('OCR cleanup boundary invalid');await fs.rm(resolved,{recursive:true,force:true});}
  }};
}
