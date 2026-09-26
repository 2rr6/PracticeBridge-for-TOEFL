import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {extractAll} from '@electron/asar';
import {ZipReader,Uint8ArrayReader,Uint8ArrayWriter} from '@zip.js/zip.js';
import {projectRoot,json,sha256,distPath,auditAsar,auditSource,auditDirectory,validateInventory,loadPolicy} from './audit-release.mjs';
const [mode,input,offline,...extra]=process.argv.slice(2);
if(!['--source','--app'].includes(mode)||extra.length||(offline&&offline!=='--offline'))throw new Error('Usage: node scripts/security-release.mjs --source dist/FILE.zip | --app dist/APP [--offline]');
const root=projectRoot,target=await distPath(input),tools=await json(resolve(root,'docs/development/release-tools.json'));
const inventory=await json(mode==='--source'?`${target}.inventory.json`:resolve(dirname(target),'runtime-inventory.json'));
validateInventory(inventory,mode==='--source'?'source':'runtime',await loadPolicy(),mode==='--app'?(await json(resolve(root,'docs/development/runtime-dependencies.json'))).files:[]);
const out=await mkdtemp(resolve(root,'dist/security-')),content=resolve(out,'actual-content');await mkdir(content);
let artifact;
if(mode==='--source'){
 artifact=await auditSource(target,inventory);
 const reader=new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(target))));
 try{for(const entry of await reader.getEntries())if(!entry.directory){const path=resolve(content,entry.filename);await mkdir(dirname(path),{recursive:true});await writeFile(path,await entry.getData(new Uint8ArrayWriter()),{flag:'wx'});}}finally{await reader.close();}
}else{
 artifact=await auditAsar(resolve(target,'resources/app.asar'),inventory);
 await auditDirectory(target,await json(resolve(dirname(target),'application-inventory.json')));
 extractAll(resolve(target,'resources/app.asar'),content);
}
const toolDir=resolve(process.env.PRACTICEBRIDGE_RELEASE_TOOLS??resolve(root,'.cache/tools'));
const npmCli=process.env.PRACTICEBRIDGE_NPM_CLI??resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const run=(exe,args)=>spawnSync(exe,args,{cwd:content,encoding:'utf8',windowsHide:true,shell:false,maxBuffer:32*1024*1024,timeout:180000});
const results=[],startedAt=new Date().toISOString();
function record(name,result){const output=(result.stdout??'')+(result.stderr??'')+(result.error?.message??'');const exitCode=result.status;const status=exitCode===0?'passed':name==='gitleaks'&&exitCode===10||name==='osv'&&exitCode===1?'findings':'error';results.push({name,status,exitCode,log:`${name}.txt`,logSha256:sha256(output)});return writeFile(resolve(out,`${name}.txt`),output);}
const npmVersion=run(process.execPath,[npmCli,'--version']);
if(npmVersion.status!==0||npmVersion.stdout.trim()!==tools.npm.version)throw new Error(`Use fixed npm ${tools.npm.version} via PRACTICEBRIDGE_NPM_CLI; no automatic installation`);
const sbom=run(process.execPath,[npmCli,'sbom',...(mode==='--source'?['--package-lock-only']:['--omit=dev']),'--sbom-format=cyclonedx']);await record('npm-sbom',sbom);
if(sbom.status===0){JSON.parse(sbom.stdout);await writeFile(resolve(out,'dependencies.cdx.json'),sbom.stdout);}
for(const [name,spec,filename] of [['gitleaks',tools.gitleaks,`gitleaks-${tools.gitleaks.version}${process.platform==='win32'?'.exe':''}`],['osv',tools.osv,`osv-scanner-${tools.osv.version}${process.platform==='win32'?'.exe':''}`]]){
 const exe=resolve(toolDir,filename);
 try{
  const bytes=await readFile(exe),expected=process.platform==='win32'?spec.windowsExecutableSha256:spec.linuxExecutableSha256;
  if(!expected)throw new Error(`No reviewed ${name} executable hash for ${process.platform}; register the executable from the pinned official archive before running it`);
  if(sha256(bytes)!==expected)throw new Error(`${name} executable checksum mismatch`);
  const version=run(exe,[name==='gitleaks'?'version':'--version']);
  if(version.status!==0||!(version.stdout+version.stderr).includes(spec.version))throw new Error(`${name} version mismatch`);
  let result;
  if(name==='gitleaks')result=run(exe,['dir',content,'--redact','--no-banner','--exit-code','10','--report-format','json','--report-path',resolve(out,'gitleaks.json')]);
  else if(sbom.status===0)result=run(exe,['scan','source','--no-resolve','--no-call-analysis=all',...(offline?['--offline']:[]),'--lockfile',resolve(out,'dependencies.cdx.json'),'--format','json','--output-file',resolve(out,'osv.json')]);
  else result={status:null,error:new Error('SBOM generation failed; dependency advisory scan was not performed')};
  await record(name,result);
 }catch(error){await record(name,{status:null,error});}
}
const evidenceFiles=[];for(const file of ['dependencies.cdx.json','gitleaks.json','osv.json']){try{const bytes=await readFile(resolve(out,file));evidenceFiles.push({path:file,bytes:bytes.length,sha256:sha256(bytes)});}catch{}}
const summary={schemaVersion:1,mode,input,artifact,inventoryCanonicalSha256:sha256(JSON.stringify(inventory)),startedAt,finishedAt:new Date().toISOString(),offline:Boolean(offline),tools:{npm:tools.npm.version,gitleaks:tools.gitleaks.version,osv:tools.osv.version},results,evidenceFiles,ok:results.every(r=>r.status==='passed')};
await writeFile(resolve(out,'security-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));console.log('SECURITY_DIR '+out);if(!summary.ok)process.exitCode=1;
