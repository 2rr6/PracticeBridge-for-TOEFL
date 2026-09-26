# Third-party components

PracticeBridge application code is MIT licensed. The Windows runtime includes these principal components:

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| Electron | 44.3.0 | MIT | Desktop runtime; includes Chromium and Node components with their own notices |
| @zip.js/zip.js | 2.14.0 | BSD-3-Clause | Bounded asynchronous ZIP reading and writing |
| Ajv | 8.17.1 | MIT | Strict package and material schema validation |
| mammoth | 1.12.2 | BSD-2-Clause | DOCX text extraction |
| pdfjs-dist | 6.3.289 | Apache-2.0 | PDF text extraction and rendering |
| @napi-rs/canvas and its Windows x64 native package | 1.0.9 | MIT | Local PDF/page rasterization |
| tesseract.js | 7.0.0 | Apache-2.0 | Optional local OCR adapter |
| tesseract.js-core | 7.0.0 | Apache-2.0 | OCR core JavaScript and WebAssembly |

The lockfile records transitive versions. Distributed dependency directories retain their licenses; the portable Electron folder also includes Electron/Chromium license files. Playwright and @electron/packager are development tools and are removed from the packaged runtime.

The exact reviewed OCR runtime file set is recorded in `assets/ocr-runtime-lock.json`; its retained dependency README, license, type and test files are an explicit file-by-file packaging exception. They are not permission to ship project test results, private materials or arbitrary future dependency files. The separate physical launch inventory records the actual startup, PDF/canvas and shared runtime files.

## Optional local assets and tools

English language data is downloaded only through a separately confirmed optional installation. The fixed `@tesseract.js-data/eng` 1.0.0 package metadata declares MIT; the publisher's upstream data repository carries an [Apache-2.0 license notice](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE). These are separately identified provenance records, not a claim that the language data is PracticeBridge-owned. Its archive integrity and installed language-file hash are checked against the approved asset record.

Python, faster-whisper/CTranslate2, local ASR model weights, FFmpeg and GPU libraries are user-configured external tools. Their environments, binaries and model directories are not included in the portable or source archive. The included ASR worker and dependency/model descriptions are host integration code and setup records; they do not grant or replace the upstream licenses for separately installed components.

## ZIP boundary and dependency checks

The ZIP adapter accepts only stored/deflated, unencrypted archives. It checks portable paths, duplicate names, special file attributes, declared sizes, actual streamed output, CRC and cancellation. DOCX containers receive a separate budget before Mammoth sees a canonical archive of validated bytes. Test-only raw ZIP fixtures intentionally construct malformed headers; they are never used by the application.

Historical npm advisory queries on 2026-09-12 completed for the then-current runtime and development dependency trees, each exit 0 with zero reported advisories. That snapshot predates the pinned OCR addition and is not an advisory result for the 0.5.0 release. Release security reports and SBOMs are generated from each actual staged artifact and identify its hashes, tool versions and scan outcomes. Offline or failed scans do not establish zero advisories.

fast-check 4.10.0 (MIT) is a development-only dependency for reproducible property tests. `node scripts/dependency-inventory.mjs` regenerates [the locked dependency inventory](docs/development/DEPENDENCIES.json) after dependency changes; it does not query advisories.

## Example material

Examples in `public/examples/` are original synthetic fixtures, not third-party test questions. Their metadata identifies them as CC0-1.0 examples. The three WAV prompts were generated locally with a Windows built-in speech voice and are explicitly labeled synthetic. Browser capture tests use a fake microphone input. Neither should be presented as human speech evidence or an official examination recording.
