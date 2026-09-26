const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const MAX_FILE = 64 * 1024;
const MAX_SLOTS = 128;

// Main-process only. Neither plaintext nor a secret getter crosses into renderer IPC.
function createSecretStore({directory,safeStorage,platform=process.platform}) {
  let queue = Promise.resolve();
  const serial = action => { const result=queue.then(action);queue=result.catch(()=>{});return result; };
  const slot = connectionKey => {
    if(typeof connectionKey!=='string'||!connectionKey.length||Buffer.byteLength(connectionKey)>8192)throw Error('凭据服务标识无效。');
    return path.join(directory,createHash('sha256').update(connectionKey).digest('hex')+'.bin');
  };
  const capabilities = async () => {
    try {
      if(!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable!=='function' || !(await safeStorage.isAsyncEncryptionAvailable()) || (platform==='linux' && ['basic_text','unknown'].includes(safeStorage.getSelectedStorageBackend()))) return {available:false,reason:'系统安全存储不可用；只能在本次会话使用密钥。'};
      return {available:true};
    } catch { return {available:false,reason:'无法初始化系统安全存储；只能在本次会话使用密钥。'}; }
  };
  const decode = async (connectionKey,bytes) => {
    if(!bytes.length||bytes.length>MAX_FILE)throw Error('invalid');
    const {result}=await safeStorage.decryptStringAsync(bytes);
    if(typeof result!=='string'||Buffer.byteLength(result)>MAX_FILE)throw Error('invalid');
    const value=JSON.parse(result);
    if(value.version!==1||value.connectionKey!==connectionKey||typeof value.secret!=='string'||!value.secret.length||value.secret.length>4096||/[\r\n]/.test(value.secret))throw Error('invalid');
    return value.secret;
  };
  const load = connectionKey => serial(async()=>{
    try {
      const file=slot(connectionKey);
      let handle;
      try { handle=await fs.open(file,'r'); } catch(error){if(error.code==='ENOENT')return null;throw error;}
      let bytes;
      try {if((await handle.stat()).size>MAX_FILE)throw Error('invalid');bytes=await handle.readFile();}finally{await handle.close();}
      if(!(await capabilities()).available)throw Error('unavailable');
      return await decode(connectionKey,bytes);
    } catch { throw Error('无法读取本机加密凭据；文件可能损坏或属于其他机器／系统账户，请重新设置。'); }
  });
  const save = (connectionKey,secret) => serial(async()=>{
    let temporary;
    try {
      const file=slot(connectionKey);
      if(typeof secret!=='string'||!secret.length||secret.length>4096||/[\r\n]/.test(secret)||!(await capabilities()).available)throw Error('invalid');
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.bin'));
      if(!files.includes(path.basename(file))&&files.length>=MAX_SLOTS)throw Error('full');
      const bytes=await safeStorage.encryptStringAsync(JSON.stringify({version:1,connectionKey,secret}));
      if(!Buffer.isBuffer(bytes)||await decode(connectionKey,bytes)!==secret)throw Error('verify');
      temporary=file+'.'+randomUUID()+'.tmp';
      const handle=await fs.open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      if(await decode(connectionKey,await fs.readFile(temporary))!==secret)throw Error('verify');
      await fs.rename(temporary,file);
      return {saved:true};
    } catch { return {saved:false,reason:'加密保存失败；未替换之前保存的凭据。'}; }
    finally {if(temporary)await fs.unlink(temporary).catch(()=>{});}
  });
  const remove = connectionKey => serial(async()=>{
    try {await fs.unlink(slot(connectionKey));return {deleted:true};}
    catch(error){return error.code==='ENOENT'?{deleted:true}:{deleted:false,reason:'本机凭据删除失败，请重试。'};}
  });
  return {capabilities,load,save,delete:remove};
}
module.exports={createSecretStore};
