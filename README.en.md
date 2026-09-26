# PracticeBridge for TOEFL

[中文](README.md) · English

**Turn the TOEFL practice material you already have into a question bank you can take in an exam-style interface.**

PracticeBridge for TOEFL is local practice software for the TOEFL iBT format introduced in January 2026. Import PDFs, Word files, text copied from web pages, or practice packs. The original files are kept, and the app works out the questions, options, answers, and which audio goes with which question. After you check the result, you can practice section by section with timers, and every attempt and retry stays on your computer.

![Overview](docs/screenshots/overview.png)

## What it does

- **Imports common materials for the new TOEFL.** Official ETS practice tests (student and teacher editions), full mock tests, single-task practice sets (such as Complete the Words, Build a Sentence, Listen and Repeat, Write an Email, Academic Discussion), and text copied from web pages. Anything it can't recognize stays in the material library with a note on what's missing.
- **Exam-style practice.** Reading, Listening, Writing, and Speaking across 12 task types: fill-in-the-word inside the passage, split-screen reading, word-tile sentence building, email and discussion editors, listen-then-record speaking, and more. Every stage has a countdown.
- **Two modes.** PRACTICE lets you work one section at a time, review, resume, and retry. TEST runs all four sections back to back with study aids turned off.
- **History and review.** Each attempt keeps a snapshot of the question and is marked as a first attempt or a retry. You can mark wrong answers for review and filter your history by section, task type, and date.
- **AI is optional.** Importing and practicing work without it. If you connect your own model, it can organize material the app couldn't read on its own, give written feedback on writing and speaking, and answer questions while you practice. The app tells you what will be sent before every request.

![Practice screen](docs/screenshots/practice.png)

## Getting started

**Windows portable build:** download `PracticeBridge-for-TOEFL-0.5.1-win-x64.zip` from this repository's Releases, unzip it, and run `PracticeBridge.exe` inside the folder. Keep the whole folder together; don't move the EXE out on its own. The build isn't code-signed, so Windows may show an "unknown publisher" warning the first time.

**From source:** requires Node.js 22.16 or later.

```powershell
npm ci --cache .cache/npm
$env:electron_config_cache = Join-Path (Get-Location) '.cache/electron'
node node_modules/electron/install.js
npm start
```

You can also run `npm run web` and open the local address shown in the terminal in your browser. The server only listens on `127.0.0.1`. `打开练习工作台.cmd` in the project root starts the packaged build if it finds one and falls back to the development build.

The first launch opens an empty workspace. To try it out, click **支持的格式** (supported formats) on the overview page, download the sample pack written for this project (9 questions and 3 synthetic audio clips; not official questions), and import it with **添加材料** (add material).

The interface is currently in Chinese; task names and the exam screens use the English TOEFL terms.

## Importing material

1. **Keep the originals.** Any file can go into the material library first. PDFs and their audio can go in the same batch, or you can paste text directly.
2. **Turn it into questions.** The app first tries to read it locally: PDFs with a text layer, DOCX, TXT, Markdown, practice-pack JSON, and ZIPs of these. It uses question numbers, options, answer keys, task headings, and page layout, so you never have to write any special format.
3. **Check it, then add it to your bank.** Drafts hide questions and answers by default. The author view lets you check and edit each item, then add the parts that are complete. Questions with a missing prompt, missing audio, or an unclear audio match stay behind until you fill them in.

Material the app can't read on its own can be sent to the model you connected, one block at a time. Before it starts, you see how many blocks there are and the maximum number of requests and tokens; each finished block is saved. If one block fails (for example, the reply is cut off or the model refuses), only that block is marked and the rest continue; later you can resend just the unfinished ones. The job stops and tells you why after 3 failed blocks in a row, a rejected API key, an exhausted quota, or a request whose outcome is unknown. It never resends on its own.

**Scans and images** can use optional English OCR. After you confirm the install under **模型与数据** (models and data), the app downloads the public language data; once OCR is enabled, pick pages and regions on the material page. OCR text never fills in questions automatically; you confirm it against the original image.

**Audio transcription** needs your own faster-whisper Python environment and model, configured and self-tested in settings. Transcripts only help you check the material; they aren't used for scoring.

For format details, see [input formats](docs/输入格式.md) and the [exam template](docs/机考模板.md) (both in Chinese).

## Practice and timing

Pick a test under **我的题库** (my question bank), start a section in PRACTICE, or switch to TEST for a full run. Default limits: 12 minutes per Reading module, 6 min 50 s for the whole Build a Sentence task, 7 minutes for Write an Email, 10 minutes for Academic Discussion, up to 45 seconds per Take an Interview answer, and 8, 10, or 12 seconds for Listen and Repeat depending on the item's position. Limits stated in your material take priority, and you can set your own under **计时设置** (timing settings).

In PRACTICE, the clock stops at 00:00 and you can keep answering; in TEST, time's up means time's up. The app doesn't implement the official adaptive routing and doesn't convert results to official scores.

## Connecting a model (optional)

Under **模型与数据**, choose the OpenAI API or any service compatible with Chat Completions (including a model server running on your own machine), then enter the base URL, model name, and API key. The service needs to support structured JSON output.

- By default the API key is only used for the current session; the Windows desktop app can also store it with system encryption. A key is bound to the service address you confirmed and is never written into backups.
- Every request starts with a click. The in-exam AI chat only sends the current page's question and your draft; hidden answers and listening transcripts are included only after you reveal them; audio and images are never sent.
- Speaking feedback is based on the transcript you listened to and confirmed. It doesn't assess pronunciation, accent, or intonation.
- Codex CLI support is limited to a capability check; it can't be used to process material or grade answers.

## Where your data lives

- The portable build keeps data in the `data/` folder next to the EXE; development mode uses `data/` in the project root. You can point elsewhere with the `PRACTICEBRIDGE_DATA_DIR` environment variable.
- Original files, question media, recordings, OCR output, and job progress all live in that folder. To move to another computer or upgrade, use **模型与数据 → 导出个人完整备份** (export full personal backup) rather than copying individual files. Restoring a backup first saves a snapshot of the current state.
- A question bank can be exported on its own as a ZIP to share. A personal backup contains your material and answers, so don't publish it.

## Development

```powershell
npm test
npm run check
npm run verify
npm run package
```

`npm run verify` runs every browser UI test by default and needs Microsoft Edge installed. Browser tests use a simulated microphone and local protocol fixtures and never call a paid model. See [the release checklist](docs/RELEASING.md), [CONTRIBUTING](CONTRIBUTING.md), and [SECURITY](SECURITY.md). The scope and skipped items of the latest automated check are recorded in [the verification summary](docs/verification-summary.json).

## Known limitations

- Only the task types of the January 2026 TOEFL are supported; older TPO formats aren't.
- Local recognition was tested on common layouts but won't handle every document. A structure check passing doesn't mean the questions or answers are correct, so review them before adding them to your bank.
- OCR and transcription accuracy depends on the source quality and your setup; the project's own tests only use self-authored images and audio.
- There's no official score conversion, installer, or automatic update. The portable build isn't code-signed and hasn't been tested on many machines yet.

## License and trademark

TOEFL® is a registered trademark of ETS. PracticeBridge for TOEFL is an independent project and is not affiliated with, endorsed by, or approved by ETS. "TOEFL" appears in the name only to describe the exam this software is for.

The code is under the [MIT License](LICENSE). The sample material written for this project is marked CC0-1.0 and is never imported automatically. Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md). Please don't commit a personal `data/` folder, backups, recordings, keys, or material you don't have the right to redistribute.
