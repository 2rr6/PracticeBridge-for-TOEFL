import { spawn } from 'node:child_process';
import { open, mkdtemp, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Checked against the installed Codex CLI 0.153.4 on 2026-09-10 and:
// https://learn.chatgpt.com/docs/app-server
// https://learn.chatgpt.com/docs/config-file/config-reference
// A read-only command sandbox is not a guarantee that all tools are disabled.
// dynamicTools: [] adds no client tools; it does not remove built-in tools.
// Keep inference disabled until a supported, verified no-tool contract exists.
const RESTRICTION_DETAIL = '首版尚未验证 Codex CLI 能完整禁用工具、技能和项目指令，暂不发送材料。可使用 API 或本地模型；CLI 登录状态未检测。';
const PROBE_LIMIT_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 5000;

function unavailable(detail, extra = {}) {
  return { available: false, installed: false, authentication: 'unknown', detail, ...extra };
}

function capabilityError() {
  const error = new Error(RESTRICTION_DETAIL);
  error.code = 'capability_unavailable';
  error.status = 503;
  return error;
}

function nativeCandidates(directory, platform, arch) {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const triple = platform === 'win32'
    ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
    : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const packageDir = path.join(directory, 'node_modules', '@openai', 'codex');
  const platformPackage = path.join(packageDir, 'node_modules', '@openai', `codex-${platform}-${arch}`);
  return [
    path.join(directory, executable),
    path.join(platformPackage, 'vendor', triple, 'bin', executable),
    path.join(packageDir, 'vendor', triple, 'bin', executable),
    path.join(packageDir, 'vendor', triple, 'codex', executable),
  ];
}

async function isNativeExecutable(filename, platform) {
  let handle;
  try {
    if (!(await stat(filename)).isFile()) return false;
    handle = await open(filename, 'r');
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, 4, 0);
    if (bytesRead < 4) return false;
    if (platform === 'win32') return signature[0] === 0x4d && signature[1] === 0x5a;
    return signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(signature.readUInt32BE());
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function findExecutable(codexPath, platform, arch, environment) {
  let candidates;
  if (codexPath !== undefined && codexPath !== null && codexPath !== '') {
    if (typeof codexPath !== 'string' || !path.isAbsolute(codexPath) || /[\r\n\0]/.test(codexPath)) return null;
    const base = path.basename(codexPath).toLowerCase();
    const nativeName = platform === 'win32' ? 'codex.exe' : 'codex';
    if (base === nativeName) candidates = [codexPath];
    else if (platform === 'win32' && ['codex.cmd', 'codex.ps1'].includes(base)) {
      // Never parse or launch a shell wrapper. Only locate its standard npm binary.
      candidates = nativeCandidates(path.dirname(codexPath), platform, arch);
    } else return null;
  } else {
    const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    const directories = pathValue.split(path.delimiter).filter(directory => path.isAbsolute(directory)).slice(0, 64);
    candidates = directories.flatMap(directory => nativeCandidates(directory, platform, arch));
  }
  for (const filename of [...new Set(candidates)]) {
    if (await isNativeExecutable(filename, platform)) return filename;
  }
  return null;
}

function probeEnvironment(environment, directory) {
  const allowed = new Set(['systemroot', 'windir', 'processor_architecture', 'path']);
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toLowerCase())));
  // This is a per-child environment. It never changes the user's configuration.
  return { ...result, CODEX_HOME: directory, HOME: directory, USERPROFILE: directory, TMPDIR: directory, TEMP: directory, TMP: directory };
}

async function killTree(child, spawnImpl, platform, environment, directory) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    child.kill?.();
    return;
  }
  if (platform === 'win32') {
    const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (systemRoot && path.isAbsolute(systemRoot)) {
      try {
        await new Promise(resolve => {
          const killer = spawnImpl(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore', env: probeEnvironment(environment, directory),
          });
          let settled = false;
          const finish = fallback => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (fallback) child.kill?.();
            resolve();
          };
          const timer = setTimeout(() => { killer.kill?.(); finish(true); }, 1000);
          killer.once('error', () => finish(true));
          killer.once('close', code => finish(code !== 0));
        });
        return;
      } catch { /* Fall back to the direct child if taskkill cannot start. */ }
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Child may have exited. */ }
  }
  child.kill?.('SIGKILL');
}

function probeVersion(executable, { spawnImpl, platform, environment, directory, timeoutMs }) {
  return new Promise(resolve => {
    let child;
    let finished = false;
    let byteCount = 0;
    let output = '';
    let timer;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminate = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child, spawnImpl, platform, environment, directory)
        .catch(() => child.kill?.())
        .finally(() => resolve({ error: reason }));
    };
    try {
      child = spawnImpl(executable, ['--version'], {
        cwd: directory, env: probeEnvironment(environment, directory),
        shell: false, windowsHide: true, detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish({ error: 'probe_failed' });
      return;
    }
    timer = setTimeout(() => terminate('probe_timeout'), timeoutMs);
    const count = chunk => {
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > PROBE_LIMIT_BYTES) terminate('probe_output_limit');
    };
    child.stdout?.on('data', chunk => {
      count(chunk);
      if (!finished) output += chunk.toString('utf8');
    });
    child.stderr?.on('data', count); // Never expose CLI stderr or private paths.
    child.once('error', () => finish({ error: 'probe_failed' }));
    child.once('close', code => {
      if (code !== 0) return finish({ error: 'probe_failed' });
      const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(output.trim());
      finish(match ? { version: match[1] } : { error: 'unrecognized_cli' });
    });
  });
}

/** Detection is local and sends neither a prompt nor an authentication request. */
export function createCodexAdapter({ spawnImpl = spawn, platform = process.platform, arch = process.arch, environment = process.env, tempRoot = os.tmpdir(), probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
  async function detectCodex({ codexPath } = {}) {
    const executable = await findExecutable(codexPath, platform, arch, environment);
    if (!executable) return unavailable('未找到可直接启动的 Codex 原生程序。可指定 codex.exe 的完整路径；不会运行 shell 脚本。', { code: 'codex_not_found' });
    let directory;
    try {
      directory = await mkdtemp(path.join(tempRoot, 'practicebridge-codex-check-'));
      const result = await probeVersion(executable, { spawnImpl, platform, environment, directory, timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(20, probeTimeoutMs)) });
      if (result.error) {
        const detail = result.error === 'probe_timeout' ? 'Codex 程序检测超时，未发送材料。' : 'Codex 程序检测未通过，未发送材料。';
        return unavailable(detail, { code: result.error });
      }
      return unavailable(`已检测到 Codex CLI ${result.version}。${RESTRICTION_DETAIL}`, {
        installed: true, version: result.version, code: 'capability_unavailable',
      });
    } catch {
      return unavailable('无法完成本地 Codex 程序检测，未发送材料。', { code: 'probe_failed' });
    } finally {
      // Only remove our empty probe directory; never recurse over user files.
      if (directory) await rmdir(directory).catch(() => {});
    }
  }

  async function runCodex() {
    // Do not resolve the executable, serialize the prompt, or start a child here.
    throw capabilityError();
  }

  return { detectCodex, runCodex };
}

const adapter = createCodexAdapter();
export const detectCodex = adapter.detectCodex;
export const runCodex = adapter.runCodex;
