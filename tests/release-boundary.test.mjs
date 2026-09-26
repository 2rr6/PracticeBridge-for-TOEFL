import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, cp, access, symlink} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ZipReader, Uint8ArrayReader} from '@zip.js/zip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture() {
  await mkdir(resolve(root, 'test-results'), {recursive:true});
  const dir = await mkdtemp(resolve(root, 'test-results/release-boundary-'));
  for (const name of ['src/archive','public','desktop','scripts','tests','docs/development']) await mkdir(resolve(dir,name),{recursive:true});
  for (const name of ['scripts/release-source.mjs','src/archive/zip-adapter.mjs']) await cp(resolve(root,name),resolve(dir,name));
  for (const name of ['scripts/audit-release.mjs']) {
    try {await access(resolve(root,name));} catch {continue;}
    await cp(resolve(root,name),resolve(dir,name));
  }
  await writeFile(resolve(dir,'docs/development/release-policy.json'),JSON.stringify({version:1,runtime:['package.json','src/archive/zip-adapter.mjs'],source:['README.md','package.json','src/archive/zip-adapter.mjs'],unpacked:[],coverageRoots:[],assets:[]}));
  for (const name of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','package-lock.json','.gitignore','.gitattributes','.editorconfig','打开练习工作台.cmd']) await writeFile(resolve(dir,name),'synthetic fixture\n');
  await writeFile(resolve(dir,'package.json'),JSON.stringify({name:'synthetic-release',version:'0.0.0',type:'module',scripts:{test:'node test.mjs'},devDependencies:{developmentOnly:'1.0.0'}}));
  for (const [name,content] of Object.entries({'private.pdf':'%PDF-1.4 synthetic private PDF','recording.wav':'RIFF synthetic recording','review.md':'PRIVATE SYNTHETIC REVIEW','keys.txt':'api_key = sk-'+'syntheticprivatecredential1234567890'})) await writeFile(resolve(dir,'docs',name),content);
  return dir;
}

test('source publishing excludes contaminated docs from the actual ZIP', async () => {
  const dir = await fixture();
  const result = spawnSync(process.execPath,['scripts/release-source.mjs'],{cwd:dir,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(resolve(dir,'dist/PracticeBridge-0.0.0-source.zip')))));
  try {
    const names = (await zip.getEntries()).map(e=>e.filename);
    assert.ok(names.includes('README.md'));
    assert.deepEqual(names.filter(n=>/^docs\/(private.pdf|recording.wav|review.md|keys.txt)$/.test(n)),[], 'Private synthetic files were included in the actual source ZIP');
  } finally {await zip.close();}
});

test('source output rejects a path outside its local dist before writing', async () => {
  const dir=await fixture(),result=spawnSync(process.execPath,['scripts/release-source.mjs','--out','../outside-release'],{cwd:dir,encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);
  assert.match(result.stdout+result.stderr,/inside.*dist|dist.*directory/i);
});

test('runtime staging refuses unregistered code and never recursively sweeps docs', async () => {
  const {stageRelease} = await import('../scripts/audit-release.mjs');
  const dir = await fixture();
  const policy = {runtime:['package.json','src/archive/zip-adapter.mjs'],source:[],unpacked:[],coverageRoots:['src'],assets:[]};
  await writeFile(resolve(dir,'src/new-worker.mjs'),'export const enabled = true;');
  await assert.rejects(stageRelease({root:dir,stage:resolve(dir,'dist/stage-fail'),kind:'runtime',policy,dependencyFiles:[]}),/unregistered.*src\/new-worker/i);
  policy.runtime.push('src/new-worker.mjs');
  const manifest = await stageRelease({root:dir,stage:resolve(dir,'dist/stage-ok'),kind:'runtime',policy,dependencyFiles:[]});
  assert.deepEqual(manifest.files.map(f=>f.path).sort(),['package.json','src/archive/zip-adapter.mjs','src/new-worker.mjs']);
  await assert.rejects(access(resolve(dir,'dist/stage-ok/docs/private.pdf')));
  const stagedPackage=JSON.parse(await readFile(resolve(dir,'dist/stage-ok/package.json')));
  assert.equal(stagedPackage.scripts,undefined);
  assert.equal(stagedPackage.devDependencies,undefined);
});

test('actual ASAR audit detects extra files, tampering and missing unpacked worker', async () => {
  const {stageRelease,auditAsar,asarUnpackPattern} = await import('../scripts/audit-release.mjs');
  const {createPackageWithOptions} = await import('@electron/asar');
  const dir=await fixture(),stage=resolve(dir,'dist/runtime');
  await mkdir(resolve(dir,'tools/asr-worker'),{recursive:true});
  await writeFile(resolve(dir,'tools/asr-worker/worker.py'),'print("synthetic")\n');
  await writeFile(resolve(dir,'tools/asr-worker/models.json'),'{"synthetic":true}\n');
  await mkdir(resolve(dir,'other'),{recursive:true});await writeFile(resolve(dir,'other/models.json'),'{"unrelated":true}\n');
  const policy={runtime:['package.json','tools/asr-worker/worker.py','tools/asr-worker/models.json','other/models.json'],source:[],unpacked:['tools/asr-worker/worker.py','tools/asr-worker/models.json'],coverageRoots:[],assets:[]};
  const manifest=await stageRelease({root:dir,stage,kind:'runtime',policy,dependencyFiles:[]});
  const asar=resolve(dir,'dist/app.asar');
  await createPackageWithOptions(stage,asar,{unpack:asarUnpackPattern(manifest,stage)});
  await auditAsar(asar,manifest);
  await writeFile(resolve(dir,'dist/app.asar.unpacked/tools/asr-worker/worker.py'),'modified');
  await assert.rejects(auditAsar(asar,manifest),/hash|size/i);
  await writeFile(resolve(stage,'private.pdf'),'%PDF synthetic');
  await createPackageWithOptions(stage,resolve(dir,'dist/extra.asar'),{unpack:asarUnpackPattern(manifest,stage)});
  await assert.rejects(auditAsar(resolve(dir,'dist/extra.asar'),manifest),/unregistered|unexpected/i);
  await createPackageWithOptions(stage,resolve(dir,'dist/packed.asar'),{});
  await assert.rejects(auditAsar(resolve(dir,'dist/packed.asar'),manifest),/unpack|unexpected/i);
});

test('the full OCR unpack pattern compiles and matches only exact registered leaves', async () => {
  const {asarUnpackPattern}=await import('../scripts/audit-release.mjs'),{Minimatch}=await import('minimatch');
  const closure=JSON.parse(await readFile(resolve(root,'assets/ocr-launch-lock.json'),'utf8'));
  const files=[...closure.files.map(file=>({...file,unpacked:true})),{path:'literal/[guide]/choice(1){a,b}.mjs',unpacked:true},{path:'literal/.hidden/!note+@.txt',unpacked:true},{path:'other/models.json',unpacked:false}];
  const build=resolve(root,'dist','MiXeD 检查 {one,two}'),prefix=build.replaceAll('\\','/')+'/stage/';
  const pattern=asarUnpackPattern({files},build),matcher=new Minimatch(pattern,{matchBase:true});
  assert.ok(pattern.length<65536);assert.equal(matcher.set.length,files.filter(file=>file.unpacked).length);
  for(const file of files){
    assert.equal(matcher.match(prefix+file.path),file.unpacked,file.path);
    assert.equal(matcher.match(prefix+file.path+'.unregistered'),false,file.path+' suffix');
    assert.equal(matcher.match(prefix+file.path+'/unregistered'),false,file.path+' child');
  }
  assert.equal(matcher.match(prefix+'literal/guide/choice1a.mjs'),false);
  assert.equal(matcher.match(resolve(root,'outside','package.json').replaceAll('\\','/')),false);
});

test('Packager copies every audited staging file, including default-ignored lockfiles, into the actual ASAR',async()=>{
  const {stagedCopyOptions}=await import('../scripts/package.mjs');
  const cli=spawnSync(process.execPath,['scripts/package.mjs','--invalid-fixture-option'],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.notEqual(cli.status,0);assert.match(cli.stdout+cli.stderr,/Usage: node scripts\/package\.mjs/);
  const {stageRelease,auditDirectory,auditAsar,asarUnpackPattern}=await import('../scripts/audit-release.mjs');
  // Exercise the installed Packager's own copy and ASAR stages without an
  // Electron download or executable build. The dependency is lockfile-pinned.
  const packagerBase=new URL('.',import.meta.resolve('@electron/packager'));
  const {populateIgnoredPaths}=await import(new URL('copy-filter.js',packagerBase));
  const {App}=await import(new URL('platform.js',packagerBase));
  const dir=await fixture(),build=resolve(dir,'dist','MiXeD 暂存检查'),stage=resolve(build,'runtime-stage');
  const originals={'assets/ocr-launch-lock.json':'{"synthetic":"launch"}\n','assets/ocr-runtime-lock.json':'{"synthetic":"runtime"}\n','tools/asr-worker/worker.py':'print("original fixture")\n','node_modules/self-authored/package-lock.json':'{"synthetic":"nested lock"}\n','resources/required.obj':'self-authored registered resource\n'};
  for(const [name,content]of Object.entries(originals)){await mkdir(dirname(resolve(dir,name)),{recursive:true});await writeFile(resolve(dir,name),content);}
  const policy={runtime:['package.json','package-lock.json','src/archive/zip-adapter.mjs',...Object.keys(originals)],source:[],coverageRoots:[],assets:[],unpacked:['package-lock.json','tools/asr-worker/worker.py','node_modules/self-authored/package-lock.json']};
  const inventory=await stageRelease({root:dir,stage,kind:'runtime',policy,dependencyFiles:[]});
  await auditDirectory(stage,inventory);await assert.rejects(access(resolve(stage,'docs/private.pdf')));
  async function copyAndArchive(name,copyOptions){
    const opts={dir:stage,out:build,tmpdir:resolve(build,name),name:'Synthetic',platform:'win32',arch:'x64',electronVersion:'44.3.0',asar:{unpack:asarUnpackPattern(inventory,build)},...copyOptions};
    const app=new App({...opts,...populateIgnoredPaths(opts)},resolve(build,'unused-template'));
    await app.copyTemplate();await app.asarApp();return app.appAsarPath;
  }
  const filtered=await copyAndArchive('default-filter',{prune:false,junk:false,ignore:[]});
  await assert.rejects(auditAsar(filtered,inventory),/Missing released files: .*package-lock\.json/);
  const complete=await copyAndArchive('audited-stage',stagedCopyOptions),result=await auditAsar(complete,inventory);
  assert.equal(result.fileCount,inventory.files.length);assert.equal(result.unpackedFileCount,3);
  assert.equal(await readFile(resolve(complete+'.unpacked','package-lock.json'),'utf8'),'synthetic fixture\n');
  await writeFile(resolve(complete+'.unpacked','unregistered.txt'),'synthetic unregistered content\n');
  await assert.rejects(auditAsar(complete,inventory),/Unexpected\/unregistered released file/);
  await auditDirectory(stage,inventory);
});

test('verification counts observed results and keeps unperformed gates skipped', async () => {
  const {summarizeResults}=await import('../scripts/verify.mjs');
  const summary=summarizeResults([{name:'unit',status:'passed',output:'# tests 7\n# pass 5\n# fail 0\n# skipped 2\n'},{name:'browser',status:'failed',output:'PASS one\nPASS two\n'},{name:'python',status:'failed',output:'test_alpha (Original) ... ok\ntest_beta (Original) ... FAIL\ntest_gamma (Original) ... skipped \'Original unavailable fixture\'\nRan 3 tests in 0.01s\nFAILED (failures=1, skipped=1)\n'},{name:'microphone',status:'skipped',reason:'No human microphone session'}]);
  assert.deepEqual(summary.phases,{total:4,passed:1,failed:2,skipped:1});
  assert.deepEqual(summary.checks,{passed:8,failed:1,skipped:3});
  assert.equal(summary.ok,false);
});

test('verification child environments explicitly disable Python launcher installation',async()=>{
  const {verificationPythonEnvironment}=await import('../scripts/verify.mjs');
  const original={...process.env,Python_Manager_Automatic_Install:'1',PyLauncher_Allow_Install:'1',PYLAUNCHER_ALWAYS_INSTALL:'1',PRACTICEBRIDGE_PUBLIC_FIXTURE:'retained'};
  const env=verificationPythonEnvironment(original),child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PYTHON_MANAGER_AUTOMATIC_INSTALL|PYLAUNCHER_ALLOW_INSTALL|PYLAUNCHER_ALWAYS_INSTALL|PRACTICEBRIDGE_PUBLIC_FIXTURE)$/i.test(key)))))'],{env,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{PRACTICEBRIDGE_PUBLIC_FIXTURE:'retained',PYTHON_MANAGER_AUTOMATIC_INSTALL:'0'});assert.equal(original.Python_Manager_Automatic_Install,'1');
});

test('shared verification summaries omit host paths while retaining exact local command evidence',async()=>{
  const {sharedVerificationSummary}=await import('../scripts/verify.mjs'),{sha256}=await import('../scripts/audit-release.mjs');
  const root='C:\\Users\\Fixture Person\\Project',raw={version:'0.5.0',ok:true,phases:{passed:3,failed:0,skipped:1},checks:{passed:17,failed:0,skipped:2},tools:{node:'v22.22.3',python:'Python 3.14.6'},artifacts:[{path:'dist/new/PracticeBridge.exe',sha256:'a'.repeat(64)},{path:'../Other User/app.asar',sha256:'b'.repeat(64)}],results:[{name:'unit',status:'passed',command:['D:\\Private Tools\\node.exe','--test','c:/users/fixture person/project/tests/original.test.mjs'],log:'test-results/run/unit.txt',logSha256:'c'.repeat(64),artifactDirectories:['test-results/self-authored','../Other User/results']},{name:'asr-python-unit',status:'passed',command:['C:\\Users\\Fixture Person\\Python\\python.exe','-I','-B','tests/asr-model-preflight.py']},{name:'packaged-inventory',status:'passed',command:['D:\\Private Tools\\node.exe','scripts/audit-release.mjs','--app','D:\\Other User\\Private App']} ]};
  const before=structuredClone(raw),shared=sharedVerificationSummary(raw,{projectRoot:root});assert.deepEqual(raw,before);assert.deepEqual(shared.phases,raw.phases);assert.deepEqual(shared.checks,raw.checks);assert.deepEqual(shared.tools,raw.tools);
  assert.deepEqual(shared.results[0].command,['node','--test','tests/original.test.mjs']);assert.equal(shared.results[1].command[0],'python');assert.equal(shared.results[2].command.at(-1),'<local-absolute-path>');assert.equal(shared.results[0].executedCommandSha256,sha256(JSON.stringify(raw.results[0].command)));assert.equal(shared.results[0].logSha256,raw.results[0].logSha256);assert.equal(shared.artifacts[0].sha256,raw.artifacts[0].sha256);assert.equal(shared.results[0].commandDisplayOnly,true);
  assert.doesNotMatch(JSON.stringify(shared),/Fixture Person|Other User|Private Tools|[A-Z]:\\\\/i);
  const escaped=sharedVerificationSummary({results:[{name:'unit',command:['node','C:/Users/Fixture Person/Project/../../Other User/private.mjs']}]},{projectRoot:root});assert.equal(escaped.results[0].command[1],'<local-absolute-path>');
  for(const value of ['\\Users\\Private Reviewer\\Portable App','C:Private Reviewer\\app','\\\\private-server\\Private Reviewer\\app','/home/private-reviewer/app'])assert.equal(sharedVerificationSummary({results:[{name:'unit',command:['node',value]}]},{projectRoot:root}).results[0].command[1],'<local-absolute-path>');
  for(const value of ['../Private Reviewer/app','..\\Private Reviewer\\app','inside/../../Private Reviewer/app'])assert.equal(sharedVerificationSummary({results:[{name:'unit',command:['node',value]}]},{projectRoot:root}).results[0].command[1],'<external-relative-path>');
});

test('an invented inventory cannot register extra release content at the audit boundary', async () => {
  const {validateInventory}=await import('../scripts/audit-release.mjs');
  const policy={runtime:['package.json'],source:['package.json'],assets:[],unpacked:[]};
  assert.throws(()=>validateInventory({kind:'source',files:[{path:'package.json'},{path:'docs/private.pdf'}]},'source',policy,[]),/unregistered|unexpected/i);
  assert.throws(()=>validateInventory({kind:'runtime',files:[{path:'package.json'}]},'runtime',policy,[{path:'node_modules/runtime/index.js',sha256:'123'}]),/missing/i);
});

test('actual application directory audit rejects an added credential or changed binary', async () => {
  const {auditDirectory,sha256}=await import('../scripts/audit-release.mjs');
  const dir=await fixture(),app=resolve(dir,'dist/app');await mkdir(app,{recursive:true});
  const binary=Buffer.from('synthetic executable');await writeFile(resolve(app,'PracticeBridge.exe'),binary);
  const inventory={files:[{path:'PracticeBridge.exe',bytes:binary.length,sha256:sha256(binary)}]};
  await auditDirectory(app,inventory);
  await writeFile(resolve(app,'PracticeBridge.exe'),'modified');
  await assert.rejects(auditDirectory(app,inventory),/size\/hash/i);
  await writeFile(resolve(app,'PracticeBridge.exe'),binary);await writeFile(resolve(app,'credential.txt'),'private');
  await assert.rejects(auditDirectory(app,inventory),/unregistered|unexpected/i);
});

test('staging refuses an output junction that resolves outside dist', async t => {
  const {outputDirectory}=await import('../scripts/audit-release.mjs');
  const dir=await fixture();await mkdir(resolve(dir,'dist'),{recursive:true});
  try {await symlink(resolve(dir,'public'),resolve(dir,'dist/redirect'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not permit creating an isolated test symlink');return;}throw error;}
  await assert.rejects(outputDirectory('dist/redirect/stage',dir),/symbolic-link/);
  await assert.rejects(access(resolve(dir,'public/stage')));
});

test('audit input cannot redirect the entire dist root through a junction', async t => {
  const {distPath}=await import('../scripts/audit-release.mjs');
  const dir=await fixture();await writeFile(resolve(dir,'public/outside.zip'),'synthetic');
  try{await symlink(resolve(dir,'public'),resolve(dir,'dist'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not permit creating an isolated test symlink');return;}throw error;}
  await assert.rejects(distPath('dist/outside.zip',dir),/redirect|symbolic|dist/);
});

test('reviewed Git LF variant preserves its bytes while arbitrary asset edits still fail', async () => {
  const {stageRelease,sha256,validateInventory}=await import('../scripts/audit-release.mjs');
  const dir=await fixture(),name='docs/self-authored.txt';await writeFile(resolve(dir,name),'synthetic\n');
  const policy={runtime:[],source:['package.json',name],coverageRoots:[],unpacked:[],assets:[{path:name,sha256:sha256('synthetic\r\n'),gitLfSha256:sha256('synthetic\n')}]};
  const inventory=await stageRelease({root:dir,stage:resolve(dir,'dist/lf'),kind:'source',policy});
  assert.equal(await readFile(resolve(dir,'dist/lf',name),'utf8'),'synthetic\n');
  validateInventory(inventory,'source',policy);
  await writeFile(resolve(dir,name),'changed\n');
  await assert.rejects(stageRelease({root:dir,stage:resolve(dir,'dist/changed'),kind:'source',policy}),/asset hash/i);
});
