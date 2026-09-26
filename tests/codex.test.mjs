import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodexAdapter } from '../src/codex.mjs';

async function fixture(t, behaviour = 'success') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'practicebridge-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex.exe');
  await writeFile(executable, Buffer.from([0x4d, 0x5a, 0, 0]));
  const calls = [];
  let killed = 0;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed += 1; return true; };
    if (command.endsWith('taskkill.exe')) {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
    queueMicrotask(() => {
      if (behaviour === 'timeout') return;
      if (behaviour === 'error') return child.emit('error', new Error('private credential must stay hidden'));
      if (behaviour === 'large') child.stdout.write('private'.repeat(3000));
      else child.stdout.write(behaviour === 'unknown' ? 'not-codex\n' : 'codex-cli 0.153.4\n');
      child.stderr.write('private stderr');
      child.emit('close', 0);
    });
    return child;
  };
  const adapter = createCodexAdapter({
    spawnImpl, platform: 'win32', arch: 'x64', tempRoot: directory, probeTimeoutMs: 25,
    environment: { PATH: directory, SystemRoot: path.parse(directory).root, OPENAI_API_KEY: 'secret', CODEX_HOME: 'private', NODE_OPTIONS: 'private' },
  });
  return { directory, executable, calls, adapter, killed: () => killed };
}

test('detection uses a native process, isolated home, bounded version-only arguments and no shell', async t => {
  const { directory, executable, calls, adapter } = await fixture(t);
  const result = await adapter.detectCodex({ codexPath: executable });
  assert.equal(result.installed, true);
  assert.equal(result.available, false);
  assert.equal(result.version, '0.153.4');
  assert.equal(result.authentication, 'unknown');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].command, executable);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.notEqual(calls[0].options.env.CODEX_HOME, 'private');
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(calls[0].options.env.CODEX_HOME, calls[0].options.cwd);
  assert.deepEqual(await readdir(directory), ['codex.exe']);
});

test('inference rejects before accessing submitted material or spawning any subprocess', async t => {
  const { adapter, calls } = await fixture(t);
  const input = new Proxy({}, { get() { throw new Error('must not inspect material'); } });
  await assert.rejects(adapter.runCodex(input), { code: 'capability_unavailable', status: 503 });
  assert.equal(calls.length, 0);
});

test('detection cannot turn inference on', async t => {
  const { adapter, executable, calls } = await fixture(t);
  await adapter.detectCodex({ codexPath: executable });
  await assert.rejects(adapter.runCodex({ prompt: 'hello' }), { code: 'capability_unavailable' });
  assert.equal(calls.length, 1);
});

test('rejects executable command lines, relative paths and script bodies', async t => {
  const { adapter, executable, directory, calls } = await fixture(t);
  for (const codexPath of ['codex.exe', `${executable} --help`, `${executable}\n`, path.join(directory, 'powershell.exe')]) {
    assert.equal((await adapter.detectCodex({ codexPath })).code, 'codex_not_found');
  }
  await writeFile(executable, '#!/bin/sh\necho unsafe');
  assert.equal((await adapter.detectCodex({ codexPath: executable })).code, 'codex_not_found');
  assert.equal(calls.length, 0);
});

test('resolves npm wrappers only through a standard native binary path', async t => {
  const { directory, executable, adapter, calls } = await fixture(t);
  const wrapper = path.join(directory, 'codex.cmd');
  await writeFile(wrapper, '@echo do-not-run');
  const native = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  await mkdir(path.dirname(native), { recursive: true });
  await writeFile(native, Buffer.from([0x4d, 0x5a, 0, 0]));
  await rm(executable);
  assert.equal((await adapter.detectCodex({ codexPath: wrapper })).installed, true);
  assert.equal(calls[0].command, native);
  assert.equal(calls[0].options.shell, false);
});

test('PATH detection still reports the no-tool capability as unavailable', async t => {
  const { adapter } = await fixture(t);
  assert.equal((await adapter.detectCodex()).code, 'capability_unavailable');
});

test('timeout kills only the detected process tree and does not expose private output', async t => {
  const { adapter, executable, calls } = await fixture(t, 'timeout');
  const result = await adapter.detectCodex({ codexPath: executable });
  assert.equal(result.code, 'probe_timeout');
  assert.equal(result.available, false);
  assert.deepEqual(calls[1].args, ['/PID', '12345', '/T', '/F']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
});

for (const [behaviour, expected] of [['large', 'probe_output_limit'], ['error', 'probe_failed'], ['unknown', 'unrecognized_cli']]) {
  test(`detection fails closed on ${behaviour}`, async t => {
    const { adapter, executable } = await fixture(t, behaviour);
    const result = await adapter.detectCodex({ codexPath: executable });
    assert.equal(result.available, false);
    assert.equal(result.code, expected);
    assert.doesNotMatch(result.detail, /private|credential|secret/);
  });
}
