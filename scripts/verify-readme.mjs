import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error('README contract: '+message);};

// These are factual consistency and file-boundary checks, not an automated
// judgment of prose, model quality, licensing or every possible false claim.
export async function verifyReadme({root=project}={}){
  root=path.resolve(root);
  const read=async name=>{
    if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('unsafe local evidence path');
    const target=path.resolve(root,name),actual=await fs.realpath(target),relative=path.relative(root,actual);
    if(relative.startsWith('..')||path.isAbsolute(relative)||(await fs.lstat(target)).isSymbolicLink())fail('redirected local evidence path');
    return fs.readFile(target);
  };
  const [packageBytes,readmeBytes,factsBytes,policyBytes]=await Promise.all(['package.json','README.md','docs/development/README_FACTS.json','docs/development/release-policy.json'].map(read));
  const pkg=JSON.parse(packageBytes),readme=readmeBytes.toString('utf8'),facts=JSON.parse(factsBytes),policy=JSON.parse(policyBytes),allowed=new Set(policy.source);
  if(facts.sourceSnapshot?.packageVersion!==pkg.version)fail('facts use a different package version');
  const sourceFiles=facts.sourceSnapshot?.sourceFiles;
  if(!Array.isArray(sourceFiles)||!sourceFiles.length||new Set(sourceFiles.map(file=>file.path)).size!==sourceFiles.length)fail('missing or duplicate source snapshot entries');
  const sourcePaths=new Set(sourceFiles.map(file=>file.path));
  for(const file of sourceFiles){
    if(!allowed.has(file.path))fail('evidence is outside the reviewed source publication list: '+file.path);
    const bytes=await read(file.path),exact=bytes.length===file.bytes&&hash(bytes)===file.sha256;
    const textMatch=file.text===true&&/^[a-f0-9]{64}$/.test(file.canonicalLfSha256||'')&&hash(bytes.toString('utf8').replaceAll('\r\n','\n'))===file.canonicalLfSha256;
    if(!exact&&!textMatch)fail('source facts are stale: '+file.path);
  }
  for(const name of ['package.json','README.md','docs/development/release-policy.json'])if(!sourcePaths.has(name))fail('required source snapshot missing: '+name);
  const ids=new Set();
  const visit=value=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(typeof value.id==='string'){if(ids.has(value.id))fail('duplicate fact id: '+value.id);ids.add(value.id);}
    if(value.evidence!==undefined)for(const name of Array.isArray(value.evidence)?value.evidence:[value.evidence])if(!sourcePaths.has(name))fail('fact evidence lacks a source snapshot: '+name);
    Object.values(value).forEach(visit);
  };
  visit(facts);
  if(!ids.size)fail('no reusable fact identifiers');
  for(const command of facts.commands||[]){
    const match=/^npm (?:run )?([\w:-]+)$/.exec(command.command||'');
    if(!match||pkg.scripts?.[match[1]]!==command.expandsTo)fail('documented package command is stale: '+command.command);
  }
  const localLinks=[];
  for(const match of readme.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g)){
    const href=match[1].replace(/^<|>$/g,'');if(/^(https?:|#)/.test(href))continue;
    if(/^[a-z][a-z0-9+.-]*:/i.test(href))fail('unsupported documentation link scheme');
    const name=decodeURIComponent(href.split('#')[0]);if(!allowed.has(name))fail('local README link is outside the reviewed source list: '+name);await read(name);localLinks.push(name);
  }
  for(const obsolete of ['密钥仅保留在应用进程内存，退出后需要重新填写。','当前不包含扫描件 OCR、自动语音转写'])if(readme.includes(obsolete))fail('obsolete capability statement remains');
  const selection=facts.writingSelection;
  if(selection?.modelInvoked===false&&selection.actualModel!==null)fail('unperformed external writing cannot have an actual model');
  if(selection?.modelInvoked===false&&/由\s*Antigravity\s*(?:撰写|生成)/i.test(readme))fail('unperformed external writing is attributed to Antigravity');
  return {ok:true,version:pkg.version,sourceFiles:sourceFiles.length,factIds:ids.size,localLinks:localLinks.length,packageCommands:(facts.commands||[]).length,externalWritingPerformed:selection?.modelInvoked===true,scope:'Version, fact-source bytes or explicit text normalization, fact IDs, command expansion and local links; human semantic review remains required.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw Error('Usage: node scripts/verify-readme.mjs');
  verifyReadme().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
