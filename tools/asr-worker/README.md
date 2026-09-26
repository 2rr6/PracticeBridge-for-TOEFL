# Optional local ASR worker

PracticeBridge uses an independently installed Python environment. It never installs
packages, downloads models, changes precision/device, or falls back to cloud ASR.
The application starts `worker.py` with `-I -B -u`, `shell:false`, a scrubbed
environment, and only explicitly configured NVIDIA DLL directories on the child
search path. This is a local-files-only policy, not proven OS network isolation.

The settings page accepts trusted host paths and exact model/device/precision
choices. Material tools accept one internal SHA-256 asset ID and a bounded time
range; they cannot choose executables, model paths, commands or URLs. Restarts
require path confirmation; the host configuration is outside learning backups.
Model weights, environments and caches must never enter portable/source releases.

`models.json` pins Systran base and large-v3 revisions and hashes. All listed files,
including `tokenizer.json`, are verified before constructing WhisperModel. The host
passes this trusted data to Python. The script does not read a sibling JSON file.
Unpinned directory entries are refused, including a base-model
`preprocessor_config.json` or alternate vocabulary. Only inert `source.json`,
`README.md`, `LICENSE`, `.gitattributes` files and a `.cache` directory are allowed
outside the pinned set; they are not inputs to the pinned runtime's model loader.
An unexpected sidecar stops execution before importing or constructing the engine.
For Electron packages, unpack `tools/asr-worker/worker.py`; the host resolves it
under `app.asar.unpacked`. Keep `models.json` available to the Node module.

The validated runtime is Python 3.12, faster-whisper 1.2.1, CTranslate2 4.8.2 and
PyAV 18.1.0. `requirements.lock` records the ASR dependency closure. Before any
deliberate future installation, inspect the target Python/platform and NVIDIA
driver/runtime availability. Current upstream requires CUDA 12 cuBLAS and cuDNN 9
for recent CTranslate2. Do not assume every GPU supports these libraries or the
selected precision. See the [upstream requirements](https://github.com/SYSTRAN/faster-whisper#gpu).
This adapter neither installs them nor downgrades CTranslate2 automatically.

CPU int8 is displayed as explicit `int8_float32`, matching the actual CTranslate2
compute type. GPU may use explicitly selected `float16` or `int8_float16`. The
worker checks supported compute types and the actual loaded device, device index,
compute type, model revision and dependency versions. It fully consumes the
segments generator before success. Silence self-tests verify capability only;
Whisper can hallucinate speech and timestamps on silence. Raw timestamps remain
unchanged and out-of-range/non-speech evidence remains doubtful.

Input containers are restricted to independent WAV/MP3/OGG/WebM, decoded through
PyAV at mono 16 kHz with file-only protocol and bounded sample accumulation.
Source bytes are hash-checked and staged, never edited. Wall-time, input size,
output size, selected duration and a sampled Windows process-memory watchdog
bound each run. The watchdog covers process private bytes and working set; it
does not impose an atomic OS allocation cap or a GPU VRAM quota. OOM stops the run.

`createAsrWorker` requires `resolveAsset(assetId, request)`,
`publishArtifact({bytes,hash,mime,kind,parentHash,request})`, `artifactDir` and
`assertCurrent(request)` for material work. Publication must check current epoch,
job generation, source revision and candidate revision in the host transaction.
The adapter returns artifact references and transcribed/notChecked evidence;
`compareAsrEvidence` separately produces reversible relation-scoped comparison
evidence. Pass the artifact's `issues` as `asrIssues` to prevent doubtful engine
output from becoming matched. If engine issue evidence is omitted, comparison stays inconclusive. Neither API modifies source text or historical packs.

Protocol fixtures and simulated OOM tests run with Node. Actual CPU/GPU inference
and synthetic speech results belong in ignored `test-results/asr/`. They are
separate from human recordings, listening validation or an accuracy benchmark.
