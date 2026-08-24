# 直接手动抓取模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留自动识别和补录的前提下，增加“直接手动抓取”模式，并自动保存首页。

**Architecture:** 应用服务器把上传、配置构建和 bundle 写入复用为一个准备阶段；自动模式在准备后调用现有 `captureProject`，手动模式只通过 `LiveCaptureSession` 打开入口页并保存首屏。前端按模式调用不同 API，但两种模式均使用相同的状态仓库与 Figma session。

**Tech Stack:** TypeScript、Node HTTP server、Playwright、现有 HTML2Figma bundle。

## Global Constraints

- 不修改用户上传的 HTML、CSS、JS。
- 直接手动模式不运行自动候选探索，`coverage.auto` 必须为 `0`。
- 手动模式开始时自动保存优先 HTML 的首页一次。
- 两个模式均导入 `http://localhost:4777/session/latest`。
- 自动识别 + 补录的现有行为不能变化。

---

### Task 1: 手动模式服务端准备与首页保存

**Files:**
- Modify: `src/app/appServer.ts`
- Modify: `src/recording/liveCaptureSession.ts`
- Create: `scripts/verify-direct-manual-mode.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `POST /api/manual/start`，响应 `{ ok: true, recording: LiveCaptureSessionStatus }`。
- Consumes: 现有 `LiveCaptureSession.start(headed?: boolean)` 与 `writeBundle(config, states, report, outDir)`。

- [ ] **Step 1: 写失败验证**

创建 `scripts/verify-direct-manual-mode.mjs`，对本地 app 上传 `examples/interaction-states.html`，调用 `POST /api/manual/start`，随后调用 `POST /api/recording/finish`。断言：

```js
assert.equal(report.coverage.auto, 0);
assert.equal(report.stateCount, 1);
assert.equal(report.states[0].origin, "explicit");
```

- [ ] **Step 2: 运行验证并确认失败**

Run: `npm run build && node scripts/verify-direct-manual-mode.mjs`

Expected: FAIL，HTTP 404 或 `/api/manual/start` 不存在。

- [ ] **Step 3: 实现手动准备路径**

在 `appServer.ts` 提取 `prepareUpload(request, outDir)`，它写入文件、过滤依赖目录、选择 entry、构建 `Html2FigmaConfig`；在自动 API 继续调用 `captureProject`。新增 `POST /api/manual/start`：

```ts
const prepared = await prepareUpload(body, options.outDir);
const session = new LiveCaptureSession(prepared.config, options.outDir, []);
await session.start(true, { captureInitial: true });
const states = session.states();
const report = reportForStates(states, session.coverage());
await writeBundle(prepared.config, states, report, options.outDir);
```

修改 `LiveCaptureSession.start` 接受 `options?: { captureInitial?: boolean }`；该值为 true 时，页面稳定后调用现有 captureCurrent，写入 `origin: "explicit"`、`displayName: "首页"` 和 navigate path。

- [ ] **Step 4: 运行验证并确认通过**

Run: `npm run build && node scripts/verify-direct-manual-mode.mjs`

Expected: PASS；输出 `direct manual mode verified`。

- [ ] **Step 5: 注册脚本**

在 package.json 新增：

```json
"verify:direct-manual-mode": "npm run build && node scripts/verify-direct-manual-mode.mjs"
```

### Task 2: 双入口界面和明确模式状态

**Files:**
- Modify: `src/app/appServer.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `POST /api/convert`、`POST /api/manual/start`、`GET /api/status`。
- Produces: “开始自动识别”“直接手动抓取”两个按钮及模式状态文案。

- [ ] **Step 1: 写前端字符串验证**

在 `scripts/verify-direct-manual-mode.mjs` 读取 app 首页 HTML，断言同时包含：

```js
assert.match(html, /开始自动识别/);
assert.match(html, /直接手动抓取/);
assert.match(html, /已保存首页，等待抓取页面/);
```

- [ ] **Step 2: 运行验证并确认失败**

Run: `npm run verify:direct-manual-mode`

Expected: FAIL，页面尚无“直接手动抓取”。

- [ ] **Step 3: 实现前端按钮和请求**

在 appHtml 将原“生成所有 HTML 给 Figma 插件使用”改为“开始自动识别”，增加 `#manualCapture`：

```html
<button id="convert" disabled>开始自动识别</button>
<button id="manualCapture" class="secondary" disabled>直接手动抓取</button>
```

`manualCapture` 复用文件序列化和 entry/viewport/pageName 字段，向 `/api/manual/start` 提交相同 JSON。文件列表无 HTML 时禁用两个入口；运行中禁用两个入口。手动 API 成功后显示“已保存首页，等待抓取页面；请在补录窗口操作并点击抓取当前页面”。

README 新增两条流程，明确自动模式与直接手动模式的差异和共同的结束/导入步骤。

- [ ] **Step 4: 运行验证并确认通过**

Run: `npm run verify:direct-manual-mode && npm run check`

Expected: 两个命令均 PASS。

### Task 3: 完整回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 运行所有回归**

Run:

```bash
npm run check
npm run verify:state-store
npm run verify:upload-filter
npm run verify:live-bridge
npm run verify:direct-manual-mode
npm run verify:interaction-states
npm run verify:pointer-card-states
npm run verify:plugin -- .html2figma-fixture/bundle.json
git diff --check
```

Expected: 全部退出码为 0。

- [ ] **Step 2: 真实手动模式验收**

上传任意原型，选择“直接手动抓取”。确认补录窗口打开且首页已保存；抓取一个详情页面后结束补录。Figma 导入中应只有首页与手动抓取的详情，不出现自动状态。

- [ ] **Step 3: 记录结果**

在 README 的使用说明中保留两种模式的选择建议：想快速覆盖用自动识别，想完全控制画面用直接手动抓取。
