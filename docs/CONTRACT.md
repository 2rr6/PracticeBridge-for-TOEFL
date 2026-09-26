# PracticeBridge 0.4 集成合同

0.5 候选编译补充：新生成的正式部分练习使用 `schemaVersion: 2`，按 [v2 规范](practicebridge.v2.schema.json) 校验原始题位、候选来源和范围标记。[v1 规范](practicebridge.schema.json) 继续服务旧题包与现有模型协议；旧原件与哈希不迁移。以下 0.4 说明保留其历史版本语境，输入的版本分派见 [输入格式](输入格式.md)。

本文件按 2026-09-10 的实现记录输入、运行时计划、模块会话和备份边界。`0.4.0` 是软件版本；题包的 `schemaVersion` 仍为 `1`，机考执行扩展为 `examContractVersion: 1`，新会话为 `sessionVersion: 2`。它们不是同一个版本号。文末保留更新前的 0.2 合同原文，旧接口继续兼容；新增模块会话以本节为准。

## 运行环境与身份

应用使用 Node.js ≥ 22.16、ESM 本地服务、`public/` 浏览器界面和 Electron 桌面窗口。服务只绑定 `127.0.0.1`，检查 Host 与 Origin；写请求使用 JSON，并携带 `X-PracticeBridge: 1`。失败返回 `{error: "可读的原因"}`。本地数据位于配置的 `dataDir`，使用串行事务和原子文件替换保存。

- `id` / `version` 是题包作者提供的内容标识。应用不会替作者自动递增 `version`。
- `libraryId` 是导入后的本地题库身份；`contentHash` 绑定规范题包和引用媒体。相同内容重复导入返回已有题库，改变内容后形成新的题库身份。
- `questionId`、`groupId` 是稳定内容引用；屏幕上的题号可以按科目、模块或任务重新编号。
- `session.id` 标识一轮练习，`session.revision` 用于草稿并发校验。`writerToken` 与 `/api/state` 的 `workspaceEpoch` 是本次服务运行或恢复后的临时写入凭据，不写进状态文件或备份。
- API Key 只在服务进程内存中保存。非密钥模型配置独立保存；模型设置文件与密钥不进入个人备份，材料／反馈任务可以保留 provider、baseUrl、model 等无密钥的处理标识。

## 统一内容模板

规范题包在 ZIP 根目录使用 `practicebridge.json`；也可提交 JSON 和单独选择的媒体。媒体引用使用相对路径，运行时 URL 不得写回原生题包。字段定义见 [机考模板](机考模板.md) 与 [规范 Schema](practicebridge.schema.json)。

```text
examSets[] → sections[] → modules[].taskIds[]
                                      ↓ 引用 groups[].id
groups[] → questions[]
```

套题、科目和模块保存顺序与引用，题目只保存在 `groups[].questions`。带 `examSets` 的题包必须同时声明 `examContractVersion: 1`、`minReaderVersion: "0.3.0"`。同一套计划不能重复引用同一道题，任务类型必须与科目和底层作答类型对应。

| `taskKind` | 科目 | 基础 `type` | 作答呈现 |
| --- | --- | --- | --- |
| `complete_words` | reading | `fill_blank` | 原文内逐字母空位，同屏保存多个答案 |
| `read_daily` | reading | `single_choice` | 日常材料与题目并列 |
| `read_academic` | reading | `single_choice` | 文章与题目并列，可带明确选句／插句位置 |
| `listen_response` | listening | `single_choice` | 听题后选择回应 |
| `listen_conversation` | listening | `single_choice` | 共用对话后依次作答 |
| `listen_announcement` | listening | `single_choice` | 共用通知后依次作答 |
| `listen_talk` | listening | `single_choice` | 共用讲座后依次作答 |
| `build_sentence` | writing | `sentence_order` | 稳定词块 ID 填入固定句框，可含干扰词块 |
| `write_email` | writing | `email` | 情境／任务点与邮件编辑区 |
| `academic_discussion` | writing | `discussion` | 教师问题、学生观点与回应编辑区 |
| `listen_repeat` | speaking | `listen_repeat` | 播放原句后录音 |
| `interview` | speaking | `interview` | 播放面谈问题后录音 |

正文缺字使用 `inlineBlanks` 的 UTF-16 半开区间和正文哈希定位；保留固定前缀、后缀和标点，答案仅为缺失字母。位置来自原文，不能用答案倒造空位。阅读 `question.interaction` 仅支持 `sentence_select` 与 `sentence_insert`，均保存一个候选 ID；插句恰好有四个零长位置。未知交互不能作为额外字段静默丢弃。

`presentation.document` 的规范块为 `heading`、`paragraph`、`table`，文档类别为 `notice`、`email`、`social_post`、`academic`、`plain`。邮件字段为 `to`、`subject`、`instructions`、`body`；讨论字段为 `prompt`、`posts[{speaker,text}]`、`instructions`。现有 Schema 不等同于任意 HTML 布局或供应商全部文档子类型。

`group.transcript` / `question.transcript` 是材料原稿，与学生答案及其录音转写分开。听力刺激和作答界面不自动显示原稿。PRACTICE 可主动打开辅助并留下 `assisted` 标记；TEST 不提供答案、原稿或翻译辅助入口。

## 材料接收与 AI 输出

原件先进入材料库，之后才进行 ZIP 检查、提取、AI 评估或本机转换。未知扩展名、损坏 ZIP 或没有可提取正文的文件可以保存原件，但不会因此被标为可练习题库。文件名、base64 编码与资源容量检查仍适用。一次接收不触发模型请求。

AI 与本机转换器最终都返回相同的题包结构，经过 `validatePackage` 后进入同一草稿和提交路线。`NORMALIZED_PACKAGE_SCHEMA` 是规范字段来源；`PACKAGE_SCHEMA` 为严格模型协议补上必需但可空的扩展字段。模型中的可选 `null` 先规范化为缺失，再交给本机校验。发布的 Schema 与此规范结构由测试核对。

为兼容旧包和旧模型响应，无 `examSets`、`taskKind` 等扩展的基础 v1 包仍被接受，并在运行时建立练习计划；不会向原包补写推测的来源元数据。因而“统一模板”表示共享数据合同、校验与渲染路线，不表示每次模型输出都已具备完整原始版式。

模型只收到本机提取的文字与文件清单，不收到原始音视频二进制。无法核对的题目文字、答案、排版字段、时限或媒体关联会被清空、拒绝或列为复核项；内容校验不证明全部语义正确。文件名关联采用 `basis: "filename"`、`verifiedContent: false`，不能冒称听过音频。

## 模块会话 v2

创建：

```text
POST /api/sessions
{
  sessionVersion: 2,
  libraryId,
  setId?, sectionId?, groupId?,
  mode: "practice" | "exam",
  preset?: "document" | "untimed" | { ...自定义秒数字段 },
  legacySessionId?, writerToken?
}
→ { session }
```

省略选择字段时使用题包的默认套题；`groupId` 可限制为一个任务。`legacySessionId` 将旧题组草稿投影为新会话，保留旧记录及其计时快照；已有未完成投影会被复用。不能在恢复时更换原题组或模式。

| 会话字段 | 含义 |
| --- | --- |
| `planSnapshot` | 创建时冻结的 `{version:1,id,title,sections}` 运行计划，内含模块、任务、计时、导航、说明和呈现字段 |
| `sourceHash` / `selection` | 本轮内容身份与范围 |
| `cursor` | `{sectionId,moduleId,taskId,questionId,phase,phaseIndex}` |
| `answers` | 按题 ID 保存 `{answer,recordingId,recordingUrl,transcript,transcriptConfirmed,attemptId}` |
| `moduleStates` | 各模块的 `pending` / `active` / `submitted` 状态、锁定任务／题目和提交回执 |
| `timers` / `activeTimerId` | 服务端时钟集合与当前时钟 |
| `paused` / `assisted` / `finished` | 暂停、曾使用辅助、整轮完成状态；`assisted` 一旦为 true 不可改回 false |
| `revision` / `startedAt` / `updatedAt` | 草稿版本和时间 |
| `legacySessionId` / `priorTimingSnapshot` | 旧会话引用与原逐题计时快照 |
| `writerToken` / `serverNow` / `elapsedSeconds` | API 视图补充的临时令牌、服务端时间与已用时间，不是题包字段 |

`GET /api/sessions/:id` 返回 `{session}`。新会话的规范页面地址包含实际 `session.id`；无会话 ID 的旧入口创建成功后会改写地址，刷新继续同一轮。打开续做页不会自动播放或开启麦克风。

草稿更新：

```text
PATCH /api/sessions/:id
{
  writerToken, expectedRevision,
  answers?: { questionId: { answer?, recordingId?, transcript?, transcriptConfirmed? } },
  cursor?, marked?, visited?,
  timer?: { action: "pause" | "resume" },
  assisted?, capturedAt?
}
→ { session }
```

答案也接受字符串、字符串数组或 null 的简写。`recordingUrl` 由服务端按已保存的 `recordingId` 重建，不能指定任意 URL；`attemptId` 只能保留已有值。请求不能改写 `planSnapshot`、来源、剩余秒数或已封存答案。`expectedRevision` 必须匹配当前版本；恢复备份或重启后的旧 `writerToken` 即使碰巧对应相同 revision 也会被拒绝。

阶段为 `instructions`、`directions`、`stimulus`、`prepare`、`response`、`saving`、`recorded`、`review`、`completed`。`completed` 只能由提交产生。`phaseIndex` 保留说明或刺激序列的位置；换题或换阶段时默认回到 0。阅读可在当前模块使用 Back / Review；听力和口语向前切题后锁定旧题；写作离开任务后锁定该任务。具体导航保存于冻结计划。

草稿会话可以继续保存，冻结计划和已提交作答不可变。逐题 `Next` 不自动制造新的 attempt；模块提交才统一建立或复用该模块的作答记录。

```text
POST /api/sessions/:id/commit-module
{
  writerToken, expectedRevision, moduleId, submissionId,
  sectionId?, answers?, reason?: "manual" | "timeout", capturedAt?
}
→ { session, attempts, finished, replayed }
```

一次事务先核对本模块全部答案和录音，再封存整批，包括未作答和只排了一部分词块的题目。模块只封存一次。重复相同请求返回已有回执；相同提交 ID 用于不同内容、不同模块或另一轮时返回冲突。更换提交 ID 也不能覆盖已封存模块；只有与原请求语义相同的重试会复用回执。

新 attempt 带 `runContext: {sessionId,sectionId,moduleId,taskId,batchId,timerScope}`。共享计时保存在会话，新的模块 attempt 的 `durationSeconds` 为 0，不把一段模块时长重复记到每一道题。旧 attempt 的原时长和原快照保持不变。作答内容不能编辑；`reviewed` 可以更新，反馈可追加到固定 attempt。

## 计时与录音

`preset` 默认为 `document`。可提供 `readingModuleSeconds`、`listeningQuestionSeconds`、`sentenceTaskSeconds`、`repeatSeconds`、`interviewSeconds`，兼容接口仍接受 0–7200 的整数秒，但新策略把 0 / untimed 转为有限的默认倒计时。UI 自定义输入为 1–7200 秒，Interview 为 1–45 秒。

任务继承模块时，以模块计时为准。`timePolicyVersion:2` 对阅读模块和组句任务执行用户指定标准 720／410 秒，优先于题包声明，API 显式自定义字段仍优先。跟读无可靠逐题时限时，按当前任务的 questionIds 顺序使用 8、8、10、10、10、12、12 秒；其余来源／默认规则保持。原计划缺失数字仍保留 null，执行策略不冒充来源。默认数值由前后端共享的 `public/exam-timing.mjs` 定义。Interview 无条件逐题限 45 秒，较长来源／自定义值保存在 requestedDurationSeconds，实际限时独立记录。

默认机考计划中，阅读按模块共享时钟；组句、邮件和讨论按任务共享；听力从作答阶段计每题时间；口语准备与回答使用不同的时钟。任务说明、听题和录音保存不占用回答倒计时。模块 `instructions.audio` 在说明页播放，TEST 播完后才能 Begin；PRACTICE 可确认跳过并标记辅助，模块说明播放不启动回答时钟。计时对象记录作用域、依据、消耗量、启动／暂停／截止时间；视图另给 `remainingSeconds`、`elapsedSeconds`、`running`、`expired`。

TEST 和口语仍由服务端拒绝超时后更改答案。截止前最后一秒捕获、且到达不晚于截止后一秒的输入有有限缓冲；按时停止的口语录音可以在保存阶段继续完成绑定，最多延续 120 秒，不开放晚到的文字改答。PRACTICE 的非口语倒计时结束后停留当前页，显示 00:00，允许继续练习编辑；推进、锁定和提交仍由用户明确操作，已经提交或锁定的内容不能改写。

TEST 整套入口只限定 libraryId／setId／mode，不限定科目；整套续做只匹配相同完整范围。旧单科会话保留但不当作整套续做。TEST 在任务和模块边界直接推进，不自动进入 review，不要求逐模块二次确认；保留说明、刺激音频、准备和录音阶段。PRACTICE 保留回顾；回顾页顶部 Continue 提交相应范围，Return to Question 返回当前题。

`POST /api/recordings {name,data,uploadId?}` 先保存录音（可选 UUID 上传标识使相同内容重试幂等；同一标识换内容返回 409），返回 `{recordingId,url}`，再写入会话。客户端录音捕获绑定题目、会话和工作区令牌；等待最后一块录音数据与上传完成后才切题。失败保留本页待保存文件，可重试或另存。TEST 已保存回答不提供重录；PRACTICE 重录会标记辅助。缺少题目音频的听说模块在说明页提示并阻止 Begin。

新录音经过预调度 Web Audio 门控，再以实际解码采样帧截至本次剩余预算并保存为 PCM WAV；原有录音不裁剪。到期停止后停留于本题，等待 Next。未完成旧会话通过 PATCH／提交幂等升级，保留 timePolicyUpgrade 中的旧时钟、设置与录音关联；已提交模块与已完成会话保持历史策略。最后用户活动时间 lastUserActivityAt 与后台保存时间分开，供续做排序使用。

跟读执行时钟固定为逐题；整组来源时长保留为来源信息，缺少可靠逐题值时回退软件默认。真实旧 v2 口语共享时钟若无法确定当前题预算，暂停并返回 `timingInterruption`，保存原时钟表、原暂停状态与位置；仅允许保存暂停／退出，新作答、继续和提交均拒绝。用户可主动创建新一轮。恢复先按旧合法时钟定义核验该中断快照，不放宽任意历史字段。

## 题面 AI 对话

`POST /api/chat` 增加 `context:{sessionId,writerToken,expectedRevision,moduleId,taskId,questionId,phase}`、`requestId` 和可选 `conversationId`。服务端核对当前位置、版本与模式，从冻结计划生成文字快照；忽略客户端任意 history，按服务器保存的题目／可见内容分支历史继续。结果增加 `conversationId`、`contextSnapshotId`、`scopeKey`。

`POST /api/chat/exposure {context,helper:null|"answers"|"transcript"}` 记录本次显式打开的辅助面板，要求 PRACTICE 且已标记辅助。默认上下文无隐藏答案／原稿；收起后历史分支隔离。发送先保存最新草稿，冻结后不重新查询当前题。对话缓存在本地进程与页面会话内，重启不自动重发。未完成 TEST 禁止题面聊天、其中已提交 attempt 的聊天和 AI feedback；整轮完成后开放。

## 本地接口汇总

以下响应均为 JSON，下载与媒体除外。材料、旧 attempt、聊天和设置接口沿用 0.2 结构。

| 接口 | 当前行为 |
| --- | --- |
| `GET /api/state` | `{libraries,materials,attempts,sessions,jobs,settings,workspaceEpoch}`；材料摘要不包含粘贴全文与完整草稿 |
| `POST /api/materials` | `{files?,text?,title?} → {material}`，保存原件后再处理 |
| `GET /api/materials/:id` | 完整本地材料记录，包括评估／草稿状态 |
| `GET /api/materials/:id/originals/:index` | 按原文件序号下载附件 |
| `POST /api/materials/:id/assess` | `{useAI?,consent?} → {material}`；`useAI` 默认 true；本机路线 `useAI:false` 无发送 |
| `POST /api/materials/:id/convert` | 同样选择 AI／本机路线，需要匹配的先前评估；返回草稿预览及材料引用 |
| `GET /api/materials/:id/draft` | 重开持久草稿，不要求重传原件 |
| `POST /api/import/preview` | 旧直接预览入口，保留兼容；不直接新增正式题库 |
| `POST /api/import/validate` | `{draftId,pack}`，校对后重验；材料草稿同时持久保存 |
| `POST /api/import/commit` | `{draftId,pack,acknowledged:true} → {library}`；再次验证，内容相同则去重 |
| `GET /api/library/:libraryId/export` | 导出原包与原包明确引用的媒体；路径是单数 `library` |
| `GET /api/media/:hash`、`HEAD` | 校验后的已登记媒体，支持 Range |
| `GET /api/exam-media/:materialId/:hash`、`HEAD` | 从材料原件重建的兼容说明媒体，支持 Range |
| `GET /api/backup` | 原件、材料草稿、题库、会话、作答、录音和反馈的个人备份 |
| `POST /api/restore` | `{file:{name,data}} → {restored:true}`；完整验证后替换，并保存替换前快照 |
| `POST /api/attempts` | 保留逐题提交接口；新机考界面使用模块提交 |
| `PATCH /api/attempts/:id` | `{reviewed:boolean}` |
| `POST /api/attempts/:id/feedback` | `{consent:true,transcript?,transcriptConfirmed?} → {job}`；只追加到捕获的 attempt |
| `POST /api/chat` | `{message,history?,consent,context?:{attemptId}} → {reply,provider,model}` |
| `POST /api/settings` | 保存非密钥设置；`apiKey` 只更新内存，`clearApiKey:true` 清除内存密钥 |
| `POST /api/settings/test` | `{consent}`，用户主动发起连接检查 |

AI 评估状态为 `processable`、`partially_processable`、`needs_information`、`unsupported`，处理器为 `native`、`exam-document`、`worksheet`、`ai`。模型提供方支持 `none`、`openai`、`compatible`、`codex`；结构化协议为 `auto`、`json_schema`、`json_object`，自动模式只对精确匹配的 DeepSeek 官方主机选择 JSON Object。反馈不生成官方数字分数，不把纯文字反馈当成发音测量。

## 旧题库投影与备份

普通旧 v1 包通过运行时计划进入新界面。对先前本机文档转换器生成、ID 与 PDF 来源符合已知约定、且保留关联原件的旧模块题库，`exam-overlay.mjs` 另外读取原 PDF 与音频 ZIP：按唯一的科目／模块／题型／题号范围补充任务 Directions，并在原 PDF 布局足以核对时恢复讨论角色。原件不可读或证据有歧义时保留原有文字，不猜选。

`/api/state` 的 Library 在原运行包上另给 `examPlan`、`mediaUrls`、`extraMedia`、`examProjectionVersion`。这些不是原包字段。投影不改写 `originalPack`、`mediaMap`、`contentHash`、旧会话或旧作答；已创建 v2 会话继续使用其冻结计划，新建会话才使用更新后的投影。

兼容媒体 URL 为 `/api/exam-media/:materialId/:hash`，可由完整备份中的原 PDF／ZIP 重建，不依赖尚存的内存缓存。恢复先验证该 URL 引用的材料和 ZIP 内媒体哈希，再替换工作区。恢复清除投影缓存与旧草稿句柄，更换工作区令牌，并暂停恢复的时钟；未结束模型任务标为 interrupted，不自动重发。旧备份没有 `materials` 时仍可恢复，但不能凭空恢复其未包含的原件。

题库 ZIP 导出保留原题包身份，不自动附上运行时才补齐的 Directions。要保留旧题库投影、原件与练习记录，应使用个人完整备份。模块说明音频入口与最终界面验收状态见 [0.3 机考验证](机考验证.md)。

## 0.2 历史合同原文

以下保留更新前合同，供核对旧逐题接口与数据形状。它不定义新 v2 模块会话；历史验证见 [0.2 材料流程验证](材料流程验证.md) 与 [首版验证结果](首版验证结果.md)。

<details>
<summary>展开 0.2 integration contract 原文</summary>

# PracticeBridge 0.2 integration contract

All new source is independently authored. This desktop app starts empty. No vendor client, private question banks, answers or recordings are copied. Original synthetic examples are explicit opt-in only.

## Runtime

Node >=22.16, ESM server, static vanilla browser UI in public/, Electron main in desktop/. Runtime dependencies: @zip.js/zip.js, mammoth, pdfjs-dist; Electron, @electron/packager, Playwright and fast-check are development dependencies. ZIP reading, package preparation/export and backup validation are asynchronous; callers must await them. JSON requests carry X-PracticeBridge: 1. Server only binds to 127.0.0.1, validates Host and Origin, and never enables CORS. Error responses: {error: human-readable string}. All data under configurable dataDir; defaults to project data/. Atomic file-backed state is appropriate for this single-user prototype. API keys live only in server memory and are omitted from exports and state.

## Practice package v1

{schemaVersion:1,id:string,version:string,title:string,description:string,rights:string,groups:[{id:string,section:"reading"|"listening"|"speaking"|"writing",title:string,passage:string,audio:string|null,image:string|null,questions:[{id:string,type:"single_choice"|"fill_blank"|"sentence_order"|"email"|"discussion"|"interview"|"listen_repeat",prompt:string,options:[{id:string,text:string}],answer:string|string[]|null,explanation:string,audio:string|null,image:string|null,timeLimitSeconds:number,prepareSeconds:number,source:string}]}]}

Optional fields normalize to empty text/arrays, null media, timing defaults. Audio/image paths relative to ZIP root, no URLs or traversal. Files upload shape: {name:string,data:base64}. Accepted package ZIP manifest is practicebridge.json; loose JSON with separately selected media also accepted. Text/PDF/DOCX produce source text and a draft. Only explicit references link media; uncertain/missing references become issues. A native package may have missing answers (warning; unscored) but broken media references are blocking.

Sentence ordering additionally accepts optional sentenceFrame:string and answerSlots:integer together. Each underscore run of two or more is one slot; the slot count cannot exceed the options count. Reference answer IDs fill only those slots, allowing unused distractors. Legacy packages omit both fields and continue to use all options. Snapshots and exports retain the fields.

Raw material receipt is independent of this package contract. ZIP content checks and format recognition happen during processing, after durable receipt. The exam-document adapter recognizes source section/module/question identifiers in filenames; this association is reported as filename evidence, not proof of audio comprehension.

## Server endpoints

- GET /api/state -> {libraries:Library[],materials:MaterialSummary[],attempts:Attempt[],sessions:Session[],jobs:Job[],settings:PublicSettings}. Material summaries exclude pasted text and full drafts. Library extends package with libraryId,importedAt,contentHash. Use libraryId for runtime references; package id/version preserved.
- POST /api/materials {files:[File],text?:string,title?:string} -> {material}. Saves originals and metadata without parser or model calls. GET /api/materials/:id -> {material}; GET /api/materials/:id/originals/:index downloads an original as an attachment.
- POST /api/materials/:id/assess {consent:true,useAI?:boolean} -> {material}. AI assessment records processability, missing information, available and selected processors. useAI:false selects the explicit local route with no transmission or consent requirement.
- POST /api/materials/:id/convert {consent:true,useAI?:boolean} -> preview shape plus material and materialId. Requires a compatible prior assessment. GET /api/materials/:id/draft reopens a durable draft after restart. Pending requests do not replay on restart.
- POST /api/import/preview {files:[File],text?:string,title?:string,useAI?:boolean,consent?:boolean} -> {draftId,pack,issues:[{severity:"error"|"warning",message,path}],sources:[{name,text}],media:[{name,mime}],method}. Drafts are separate; this call never adds a library.
- POST /api/import/validate {draftId,pack} -> same preview shape after editing; material-backed edits are persisted. The legacy /import/preview endpoint remains available; the primary UI receives materials first.
- POST /api/import/commit {draftId,pack,acknowledged:boolean} -> {library}. Validate again; all-or-nothing commit; idempotent identical content import.
- GET /api/library/:libraryId/export -> ZIP with package and referenced media only.
- GET /api/backup -> ZIP with libraries, materials, raw originals, drafts, practice records and media; no settings/credentials. POST /api/restore {file:File} -> {restored:true}; verify full backup before replacing state, preserving original snapshot backup. Reject while material/feedback work is active; restored pending states are interrupted. Older backups without materials remain valid.
- GET /api/media/:mediaId -> bytes. Library package media paths replaced in runtime with /api/media/:mediaId URLs; export restores paths. For imports commit map paths to URLs; preserve export manifest original package.
- POST /api/recordings {name,data} -> {recordingId,url}; byte signature/type/size validate. Recordings save before attempts and jobs.
- POST /api/sessions {libraryId,groupId,mode:"practice"|"exam",answers:{},currentIndex:number,startedAt,remainingSeconds:number,assisted:boolean,sessionId?:string} -> {session}. PATCH /api/sessions/:id accepts same fields; finished:true removes from resumable list.
- POST /api/attempts {libraryId,questionId,answer:string|string[],recordingId?:string,transcript?:string,transcriptConfirmed?:boolean,mode:"practice"|"exam",assisted:boolean,durationSeconds:number,submissionId:string} -> {attempt}. questionSnapshot immutable with group passage/media. kind derived from earlier matching attempts, objective status correct/incorrect/unanswered/unscored, evaluations initially []; duplicate submissionId idempotent.
- PATCH /api/attempts/:id {reviewed:boolean} -> {attempt}.
- POST /api/attempts/:id/feedback {consent:true,transcript?:string,transcriptConfirmed?:boolean} -> {job}; queue runs serially. No automatic restart/retry of requests. Feedback failure does not change objective status or fabricate scores. Completed jobs append evaluations to fixed attempt id.
- POST /api/chat {message:string,history:[{role,content}],consent:boolean,context?:{attemptId:string}} -> {reply,provider,model}; no arbitrary tools or filesystem access.
- POST /api/settings {provider:"none"|"openai"|"compatible"|"codex",baseUrl,model,apiKey?:string,timeoutSeconds:number,maxOutputTokens:number,codexPath?:string} -> {settings}. Persist non-secret config only, blank apiKey keeps in-memory value; clearApiKey:true removes. No reading auth.json or global config changes.
- POST /api/settings/test {consent:boolean} -> {ok,detail}; API uses minimal explicit test call. Local status capability checks do not assert successful authentication.

Attempt has id,libraryId,questionId,questionSnapshot,answer,recordingId,recordingUrl,transcript,transcriptConfirmed,mode,assisted,kind,createdAt,durationSeconds,objective:{status,correct,total},evaluations:[],reviewed. Job has id,attemptId,status:queued/running/completed/failed/interrupted,error?,createdAt. Evaluation: {id,createdAt,provider,model,summary,strengths:string[],corrections:[{quote,issue,suggestion,category:"error"|"development"|"optional"|"uncertain"}],revisedAnswer,modelAnswer,nextSteps:string[],limitations:string[]}. No numeric scores. Repeat modelAnswer empty and revisedAnswer exact source; text-only speaking feedback cannot assert pronunciation. Only source-verified quotes accepted.

## Module interfaces

Core package validation and persistence live in src/package.mjs and src/store.mjs. The loopback API is src/server.mjs.

Importer: extractDraft({files,text,title,useAI,consent},models) returns {pack,issues,sources,media,method,files}. Native ZIP handling stays in the package module. Ordinary numbered worksheet and marked-template parsing are deterministic; optional AI only proposes a draft.

Models: createModels({dataDir}) returns {publicSettings(),updateSettings(input),test({consent}),chat(input),feedback({attempt,consent}),structure({text,title,mediaNames,consent})}. Public capabilities/status are explicit. No credentials enter public settings.

Models also provide assessMaterials({sources,files,extractionIssues,availableProcessors,consent}). Output status is processable, partially_processable, needs_information or unsupported, with summary, detectedSections, missingInformation, recommendedProcessor, warnings and canCreateDraft. Metadata-only input cannot become a processable draft. structuredOutput settings accept auto, json_schema or json_object; auto uses json_object for the exact official DeepSeek host. All outputs undergo local validation.

Frontend ownership is bound to each view: late responses cannot overwrite a replaced view. Desktop shutdown first awaits the active practice flush; only confirmed window closure stops the local service.

</details>
