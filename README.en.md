# PracticeBridge for TOEFL

[中文](README.md) · English

**Turn the TOEFL practice material you already have into a question bank you can take in an exam-style interface.**

PracticeBridge for TOEFL is local practice software for the TOEFL iBT format introduced in January 2026. Put in PDFs, Word files, text copied from web pages or practice packs. The app keeps the originals, then works out the questions, options, answers and which audio goes with which question. Once you've checked the result, you can practice section by section with timers, and every attempt and retry stays on your own computer.

It's free and needs no account. Importing and practicing run entirely on your computer, offline.

**At a glance**: free · open source (MIT) · Windows 10/11 portable · no account · imports and practice work offline · TOEFL iBT task types from January 2026 only · no official questions included, you import your own material · not affiliated with ETS. Project page: <https://2rr6.github.io/PracticeBridge-for-TOEFL/en.html>

The interface is currently in Chinese. The steps below give each button's Chinese label so you can find it; the exam screens themselves use the English TOEFL terms.

![Overview](docs/screenshots/overview.png)

## Contents

- [What it does](#what-it-does)
- [Download and open (Windows)](#download-and-open-windows)
- [First run: try the sample pack](#first-run-try-the-sample-pack)
- [Import your own material](#import-your-own-material)
- [Scanned PDFs: install English OCR](#scanned-pdfs-install-english-ocr)
- [Practice](#practice)
- [Connect an AI model (optional)](#connect-an-ai-model-optional)
- [Back up, move computers and upgrade](#back-up-move-computers-and-upgrade)
- [FAQ](#faq)
- [Known limitations](#known-limitations)
- [For developers](#for-developers)
- [License and trademark](#license-and-trademark)

## What it does

- **Imports common materials for the new TOEFL**: official ETS practice tests (student and teacher editions), full mock tests, single-task practice sets (Complete the Words, Build a Sentence, Listen and Repeat, Write an Email, Academic Discussion and more), text copied from web pages, and scanned PDFs.
- **Exam-style practice**: Reading, Listening, Writing and Speaking across 12 task types, with a countdown at every stage.
- **Two modes**: PRACTICE lets you work one section at a time, review, resume and retry. TEST runs all four sections back to back with study aids turned off.
- **History and review**: every attempt is saved; wrong answers can be marked for review, and the analysis page filters by section, task type and date.
- **AI is optional**: connect your own model to organize material the app can't read on its own, get written feedback on writing and speaking, or ask questions while you practice.

## Download and open (Windows)

You need Windows 10 or 11 (64-bit).

1. Open this repository's [Releases page](https://github.com/2rr6/PracticeBridge-for-TOEFL/releases) and download the file named **`PracticeBridge-for-TOEFL-<version>-win-x64.zip`** under the latest release (about 200 MB).
2. **Right-click the ZIP → Extract All**, and pick a folder you can find again, such as `D:\PracticeBridge`.
   Don't run it from inside the ZIP; the app can't save your records there.
3. Open the extracted folder and double-click **`PracticeBridge.exe`**.
4. The first time, Windows may show a blue "Windows protected your PC" window. The app isn't code-signed, which is why. Click **More info → Run anyway**. It won't ask again.
5. For quicker access, right-click `PracticeBridge.exe` → **Send to → Desktop (create shortcut)**.

> Keep the whole folder together; don't move `PracticeBridge.exe` out on its own. All your records are stored in the `data` folder next to it.

## First run: try the sample pack

The question bank starts empty. The app includes a sample pack written for this project (9 questions and 3 synthetic audio clips; not official questions), which is a good way to learn the steps:

1. On the overview page, click **支持的格式** (supported formats) at the top right, then **自编练习包（含合成音频）** (sample pack with synthetic audio), and save the ZIP.
2. Click **添加材料** (add material), drag the ZIP into the dashed box (or click the box to choose it), then click **保存原件到材料库** (save to the material library).

   ![Add material](docs/screenshots/import.png)

3. You'll land on the page for this batch. Open **只在本机处理** (process locally only) and click **本地检查并整理** (check and organize locally).

   ![Choose how to process](docs/screenshots/material.png)

4. The review page sorts questions into "scorable", "practice without a score" and "needs more information". Click **选择全部可用题** (select all usable) → **加入所选可用部分** (add the selected part). "本次新增 9 道题" (9 questions added) means it worked. Click **打开部分练习** (open practice) to start.

   ![Review and add to the bank](docs/screenshots/review.png)

## Import your own material

The steps are the same: **添加材料 → 保存原件到材料库 → 只在本机处理 → 本地检查并整理 → select questions and add them**.

**What you can put in**

| Type | Notes |
| --- | --- |
| PDF | PDFs with selectable text work best. Scanned PDFs need English OCR, see the next section |
| Word (.docx) | Text and tables are read directly |
| Text | .txt, .md, or paste web page text via **或者，粘贴文字材料** (or paste text) on the add-material page |
| Audio | .mp3, .wav and similar, in the same batch as the questions; the app matches them by file name and question number where it can |
| Archives | A ZIP of the above; **选择材料文件夹** (choose a folder) picks a whole folder at once |

A PDF or Word file can be up to 64 MB, other files up to 25 MB, and a batch up to 80 MB in total.

**Reading the result**

- **Scorable**: complete questions with an answer key; your answers are marked right or wrong.
- **Practice without a score**: for example writing and speaking tasks, or questions without an answer in the material.
- **Needs more information**: missing a prompt, options or audio. They stay with the batch until you complete them or add a fuller version.

**Please check the result.** The app reads questions from the layout and can't be right every time. Tick **作者校对视图（会显示题面与答案）** (author view, shows prompts and answers) to see every question and answer, and fix anything that's wrong.

**If nothing comes out**

- A note saying a page "has no text layer" means it's a scan: install English OCR and process it again, see below.
- Unusual layouts may not be read fully on your computer. Connect an AI model and let it organize the material block by block (see "Connect an AI model").
- The originals always stay in the material library, even if processing fails.

## Scanned PDFs: install English OCR

OCR reads text from images. Once it's installed, the app **reads scanned pages automatically** when it processes material; you don't have to go page by page.

![English OCR settings](docs/screenshots/ocr-settings.png)

1. Click **模型与数据** (models and data) on the left and find the **本机扫描件 OCR** (local scan OCR) card.
2. Open **安装范围与位置** (install size and location), tick **我确认上述下载上限和安装位置** (I confirm the download limit and location), then click **下载并安装英语数据** (download and install English data). This needs the internet once.
3. When it's installed, click **启用 OCR** (enable OCR). **运行自编英文图片自检** (run the self-test) confirms it works.
4. Go back to the material and click **本地检查并整理** again. The material card shows progress such as "正在识别扫描页 8/35" (reading scanned page 8 of 35). Each page takes a few seconds, so you can do something else meanwhile.

Questions from scanned pages are marked "扫描识别" (read from a scan).

**On scanned pages an answer is left blank rather than given wrong.** Local OCR tends to read a C as 0, an l as I, and miscount the blanks in Complete the Words. So for scanned pages the app only keeps answers that pass checks for their task type (a Build a Sentence answer must use the tiles exactly, a Complete the Words answer must fit its blanks), leaves anything uncertain blank, and says why in the processing result.

### Let AI proofread scanned pages against the image (recommended)

If you connect an AI service that accepts images under **模型与数据** (models and data), a button **用 AI 看图校对扫描页** (proofread scanned pages with AI) appears on the material page and the review page after a scan is processed. Tick the box confirming what will be sent and click it: the app sends each page image together with the locally read text, the AI corrects each line against the image, and the material is processed again automatically. Each page is proofread once and kept on your computer, so processing it again costs nothing.

We tested with 15 practice materials that have answer keys (about 400 pages, including official ETS practice tests and workbooks), turned into simulated scans:

| | Local OCR only | Local OCR + AI proofreading |
|---|---|---|
| Wrong answers among those given | 0 (of 1142 given, across normal, blurred/tilted and phone-photo quality) | 0 (of 282 given) |
| Questions with a confirmed answer | about 60% for normal scans, 50% blurred or tilted, 30% phone photos; the rest left blank | about 88% |
| Cost | free | billed by your AI service; with DeepSeek-V4.1-Flash, which we tested, a 35-page practice test took about 0.3 CNY and one minute |

The AI column covers only 5 materials, and the simulated scans use clean print; real phone photos, handwritten notes and copies of copies may do worse. Questions not marked "扫描识别" come from the PDF's own text and are not affected by OCR.

To check yourself, tick **作者校对视图** (author view) on the review page: scanned questions show two crops of the original, one at the start of the question and one at its answer-key row, so you don't need to open the PDF.

## Practice

1. Click **我的题库** (my question bank) on the left to see an exam-style list.
2. **PRACTICE**: click **未开始** (not started) under a section to practice it. If you leave, **继续练习** (continue) picks up where you stopped.
3. **TEST**: switch to TEST at the top and click **开始整套测试** (start full test) to take all four sections in a row, without study aids.
4. Afterwards, review every attempt under **学习分析** (analysis); mark wrong answers for review or retry them.

**Default time limits**: 12 minutes per Reading module; 6 min 50 s for the whole Build a Sentence task; 7 minutes for Write an Email; 10 minutes for Academic Discussion; up to 45 seconds per interview answer; 8, 10 or 12 seconds for Listen and Repeat depending on the item. Limits printed in your material take priority, and **计时设置** (timing settings) on the question-bank page lets you set your own.

In PRACTICE the clock stops at 00:00 and you can keep answering; in TEST, time's up means time's up.

![Practice screen](docs/screenshots/practice.png)

**Speaking** needs a microphone. If nothing is recorded, check Windows **Settings → Privacy & security → Microphone** and allow desktop apps to use it.

## Connect an AI model (optional)

Importing and practicing work without AI. With a model connected you can:

- have AI organize material the app can't read on its own;
- have AI proofread scanned pages against their images and fill in answers the local reading wasn't sure of (needs a model that accepts images, see "Let AI proofread scanned pages against the image" above);
- get written feedback on writing and speaking;
- click **AI 对话** (AI chat) during practice to ask questions.

**What you need**: a supported model service and its API key, such as the OpenAI API or any service compatible with the OpenAI interface, including a model running on your own computer. Usage is billed to your own provider account; this app charges nothing.

**Setup**

1. Click **模型与数据** on the left and pick the service type under **接入方式** (connection).
2. Fill in **服务地址** (base URL), **模型名称** (model name) and **API Key**, then click **保存配置** (save).
3. Tick the consent box for a short test message and click **测试已保存的连接** (test the saved connection).

**Privacy and cost**

- Before anything goes online, the app tells you what will be sent; nothing is sent unless you tick the consent box.
- Before AI organizes material, you see the maximum number of requests and tokens, and it starts only after you confirm.
- By default the API key is used only while the app is open; you can also choose to store it with Windows encryption. Keys are never written into backups.
- Recordings are never sent to AI; speaking feedback uses the transcript you confirmed and doesn't judge pronunciation.

## Back up, move computers and upgrade

**Everything lives in the `data` folder inside the app folder**: original files, question banks, attempts and recordings.

- **Back up**: **模型与数据 → 导出个人完整备份** (export full personal backup) gives you a ZIP. Keep a copy on a USB drive or cloud storage now and then.
- **Move to another computer**: download the app there, then **模型与数据 → 从个人备份恢复** (restore from backup), choose the file and confirm.
- **Upgrade to a new version**:
  1. Export a full backup from the old version first, just in case;
  2. Download and extract the new version to a new folder;
  3. Close the old version and copy its whole `data` folder next to the new `PracticeBridge.exe`;
  4. Open the new version; your records are there. Restoring from the backup works too.
- **Share a question bank**: the question-bank page can export a bank on its own. A personal backup contains your material and answers, so don't share it publicly.

## FAQ

**How can I turn TOEFL practice PDFs into exam-style practice?**
Download the app, add your PDF with **添加材料**, then choose **只在本机处理 → 本地检查并整理**. The app finds the questions, options and answers; after you check them, add them to your question bank and practice section by section with timers. See "First run" above for every step.

**Is there a free practice app for the 2026 TOEFL iBT format?**
This app is free and open source, built for the TOEFL iBT task types introduced in January 2026 (the new Reading, Listening, Writing and Speaking tasks), needs no account and works offline.

**Does it include TOEFL questions?**
No official questions are included. It turns practice material you already have (such as ETS practice tests, mock tests or workbooks) into a question bank you can take; only a 9-question self-authored sample pack is included to try it.

**Nothing happens when I double-click, or my antivirus blocks it.**
Make sure you extracted the ZIP and are running `PracticeBridge.exe` from the extracted folder. If your antivirus blocks it, add the folder to its allowed list. The app is open source; the code is in this repository.

**No questions came out of my import.**
Open the batch and read the notes under the processing result. "No text layer" means a scan: install English OCR first. Otherwise, try AI processing or a text version of the material.

**Can I use a scanned workbook? Are its answers reliable?**
Yes. With English OCR installed, scanned pages are read automatically, and answers the local reading isn't sure of are left blank rather than guessed. Connect an AI that accepts images and click **用 AI 看图校对扫描页** to fill in most of them. See "Let AI proofread scanned pages against the image" above.

**An answer read from my material is wrong.**
On the review page, tick the author view to edit the prompt, options and answer, then add the question again.

**Will I lose progress if I close the app mid-test?**
No. Drafts are saved automatically; continue from "继续上次的练习" on the overview page or "继续练习" in the question bank.

**Does it cost anything? Does it need the internet?**
It's free and needs no account. Importing and practicing are offline; it goes online only when you use AI or download the OCR data.

**Does it run on a Mac?**
Only a Windows build is provided for now. On a Mac you can run the browser version from source (see "For developers"), but it hasn't been fully tested.

## Known limitations

- Only task types of the January 2026 TOEFL are supported; older TPO formats aren't.
- Local reading was tested on common layouts but won't handle every document; check questions and answers before adding them.
- Scanned material depends on OCR: answers the local reading isn't sure of are left blank, and most of them need AI proofreading to be filled in; handwriting can't be read.
- No official score conversion, installer or automatic update; the app isn't code-signed and has been tested on only a few computers.

## For developers

Running from source needs Node.js 22.16 or later:

```powershell
npm ci --cache .cache/npm
$env:electron_config_cache = Join-Path (Get-Location) '.cache/electron'
node node_modules/electron/install.js
npm start
```

`npm run web` runs the browser version at the local address shown in the terminal; the server only listens on `127.0.0.1`. `打开练习工作台.cmd` in the project root starts the packaged build if there is one.

```powershell
npm test
npm run check
npm run verify
npm run package
```

`npm run verify` runs every browser UI test by default and needs Microsoft Edge; the tests use a simulated microphone and local protocol fixtures and never call a paid model. See [input formats](docs/输入格式.md) and the [exam template](docs/机考模板.md) (in Chinese), [the release checklist](docs/RELEASING.md), [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md). The latest automated check is recorded in [the verification summary](docs/verification-summary.json).

## License and trademark

TOEFL® is a registered trademark of ETS. PracticeBridge for TOEFL is an independent project and is not affiliated with, endorsed by, or approved by ETS. "TOEFL" appears in the name only to describe the exam this software is for.

The code is under the [MIT License](LICENSE). The sample material written for this project is marked CC0-1.0 and is never imported automatically. Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md). Please don't commit a personal `data` folder, backups, recordings, keys, or material you don't have the right to redistribute.
