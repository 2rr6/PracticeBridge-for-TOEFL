import test from 'node:test';
import assert from 'node:assert/strict';
import { audioBufferToWav, capRecordingBlob, createRecordingGate } from '../public/exam-audio.mjs';

const audio = (sampleRate, channels) => ({ sampleRate, numberOfChannels: channels.length, length: channels[0].length, getChannelData: index => channels[index] });
const inspect = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return { bytes, rate: bytes.readUInt32LE(24), channels: bytes.readUInt16LE(22), format: bytes.readUInt16LE(20), bits: bytes.readUInt16LE(34), frames: bytes.readUInt32LE(40) / 2, sample: index => bytes.readInt16LE(44 + index * 2) };
};

test('PCM export writes a consistent mono 16-bit WAV header and floors a fractional sample boundary', async () => {
  const result = await inspect(audioBufferToWav(audio(8000, [Float32Array.of(1, .5, -1, -.5)]), 3.9 / 8000));
  assert.equal(result.bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(result.bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(result.bytes.readUInt32LE(4), result.bytes.length - 8);
  assert.deepEqual([result.format, result.channels, result.bits, result.rate, result.frames], [1, 1, 16, 8000, 3]);
  assert.equal(result.bytes.length, 44 + 3 * 2);
  assert.deepEqual([result.sample(0), result.sample(1), result.sample(2)], [32767, 16384, -32768]);
  assert.ok(result.frames / result.rate <= 3.9 / 8000);
});

test('channel downmix is deterministic and clips out-of-range input without wraparound', async () => {
  const result = await inspect(audioBufferToWav(audio(8000, [Float32Array.of(1, -1, 2, -2), Float32Array.of(-1, 1, 2, -2)]), 1));
  assert.equal(result.frames, 4);
  assert.deepEqual([0, 1, 2, 3].map(result.sample), [0, 0, 32767, -32768]);
});

test('a 45-second frame limit excludes a distinct marker beginning exactly after that boundary', async () => {
  for (const sampleRate of [8000, 44100, 48000]) {
    const data = new Float32Array(sampleRate * 46); data.fill(.125, 0, sampleRate * 45); data.fill(.875, sampleRate * 45);
    const result = await inspect(audioBufferToWav(audio(sampleRate, [data]), 45));
    assert.equal(result.frames, sampleRate * 45); assert.equal(result.frames / result.rate, 45);
    assert.equal(result.sample(result.frames - 1), Math.round(.125 * 32767));
    assert.equal(result.bytes.length, 44 + sampleRate * 45 * 2);
  }
});

test('early stop preserves only available frames and never pads a short response to its maximum', async () => {
  const data = new Float32Array(48000 * 2); for (let i = 0; i < data.length; i++) data[i] = i / data.length;
  const seconds = 1.234567, capped = await inspect(audioBufferToWav(audio(48000, [data]), seconds));
  assert.equal(capped.frames, Math.floor(seconds * 48000));
  assert.ok(capped.frames / capped.rate <= seconds);
  const short = await inspect(audioBufferToWav(audio(48000, [data.subarray(0, 100)]), 45));
  assert.equal(short.frames, 100); assert.equal(short.bytes.length, 244);
});

test('an exhausted or invalid boundary cannot produce an apparently successful empty recording', async () => {
  const buffer = audio(8000, [new Float32Array(100)]);
  for (const seconds of [0, -1, NaN, 0.9 / 8000]) assert.throws(() => audioBufferToWav(buffer, seconds), /没有可保存的音频帧/);
  for (const seconds of [0, -1, NaN, Infinity]) await assert.rejects(createRecordingGate({}, seconds), /时间已用完/);
});

test('decoding uses a supplied context without closing it and forwards the original encoded bytes', async () => {
  const encoded = new Uint8Array([4, 8, 15, 16, 23, 42]); let received, closed = false;
  const decoder = { async decodeAudioData(bytes) { received = new Uint8Array(bytes); return audio(8000, [Float32Array.of(.1, .2, .3)]); }, async close() { closed = true; } };
  const result = await inspect(await capRecordingBlob(new Blob([encoded]), 2 / 8000, decoder));
  assert.deepEqual(received, encoded); assert.equal(result.frames, 2); assert.equal(closed, false);
});

test('an internally created decode context closes on both successful and failed decoding', async () => {
  const original = globalThis.AudioContext; let closeCount = 0, fail = false;
  globalThis.AudioContext = class {
    async decodeAudioData() { if (fail) throw new Error('Synthetic decode failure'); return audio(8000, [Float32Array.of(.1, .2)]); }
    async close() { closeCount++; }
  };
  try {
    assert.equal((await inspect(await capRecordingBlob(new Blob(['original']), 1))).frames, 2);
    assert.equal(closeCount, 1); fail = true;
    await assert.rejects(capRecordingBlob(new Blob(['original']), 1), /Synthetic decode failure/);
    assert.equal(closeCount, 2);
  } finally { if (original === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = original; }
});
