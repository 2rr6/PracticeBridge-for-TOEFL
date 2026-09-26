import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';
import {appFetch} from './auth-client.mjs';

const root=path.resolve('test-results/workspace-epoch-ui');await fs.mkdir(root,{recursive:true});
const run=await fs.mkdtemp(path.join(root,'run-'));let instance,browser;const errors=[];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
try{
  instance=await startServer({dataDir:path.join(run,'data')});
  const backup=Buffer.from(await(await fetch(instance.url+'/api/backup')).arrayBuffer());
  const backupPath=path.join(run,'self-authored-backup.zip');await fs.writeFile(backupPath,backup);
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const old=await context.newPage(),restorer=await context.newPage();
  for(const page of [old,restorer])page.on('pageerror',error=>errors.push(error.message));
  await old.goto(instance.url+'/#settings');await old.locator('#provider').selectOption('compatible');await old.locator('#model').fill('UNSAVED_OLD_MODEL');
  assert.equal(await old.locator('#backup-preferences').isChecked(),false);
  let oldWrites=0;old.on('request',request=>{if(request.url().endsWith('/api/settings')&&request.method()==='POST')oldWrites++;});
  await restorer.goto(instance.url+'/#settings');await restorer.getByText('从个人备份恢复',{exact:true}).click();
  await restorer.locator('#backup-file').setInputFiles(backupPath);await restorer.locator('#restore-confirm').check();
  const reload=restorer.waitForURL('**/#dashboard');await restorer.locator('#backup-restore').click();await reload;
  await restorer.getByText('今天练点什么',{exact:true}).waitFor();
  await old.locator('#workspace-recovery-notice').waitFor();
  assert.equal(await old.locator('#model').inputValue(),'UNSAVED_OLD_MODEL');
  await old.locator('#settings-form button[type=submit]').click();await old.locator('#toast').filter({hasText:'工作区已从备份恢复'}).waitFor();
  assert.equal(oldWrites,0);assert.equal(await old.locator('#model').inputValue(),'UNSAVED_OLD_MODEL');
  await old.screenshot({path:path.join(run,'old-draft-preserved.png'),fullPage:true});
  await old.locator('#workspace-recovery-notice button').click();await old.locator('#settings-form').waitFor();
  assert.equal(await old.locator('#workspace-recovery-notice').count(),0);
  await old.locator('#provider').selectOption('compatible');await old.locator('#baseUrl').fill('http://127.0.0.1:1/v1');await old.locator('#model').fill('FRESH_PAGE_MODEL');const saved=old.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='POST');
  await old.locator('#settings-form button[type=submit]').click();assert.equal((await saved).status(),200);assert.equal(oldWrites,1);
  // A real initial navigation receives bootstrap A only after an external restore.
  const racing=await context.newPage(),entered=deferred(),release=deferred();racing.on('pageerror',error=>errors.push(error.message));
  await racing.route('**/api/bootstrap',async route=>{const response=await route.fetch({headers:{...route.request().headers(),Origin:instance.url}});assert.equal(response.status(),200);assert.match((await response.json()).workspaceEpoch,/^[a-f0-9-]{36}$/);entered.resolve();await release.promise;await route.fulfill({response});});
  await racing.goto(instance.url+'/#settings');await entered.promise;
  const restored=await appFetch(instance.url+'/api/restore',{method:'POST',headers:{'X-PracticeBridge':'1','Content-Type':'application/json'},body:JSON.stringify({file:{name:'self-authored-backup.zip',data:backup.toString('base64')}})});
  assert.equal(restored.status,200);const stateRefused=racing.waitForResponse(r=>r.url().endsWith('/api/state')&&r.status()===409);release.resolve();await stateRefused;await racing.getByText('暂时无法打开',{exact:true}).waitFor();await racing.locator('#workspace-recovery-notice').waitFor();
  assert.equal(await racing.locator('#settings-form').count(),0);await racing.screenshot({path:path.join(run,'bootstrap-restore-race.png'),fullPage:true});
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(run,'result.json'),JSON.stringify({passed:true,oldWrites,oldDraftPreserved:true,ownRestoreReloaded:true,initialRaceRefused:true,errors},null,2));
  console.log('PASS two-page restore, preserved old input, explicit reload and bootstrap race: '+run);
}finally{await browser?.close();await instance?.close();}
