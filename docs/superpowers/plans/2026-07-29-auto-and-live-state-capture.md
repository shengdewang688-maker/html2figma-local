# 自动识别与实时补录状态捕获实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 HTML→Figma 工具升级为状态覆盖工具：先自动探索可达界面；如有遗漏，产品人员直接操作可见原型窗口，工具自动保存每个有意义的唯一画面，并合并导入 Figma。

**Architecture:** 保留当前 Playwright DOM→Scene→Figma 链路，将“稳定页面采集”抽为可复用 runtime。自动探索与人工补录都写入同一个状态仓库，统一完成去重、路径追溯和覆盖报告。补录会话以 headed Playwright 打开原型，并在页面加载前注入事件桥接脚本；应用服务器负责会话 API、状态面板和 bundle 重写，插件读取附加元数据并按来源排版。

**Tech Stack:** TypeScript、Node HTTP server、Playwright、Figma Plugin API、Node assert 验证脚本。

## 全局约束

- 不修改上传的 HTML、CSS、JS；桥接脚本只注入 Playwright context。
- 状态身份优先语义页面签名，回退 DOM 签名；相同状态只建一个 Figma Frame，允许累积多条到达路径。
- 自动模式跳过删除、退出、支付、下载、上传、外链和不可逆提交；每个被跳过候选都写入原因。
- 仅用户点击“开始补录”才打开可见 Chromium 窗口。
- bundle 仍为 version 1；新增字段全是可选，兼容旧插件和旧 bundle。
- 每项测试必须注册到 package.json，最终和既有验证一起运行。

### Task 1：定义状态来源、操作路径和覆盖报告

Files:
- Modify: src/types.ts
- Create: src/capture/stateStore.ts
- Create: scripts/verify-state-store.mjs
- Modify: package.json

Step 1: 写失败验证。创建 verify-state-store.mjs，导入 dist/capture/stateStore.js，构造自动首页、相同的补录首页、不同的补录详情，验证：

~~~
const store = new StateStore();
assert.equal(store.add(autoHome).kind, "added");
assert.equal(store.add(recordedHome).kind, "duplicate");
assert.equal(store.states().length, 1);
assert.equal(store.pathsFor("auto-home").length, 2);
assert.equal(store.add(recordedDetail).kind, "added");
assert.equal(store.states().length, 2);
~~~

还要验证人工重命名优先于自动默认名，覆盖报告分别统计 auto、recorded、duplicate、skipped。

Step 2: 执行 npm run build && node scripts/verify-state-store.mjs，确认当前因 stateStore.js 缺失而失败。

Step 3: 在 types.ts 新增 StateOrigin（explicit、auto、recorded）、StateOperation（navigate/click/input/select/key/submit/route/snapshot，含 label/selector/value/url/at）、StatePath（id/origin/operations/capturedAt）、CandidateOutcome（action/status/reason/stateId）。

为 CapturedState 增加可选 origin、paths、pageHash、displayName。为 ConversionReport 增加可选 coverage（captured、auto、recorded、duplicates、outcomes）；每个 report state 同步添加 origin、displayName、pathCount。

Step 4: 实现 StateStore：

- add(state)：按 pageHash 或 domHash 去重；命中时追加 path，若新状态为 recorded 且有 displayName，则覆盖默认显示名。
- recordOutcome(outcome)：保存所有探索/补录结果。
- states()/pathsFor(id)：返回稳定顺序的副本。
- rename(id, name)/remove(id)：支持补录面板；不存在返回 false。
- reportCoverage()：统计唯一状态，duplicate path 不能计为新状态。

Step 5: 注册 verify:state-store 为 npm run build && node scripts/verify-state-store.mjs，运行后期望输出 state store verified。

### Task 2：抽取可复用采集 runtime，并让自动探索写入路径/结果

Files:
- Modify: src/capture/capture.ts
- Modify: src/capture/domExtractor.ts
- Modify: src/output/bundle.ts
- Modify: scripts/verify-interaction-states.mjs
- Modify: scripts/verify-pointer-card-states.mjs

Step 1: 从 captureProject 提取浏览器、静态服务、截图目录和现有 extractCurrentDom/captureExtractedPage，导出以下 runtime：

~~~
type CaptureRuntime = {
  page: Page; config: Html2FigmaConfig;
  captureCurrentState(input): Promise<CapturedState>;
  waitForSettled(): Promise<void>;
  close(): Promise<void>;
};
startCaptureRuntime({ config, outDir, headed?, staticPort?, onProgress? })
~~~

captureProject 必须通过 runtime 执行 explicit + discovery，并在 finally close，保证补录不复制 DOM/资产采集逻辑。

Step 2: 新增 waitForVisualSettled(page)：连续两个 RAF 后，以 MutationObserver 等 250ms 无 DOM/属性变更，最多 2 秒。runtime.waitForSettled 顺序执行资源等待、视觉稳定和配置 waitFor；超时只记录 outcome，不阻断采集。

Step 3: 给状态标注来源和路径：

- 初始 config states 为 explicit，路径包含 navigate/fill/click/press。
- discoverStates 候选点击生成 click operation；新增状态是 auto。
- 新状态记 captured；相同签名记 duplicate；页面无变化记 unchanged；安全过滤记 skipped；定位/点击异常记 failed；稳定超时记 timeout。
- 现有同组卡片折叠策略不变，但报告内有一次 skipped，reason 为 equivalent interaction group。

Step 4: buildReport 接收 StateStore（或 states + coverage），写入 origin/pathCount/coverage；writeBundle 原样序列化新增字段，继续输出 version 1。

Step 5: 扩展 verify-interaction-states，断言 auto 来源、操作路径和 coverage.auto；扩展 verify-pointer-card-states，断言详情为 auto 且无重复 pageHash。

Run: npm run check && npm run verify:interaction-states && npm run verify:pointer-card-states && npm run verify:state-store

Expected: 全部通过。

### Task 3：实现可见补录窗口和加载前事件桥接

Files:
- Create: src/recording/liveCaptureBridge.ts
- Create: src/recording/liveCaptureSession.ts
- Modify: src/companion/staticServer.ts
- Modify: src/app/appServer.ts

Step 1: liveCaptureBridge 导出可传给 page.addInitScript 的函数：

- 捕获阶段监听 click、change、input、submit、keydown、popstate、hashchange。
- 目标描述优先 data-testid/id/name/aria-label/role/文本，退回 tag nth-of-type 链。
- 输入只传控件类型、长度或选项文本，绝不传 password 值。
- input 用 450ms debounce；其他事件排队，等待 mutation 安静 300ms + 双 RAF 后调用 window.__html2figmaRecordEvent(payload)。
- 滚动不单独上报；提供 window.__html2figmaSaveSnapshot()，发送 snapshot。

Step 2: 实现 LiveCaptureSession，含 start、saveSnapshot、renameState、removeState、finish、status、close。

start 使用 Task 2 runtime 的 headed true。顺序固定为 page.exposeBinding(__html2figmaRecordEvent) → page.addInitScript(liveCaptureBridge) → page.goto(entry)，避免丢首屏事件。

binding 采用串行队列：waitForSettled → captureCurrentState（origin 为 recorded，带 path/displayName）→ StateStore.add。ID 格式为 recorded-序号-短哈希。相同 kind + selector + url 在 800ms 内折叠；状态仓库返回 duplicate 时只加路径，不加 Frame。单次异常写入 coverage outcome，但会话继续。finish 等队列清空、关闭 runtime、合并自动/补录状态并构建最终 report。

Step 3: startStaticServer 新增可选 HTML response transform，只处理 HTML/HTM，图片/CSS/JS 仍然 stream。主方案使用 addInitScript；页面 CSP 阻止时，fallback 在 HTML 内插入最小 bridge 并增加 recording bridge fallback injected warning。

Step 4: appServer 增加 recording 状态和 API：

~~~
POST /api/recording/start    { entryPath, viewport, waitFor, pageName }
POST /api/recording/snapshot {}
POST /api/recording/finish   {}
POST /api/recording/rename   { id, displayName }
POST /api/recording/remove   { id }
GET  /api/status
~~~

start 只在自动转换完成、无运行任务时允许，复用 uploaded-source 和最后 config。finish 用 writeBundle 覆盖同一个 bundle.json/report.json，Figma 始终读取 session/latest。app server close 同时 close session。

### Task 4：过滤依赖目录，并制作补录控制面板

Files:
- Create: src/app/uploadFilter.ts
- Modify: src/app/appServer.ts
- Create: scripts/verify-upload-filter.mjs
- Modify: package.json

Step 1: 写 verify-upload-filter，断言 filterUploadFiles 会排除 node_modules/playwright-core/lib/vite/htmlReport/index.html、.git/index.html，保留 claim-audit-mobile.html 和 assets/icon.svg；同时断言 orderHtmlFiles 只返回用户项目 HTML，并优先下拉框选择的 entry。

Step 2: 实现 filterUploadFiles、orderHtmlFiles、isIgnoredProjectPath。忽略 .git、.svn、.hg、node_modules、.html2figma、dist、build、coverage、vendor 和隐藏文件；不按扩展名删 CSS/JS/字体/图片。浏览器 setFiles 和服务端 runConversion 都使用此名单，状态显示忽略数。此项修复拖入父目录误选 node_modules HTML。

Step 3: 更新 appHtml：

- 主按钮改为“开始自动识别”。
- 自动完成后显示：已捕获 X 个唯一状态（自动 A / 补录 B / 已去重 C）。
- 显示开始补录、保存当前状态、结束补录，及支持重命名/删除的补录列表。
- 显示“补录窗口已打开，请直接操作原型”和 previewUrl 备用链接。
- 结束提示为“到 Figma 插件 Import latest session”。

前端轮询 status，不假设可见浏览器一定前台显示。

Step 4: 注册 verify:upload-filter 为 npm run build && node scripts/verify-upload-filter.mjs，运行并通过。

### Task 5：在 Figma 中按来源命名、分组并追溯补录路径

Files:
- Modify: plugin/code.js
- Modify: plugin/ui.html
- Modify: scripts/verify-plugin.mjs
- Modify: README.md

Step 1: Frame 保留 stateId/route/domHash/capturedAt，并新增 origin、pageHash、paths 的 sharedPluginData。名称按 viewport 取 mobile（宽度不大于 768）或 desktop，并带 自动/补录/初始 来源，如 mobile / 补录 / displayName。

Step 2: 单一 Figma page 仍先排 explicit/auto；recorded 在下一组前留 240px，并各自放“自动识别”“补录状态”标题 Text。绝不因额外路径建 Frame。

Step 3: 插件 UI 读取 bundle.report.coverage；有值时提示自动 A、补录 B、去重 C，缺失时回退 state count。空 bundle、空 states、fetch 失败都禁用/报错。

Step 4: 扩展 verify-plugin 的 fake Figma 节点以记录 sharedPluginData。导入一条 recorded、430 宽、含 paths 的状态，断言名称 mobile / 补录 / 开头，origin/pageHash/paths 均存在，自动/补录状态各只创建一次。既有 fixture 仍可导入。

Run: npm run verify:plugin -- .html2figma-fixture/bundle.json

### Task 6：端到端补录测试、说明与完整回归

Files:
- Create: examples/live-capture.html
- Create: scripts/verify-live-capture.mjs
- Modify: README.md
- Modify: package.json

Step 1: 新例子包含初始列表、非语义 cursor:pointer 卡片、需输入正确值或切换后才显示的详情/抽屉；详情不能是自动探索直接可达的普通 button。

Step 2: verify-live-capture 先跑自动 capture；启动 LiveCaptureSession（测试允许 headed false）模拟 fill/change/card click；等待 queue 后 finish；读取 bundle，断言存在 recorded 详情、coverage.recorded 大于等于 1、重复 click 不增加 Frame、详情 paths 至少两条；GET session/latest 并确认与 bundle.json 一致。

Step 3: README 写明流程：正确 entry/视口 → 自动识别 → 查覆盖 → 开始补录，直接操作可见原型 → 结束补录 → 插件 Import latest session。说明不改源码；登录、验证码、API 返回数据须在用户准备好的环境中手动触发。

Step 4: 注册 verify:live-capture，并执行：

~~~
npm run check
npm run fixture
npm run verify:state-store
npm run verify:upload-filter
npm run verify:interaction-states
npm run verify:pointer-card-states
npm run verify:live-capture
npm run verify:svg-fallback
npm run verify:document-bounds
npm run verify:plugin -- .html2figma-fixture/bundle.json
git diff --check
~~~

Expected: 全部退出码为 0。

### Task 7：真实原型和 Figma 目测验收

Files:
- Generated only: .html2figma/（验证输出，不提交）

Step 1: 上传且只上传以下三个用户原型文件：

~~~
/Users/acool.ffei/Desktop/gjzq_internship/产品原型/新开户认领626/claim-audit-mobile.html
/Users/acool.ffei/Desktop/gjzq_internship/产品原型/新开户认领626/claim-audit-mobile.css
/Users/acool.ffei/Desktop/gjzq_internship/产品原型/新开户认领626/claim-audit-mobile.js
~~~

视口 430 × 932，确认自动结果含列表、筛选/弹窗和一个代表详情。

Step 2: 开始补录，在可见原型窗口选择不同渠道或进入一个实际详情/确认分支，然后结束补录。确认 coverage 增加 recorded 或 duplicate path，而视觉相同的第二渠道详情不会重复建 state。

Step 3: 在插件填 http://localhost:4777/session/latest 并导入。确认 430 宽移动 Frame、详情的“认领审核/佐证材料”等主要文本和布局可编辑、自动和补录两组均出现、Frame 带路径 shared plugin data。

Step 4: 最终说明列出真实原型的自动状态数、补录新增/去重数、Figma 页面名，以及登录/API 限制而需用户手动补录的分支。

