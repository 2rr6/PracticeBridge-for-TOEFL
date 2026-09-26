import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyReadme} from '../scripts/verify-readme.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const parent=path.resolve('test-results/readme-contract');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'run-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),parent);await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'docs/development'),{recursive:true});
  const pkg={version:'0.5.0',scripts:{test:'node --test tests/*.test.mjs'}},readme='# Self-authored fixture\n\n这是独立实现的 **0.5.0 本地练习软件**。\n\n[Guide](docs/guide.md)\n';
  const policy={source:['package.json','README.md','docs/guide.md','docs/development/README_FACTS.json','docs/development/release-policy.json']};
  const files={'package.json':JSON.stringify(pkg)+'\n','README.md':readme,'docs/guide.md':'A self-authored public guide.\n','docs/development/release-policy.json':JSON.stringify(policy)+'\n'};
  for(const [name,content] of Object.entries(files))await fs.writeFile(path.join(root,name),content);
  const facts={sourceSnapshot:{packageVersion:pkg.version,sourceFiles:Object.entries(files).map(([name,content])=>({path:name,bytes:Buffer.byteLength(content),sha256:sha(content),text:true,canonicalLfSha256:sha(content)}))},product:{id:'product',evidence:['package.json','README.md']},commands:[{id:'command-test',command:'npm test',expandsTo:pkg.scripts.test,evidence:'package.json'}],writingSelection:{id:'writing',modelInvoked:false,actualModel:null}};
  const saveFacts=()=>fs.writeFile(path.join(root,'docs/development/README_FACTS.json'),JSON.stringify(facts));await saveFacts();
  return {root,files,facts,saveFacts,refresh:async name=>{const bytes=await fs.readFile(path.join(root,name)),entry=facts.sourceSnapshot.sourceFiles.find(file=>file.path===name);Object.assign(entry,{bytes:bytes.length,sha256:sha(bytes),canonicalLfSha256:sha(bytes.toString('utf8').replaceAll('\r\n','\n'))});await saveFacts();}};
}

test('README contract accepts current facts and explicitly declared checkout text normalization',async t=>{
  const f=await fixture(t);const result=await verifyReadme({root:f.root});assert.equal(result.version,'0.5.0');assert.equal(result.externalWritingPerformed,false);
  await fs.writeFile(path.join(f.root,'docs/guide.md'),f.files['docs/guide.md'].replaceAll('\n','\r\n'));assert.equal((await verifyReadme({root:f.root})).ok,true);
});

test('README contract rejects stale source bytes before trusting a copied fact record',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'docs/guide.md'),'Changed factual meaning.\n');await assert.rejects(verifyReadme({root:f.root}),/source facts are stale/);
});

test('README contract rejects version drift, command drift and invented external authorship',async t=>{
  const f=await fixture(t);f.facts.sourceSnapshot.packageVersion='0.4.1';await f.saveFacts();await assert.rejects(verifyReadme({root:f.root}),/different package version/);
  f.facts.sourceSnapshot.packageVersion='0.5.0';f.facts.commands[0].expandsTo='node nonexistent.mjs';await f.saveFacts();await assert.rejects(verifyReadme({root:f.root}),/command is stale/);
  f.facts.commands[0].expandsTo='node --test tests/*.test.mjs';f.facts.writingSelection.actualModel='invented-model';await f.saveFacts();await assert.rejects(verifyReadme({root:f.root}),/unperformed external writing/);
});

test('README contract refuses private evidence and local links outside the publication list',async t=>{
  const f=await fixture(t);f.facts.sourceSnapshot.sourceFiles.push({path:'data/state.json',bytes:0,sha256:sha('')});await f.saveFacts();await assert.rejects(verifyReadme({root:f.root}),/outside the reviewed source publication list/);
  f.facts.sourceSnapshot.sourceFiles.pop();await f.saveFacts();await fs.appendFile(path.join(f.root,'README.md'),'\n[Unpublished](docs/private-review.md)\n');await f.refresh('README.md');await assert.rejects(verifyReadme({root:f.root}),/link is outside the reviewed source list/);
});

test('README contract rejects duplicate fact identifiers and unsupported claims retained from the old README',async t=>{
  const f=await fixture(t);f.facts.extra={id:'product'};await f.saveFacts();await assert.rejects(verifyReadme({root:f.root}),/duplicate fact id/);
  delete f.facts.extra;await f.saveFacts();await fs.appendFile(path.join(f.root,'README.md'),'\n密钥仅保留在应用进程内存，退出后需要重新填写。\n');await f.refresh('README.md');await assert.rejects(verifyReadme({root:f.root}),/obsolete capability statement/);
});
