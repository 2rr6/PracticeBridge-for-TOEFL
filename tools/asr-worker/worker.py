"""PracticeBridge local-only, single-request ASR protocol v1. No installer."""
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import threading
import time


class Failure(Exception):
    pass


def digest(filename):
    result = hashlib.sha256()
    with open(filename, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def verify_model(config):
    root = Path(config['modelDirectory'])
    if not root.is_dir():
        raise Failure('model_missing')
    # faster-whisper 1.2.1 reads tokenizer.json and preprocessor_config.json
    # from this directory; CTranslate2 may select an alternate vocabulary.
    # Deny every unpinned entry except these inert provenance/cache names.
    # In particular base must not inherit large-v3's feature extractor sidecar.
    allowed = {item['name'] for item in config['profile']['files']}
    inert_files = {'source.json', 'README.md', 'LICENSE', '.gitattributes'}
    for entry in root.iterdir():
        if entry.name in allowed:
            continue
        if not entry.is_symlink() and not entry.is_junction():
            if entry.name in inert_files and entry.is_file():
                continue
            if entry.name == '.cache' and entry.is_dir():
                continue
        raise Failure('model_unexpected_file')
    # This allowlist comes from the trusted host, not material contents.
    for item in config['profile']['files']:
        filename = root / item['name']
        if filename.is_symlink() or filename.is_junction() or not filename.is_file():
            raise Failure('model_incomplete')
        if filename.stat().st_size != item['bytes'] or digest(filename) != item['sha256']:
            raise Failure('model_hash_mismatch')
    if not (root / 'tokenizer.json').is_file():
        raise Failure('model_incomplete')


def memory_watchdog(limit):
    # Monitor total process working set, including native allocations. This is a
    # sampled watchdog, not a hard OS allocation or network sandbox.
    if os.name != 'nt':
        return
    import ctypes
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]
    current = ctypes.windll.kernel32.GetCurrentProcess
    current.restype = wintypes.HANDLE
    get_info = ctypes.windll.psapi.GetProcessMemoryInfo
    get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    while True:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if get_info(current(), ctypes.byref(counters), counters.cb) and max(counters.WorkingSetSize, counters.PagefileUsage) > limit:
            os._exit(72)
        time.sleep(0.1)


def validate_audio_sample_budget(sample_count, max_duration_seconds):
    # A floor-selected interval can contain the next whole 16 kHz sample.
    max_samples = math.ceil(max_duration_seconds * 16000)
    if sample_count > max_samples:
        raise Failure('audio_budget')


def read_audio(request):
    import numpy as np
    if request['operation'] == 'selftest':
        return np.zeros(16000, dtype=np.float32), 0.0
    import av
    source = Path(request['inputPath'])
    if source.is_symlink() or not source.is_file() or source.stat().st_size > request['budget']['maxInputBytes'] or digest(source) != request['inputAssetId']:
        raise Failure('asset_integrity')
    start = request['parameters']['startSeconds']
    end = request['parameters']['endSeconds']
    frames = []
    total = 0
    # Decode from the beginning, bounded independently from untrusted container duration.
    with av.open(str(source), format=request['inputFormat'], options={'protocol_whitelist': 'file'}) as container:
        resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
        for frame in container.decode(audio=0):
            for output in resampler.resample(frame):
                samples = output.to_ndarray().reshape(-1)
                previous = total
                total += len(samples)
                lo, hi = max(0, int(start * 16000) - previous), min(len(samples), int(end * 16000) - previous)
                if hi > lo:
                    frames.append(samples[lo:hi].copy())
                if total >= int(end * 16000):
                    break
            if total >= int(end * 16000):
                break
        else:
            for output in resampler.resample(None):
                samples = output.to_ndarray().reshape(-1)
                lo, hi = max(0, int(start * 16000) - total), min(len(samples), int(end * 16000) - total)
                if hi > lo:
                    frames.append(samples[lo:hi].copy())
                total += len(samples)
    if not frames:
        raise Failure('audio_empty')
    audio = np.concatenate(frames).astype(np.float32) / 32768.0
    validate_audio_sample_budget(len(audio), request['budget']['maxDurationSeconds'])
    return audio, start


def segments_outside_audio(segments, offset, decoded_samples):
    # round(relative timestamp + requested offset, 3) has a half-ms bin.
    # Convert the actual PCM bounds into the same requested-offset coordinates.
    start_sample = int(offset * 16000)
    pcm_start, pcm_end = start_sample / 16000, (start_sample + decoded_samples) / 16000
    shift = offset - pcm_start
    timestamp_start, timestamp_end = pcm_start + shift, pcm_end + shift
    half_quantum = 0.0005
    float_slack = sys.float_info.epsilon * max(1, abs(timestamp_start), abs(timestamp_end)) * 4
    return any(item['start'] + half_quantum + float_slack < timestamp_start or item['end'] - half_quantum - float_slack > timestamp_end for item in segments)


def main():
    started = time.monotonic()
    line = sys.stdin.buffer.readline(65537)
    if len(line) > 65536:
        raise Failure('protocol_input_limit')
    request = json.loads(line)
    config = request['configuration']
    threading.Thread(target=memory_watchdog, args=(request['budget']['maxMemoryBytes'],), daemon=True).start()
    verify_model(config)  # Must precede faster-whisper import/construction.
    handles = []
    for directory in config['dllDirectories']:
        if not Path(directory).is_dir():
            raise Failure('runtime_directory_missing')
        if os.name == 'nt':
            handles.append(os.add_dll_directory(directory))
    import ctranslate2
    from faster_whisper import WhisperModel
    versions = {name: importlib.metadata.version(name) for name in ['faster-whisper', 'ctranslate2', 'av']}
    if versions != {'faster-whisper': '1.2.1', 'ctranslate2': '4.8.2', 'av': '18.1.0'}:
        raise Failure('runtime_version_mismatch')
    if config['device'] == 'cuda' and ctranslate2.get_cuda_device_count() <= config['deviceIndex']:
        raise Failure('gpu_unavailable')
    supported = ctranslate2.get_supported_compute_types(config['device'], config['deviceIndex'])
    if config['computeType'] not in supported:
        raise Failure('precision_unavailable')
    model = WhisperModel(config['modelDirectory'], device=config['device'], device_index=config['deviceIndex'], compute_type=config['computeType'], cpu_threads=4, num_workers=1, local_files_only=True)
    actual = {'engine': 'faster-whisper', 'versions': versions, 'device': model.model.device, 'deviceIndex': model.model.device_index, 'computeType': model.model.compute_type, 'modelId': config['profile']['model_id'], 'modelRevision': config['profile']['revision']}
    actual_indices = actual['deviceIndex'] if isinstance(actual['deviceIndex'], list) else [actual['deviceIndex']]
    if actual['device'] != config['device'] or actual['computeType'] != config['computeType'] or config['deviceIndex'] not in actual_indices:
        raise Failure('execution_configuration_mismatch')
    audio, offset = read_audio(request)
    segments, info = model.transcribe(audio, language='en', beam_size=1, temperature=0, vad_filter=False, condition_on_previous_text=False)
    result_segments = []
    for segment in segments:  # Inference happens here; exhaust before success.
        result_segments.append({'start': round(segment.start + offset, 3), 'end': round(segment.end + offset, 3), 'text': segment.text, 'avgLogprob': segment.avg_logprob, 'noSpeechProb': segment.no_speech_prob})
        if len(json.dumps(result_segments).encode('utf-8')) > request['budget']['maxOutputBytes'] - 4096:
            raise Failure('output_budget')
    issues = []
    if not ''.join(item['text'] for item in result_segments).strip():
        issues.append({'code': 'empty_transcript', 'reason': 'No transcription text was produced.'})
    if segments_outside_audio(result_segments, offset, len(audio)):
        issues.append({'code': 'segment_outside_audio', 'reason': 'ASR reported timestamps outside the selected decoded audio; retain raw evidence for review.'})
    if any(item['noSpeechProb'] > 0.6 for item in result_segments):
        issues.append({'code': 'possible_non_speech', 'reason': 'Engine reports possible non-speech; this is not a calibrated accuracy score.'})
    result = {'protocolVersion': 1, 'state': 'completed', 'actual': actual, 'segments': result_segments, 'issues': issues, 'transcript': ''.join(item['text'] for item in result_segments).strip(), 'durationSeconds': len(audio) / 16000, 'elapsedSeconds': round(time.monotonic() - started, 3), 'sampleKind': 'generated-silence-capability-test' if request['operation'] == 'selftest' else 'host-asset', 'networkPolicy': 'local-files-only-no-active-requests', 'memoryBoundary': 'sampled-process-watchdog'}
    print(json.dumps(result, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error).lower()
        code = str(error) if isinstance(error, Failure) else ('out_of_memory' if 'out of memory' in message or 'bad_alloc' in message else 'runtime_unavailable' if isinstance(error, (ImportError, OSError)) or ('library' in message and ('not found' in message or 'cannot be loaded' in message)) else 'inference_failed')
        # Never echo library exceptions, paths, material text or environment values.
        print(json.dumps({'protocolVersion': 1, 'state': 'failed', 'errorCode': code}), flush=True)
        sys.exit(1)
