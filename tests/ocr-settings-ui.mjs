import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {startServer} from '../src/server.mjs';

const root=path.resolve('test-results/ocr-ui'),output=path.join(root,crypto.randomUUID());await fs.mkdir(output,{recursive:true});
const server=await startServer({dataDir:path.join(output,'data')});let browser;
try{
  browser=await chromium.launch({channel:process.env.PRACTICEBRIDGE_BROWSER_CHANNEL||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let installRequests=0;page.on('request',r=>{if(r.url().endsWith('/api/ocr/install'))installRequests++;});
  await page.goto(server.url+'/#settings');const card=page.locator('#ocr-settings');await card.getByText('尚不可用',{exact:true}).waitFor();assert.equal(await card.locator('[data-ocr-test]').isDisabled(),true);assert.equal(await card.locator('[data-ocr-enable]').isDisabled(),true);
  await card.locator('[data-ocr-install-details] summary').click();await card.locator('[data-ocr-install]').click();await card.getByText('请先确认这里显示的下载上限和安装位置。',{exact:true}).waitFor();assert.equal(installRequests,0);
  assert.match(await card.textContent(),/96\.0 MiB/);assert.match(await card.textContent(),/不会发送材料/);assert.match(await card.textContent(),/未建立操作系统网络隔离/);
  // Do not tick install consent: the development download question is pending.
  await card.locator('[data-ocr-refresh]').click();await card.getByText('尚不可用',{exact:true}).waitFor();await card.locator('[data-ocr-install-details] summary').click();await card.screenshot({path:path.join(output,'unavailable-desktop.png')});
  await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();await card.screenshot({path:path.join(output,'unavailable-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('link',{name:'概览',exact:true}).click();await page.getByText('先把练习材料带进来',{exact:true}).waitFor();assert.equal(installRequests,0);assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({state:'passed',checks:['actual-settings-route','absent-assets-state','disabled-selftest','disabled-enable','preview-location-and-budget','unchecked-no-download','no-network-isolation-claim','mobile-width','ordinary-dashboard-still-works'],installRequests,pageErrors:errors},null,2));console.log(JSON.stringify({passed:true,output}));console.log('PASS optional OCR settings through production routes without an asset download');console.log('RESULT_DIR '+output);
}finally{await browser?.close();await server.close();}
