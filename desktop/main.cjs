const {app,BrowserWindow,session,dialog,safeStorage}=require('electron');
const {createSecretStore}=require('./secret-store.cjs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
let runtime;
app.setName('PracticeBridge');
const workspace=path.resolve(__dirname,'..');
const dataDir=process.env.PRACTICEBRIDGE_DATA_DIR || (app.isPackaged?path.join(path.dirname(process.execPath),'data'):path.join(workspace,'data'));
// The single-instance lock must use this workspace's profile, so isolated
// previews and tests cannot redirect into a different live user's workspace.
app.setPath('userData',path.join(dataDir,'desktop-profile'));
app.setPath('sessionData',path.join(dataDir,'desktop-profile'));
const gotLock=app.requestSingleInstanceLock();
if(!gotLock){app.quit();}else{
  app.on('second-instance',()=>{const w=BrowserWindow.getAllWindows()[0];if(w){if(w.isMinimized())w.restore();w.focus();}});
  app.whenReady().then(async()=>{
    const {startServer}=await import(pathToFileURL(path.join(workspace,'src','server.mjs')).href);
    const secretStore=createSecretStore({directory:path.join(dataDir,'credentials'),safeStorage});
    runtime=await startServer({dataDir,port:0,host:'127.0.0.1',secretStore});
    const origin=new URL(runtime.url).origin;
    const isOurs=url=>{try{return new URL(url).origin===origin;}catch{return false;}};
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const types=details.mediaTypes||[];
      callback(permission==='media'&&isOurs(contents.getURL())&&types.length>0&&types.every(type=>type==='audio'));
    });
    session.defaultSession.setPermissionCheckHandler((contents,permission,requestingOrigin,details)=>permission==='media'&&!!contents&&isOurs(contents.getURL())&&isOurs(requestingOrigin)&&(details.mediaType==='audio'||details.mediaType==='unknown'));
    const window=new BrowserWindow({width:1400,height:940,minWidth:830,minHeight:640,title:'PracticeBridge for TOEFL · 练习工作台',icon:path.join(workspace,'public','icon.png'),backgroundColor:'#f5f6f3',autoHideMenuBar:true,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,spellcheck:true,backgroundThrottling:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(!isOurs(url))event.preventDefault();});
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    let closeAllowed=false,flushing=false;
    window.on('close',event=>{
      if(closeAllowed)return;
      event.preventDefault();
      if(flushing)return;
      flushing=true;
      window.webContents.executeJavaScript('typeof window.practiceBridgeBeforeClose === "function" ? window.practiceBridgeBeforeClose() : true')
        .then(ok=>{if(ok){closeAllowed=true;window.close();}})
        .catch(()=>{dialog.showErrorBox('尚未关闭工作区','保存确认未完成，请等待页面恢复后再次关闭。');})
        .finally(()=>{flushing=false;});
    });
    window.once('ready-to-show',()=>{if(process.env.PRACTICEBRIDGE_TEST_HIDDEN!=='1')window.show();});
    await window.loadURL(runtime.url);
  }).catch(error=>{dialog.showErrorBox('PracticeBridge for TOEFL 启动失败',`无法打开本地工作区：${error.message}\n请查看项目中的使用说明。`);app.quit();});
  app.on('window-all-closed',async()=>{await runtime?.close?.();app.quit();});
}
