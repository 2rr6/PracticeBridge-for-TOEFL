import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {OCR_PACKAGES,OCR_LIMITS,DEFAULT_RUNTIME_LOCK,hash,ocrError} from './ocr-policy.mjs';

const unzip=promisify(gunzip);
const LANGUAGE_ENTRY='package/4.0.0/eng.traineddata.gz';
export function ocrInstallPreview(assetDir){
  const value={version:1,language:'eng',package:OCR_PACKAGES[2],languageEntry:LANGUAGE_ENTRY,destination:assetDir,downloadLimitBytes:OCR_LIMITS.downloadBytes,unpackedPackageBytes:13876967,downloadSizeKnown:false,networkAction:'download_public_language_only',runtimePackages:OCR_PACKAGES.slice(0,2).map(p=>({name:p.name,version:p.version,delivery:'application_runtime'}))};
  return {...value,previewId:hash(Buffer.from(JSON.stringify(value)))};
}

export async function languageFromArchive(bytes){
  const expected=OCR_PACKAGES[2].integrity.slice(7);if(crypto.createHash('sha512').update(bytes).digest('base64')!==expected)throw ocrError('OCR_DOWNLOAD_INTEGRITY','英语 OCR 下载校验失败，未安装。',422);
  const tar=await unzip(bytes,{maxOutputLength:20*1024*1024});let found=null,entries=0;
  for(let offset=0;offset+512<=tar.length;){
    const header=tar.subarray(offset,offset+512);if(header.every(b=>b===0))break;
    if(++entries>1000)throw ocrError('OCR_ARCHIVE_INVALID','OCR 安装包条目过多。',422);
    const str=(a,b)=>header.subarray(a,b).toString('utf8').replace(/\0.*$/s,'');
    const checksum=Number.parseInt(str(148,156).trim(),8);let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];
    const name=[str(345,500),str(0,100)].filter(Boolean).join('/'),size=Number.parseInt(str(124,136).trim(),8),type=str(156,157)||'0';
    if(sum!==checksum||!Number.isSafeInteger(size)||size<0||size>16*1024*1024||offset+512+size>tar.length||name.includes('\\')||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.')||!['0','5'].includes(type))throw ocrError('OCR_ARCHIVE_INVALID','OCR 安装包格式无效。',422);
    if(name===LANGUAGE_ENTRY){if(found||type!=='0')throw ocrError('OCR_ARCHIVE_INVALID','OCR 语言数据重复或无效。',422);found=tar.subarray(offset+512,offset+512+size);}
    offset+=512+Math.ceil(size/512)*512;
  }
  if(!found||found[0]!==0x1f||found[1]!==0x8b)throw ocrError('OCR_ARCHIVE_INVALID','OCR 安装包缺少已指定的英语语言数据。',422);
  // Verify the nested compressed file is bounded before any inference loads it.
  await unzip(found,{maxOutputLength:32*1024*1024});return Buffer.from(found);
}

/** Only called by the explicit, preview-bound install command. No redirects,
 * fallback hosts, package scripts, system installation or private payload. */
export async function installOcrLanguage({assetDir,previewId,confirmed,signal,fetchImpl=fetch,runtimeLockPath=DEFAULT_RUNTIME_LOCK}={}){
  if(confirmed!==true||previewId!==ocrInstallPreview(assetDir).previewId)throw ocrError('OCR_INSTALL_CONFIRMATION','请确认本次下载上限与本机安装位置。');
  let lock;try{lock=JSON.parse(await fs.readFile(runtimeLockPath,'utf8'));}catch{throw ocrError('OCR_RUNTIME_UNAVAILABLE','本版本缺少已校验的 OCR 运行组件；尚未开始下载。',503);}
  if(lock.version!==1||lock.packageVersion!=='7.0.0'||!(/^[a-f0-9]{64}$/).test(lock.languageHash||''))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 运行清单尚未完成验证；尚未开始下载。',503);
  const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)]);
  const response=await fetchImpl(OCR_PACKAGES[2].url,{method:'GET',redirect:'error',signal:combined,headers:{Accept:'application/octet-stream'}});
  if(!response.ok||!response.body)throw ocrError('OCR_DOWNLOAD_FAILED','英语 OCR 下载失败；未切换服务。',503);
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>OCR_LIMITS.downloadBytes){await response.body.cancel();throw ocrError('OCR_DOWNLOAD_LIMIT','OCR 下载超过已确认上限。',413);}
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>OCR_LIMITS.downloadBytes)throw ocrError('OCR_DOWNLOAD_LIMIT','OCR 下载超过已确认上限。',413);chunks.push(chunk);}
  const language=await languageFromArchive(Buffer.concat(chunks));if(hash(language)!==lock.languageHash)throw ocrError('OCR_DOWNLOAD_INTEGRITY','OCR 语言数据不符合本版本清单。',422);
  if(combined.aborted)throw ocrError('OCR_CANCELLED','OCR 安装已取消。',409);
  await fs.mkdir(assetDir,{recursive:true});const directoryStat=await fs.lstat(assetDir);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink())throw ocrError('OCR_ASSET_INVALID','OCR 安装目录无效。',503);const stage=await fs.mkdtemp(path.join(assetDir,'.install-'));
  try{
    await fs.writeFile(path.join(stage,'eng.traineddata.gz'),language,{flag:'wx'});
    const receipt={version:1,language:'eng',languageHash:hash(language),packageIntegrity:OCR_PACKAGES[2].integrity,downloadBytes:total,installedAt:new Date().toISOString()};
    await fs.writeFile(path.join(stage,'installation.json'),JSON.stringify(receipt),{flag:'wx'});
    if(combined.aborted)throw ocrError('OCR_CANCELLED','OCR 安装已取消。',409);
    await fs.rename(path.join(stage,'eng.traineddata.gz'),path.join(assetDir,'eng.traineddata.gz'));
    await fs.rename(path.join(stage,'installation.json'),path.join(assetDir,'installation.json'));
    return receipt;
  }finally{const root=path.resolve(assetDir),target=path.resolve(stage);if(!target.startsWith(root+path.sep)||!path.basename(target).startsWith('.install-'))throw Error('OCR installer cleanup boundary invalid');await fs.rm(target,{recursive:true,force:true});}
}
