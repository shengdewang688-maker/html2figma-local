# 极简工作台界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HTML 转 Figma 工具页改为极简工作台，同时保留上传、自动识别、直接手动抓取、补录和导入会话功能。

**Architecture:** 仅替换 appServer.ts 中的内嵌 HTML、CSS 和前端状态渲染；现有 API 和 element id 保持不变，避免改变转换逻辑。

**Tech Stack:** HTML、CSS、原生浏览器 JavaScript、Node TypeScript。

## Global Constraints

- 不能修改现有 API 路由、上传 payload 或按钮功能。
- 自动识别与直接手动抓取必须始终可见且语义清楚。
- 高级设置默认收起。
- 未上传时不展示可执行的补录控制。
- 状态条必须显示 Figma session 地址。

---

### Task 1: 重构工具页布局与视觉层级

**Files:**
- Modify: `src/app/appServer.ts`
- Test: `scripts/verify-app-workbench.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写失败验证**

创建 verify-app-workbench.mjs，读取 app 主页并断言：

```js
assert.match(html, /开始自动识别/);
assert.match(html, /直接手动抓取/);
assert.match(html, /高级设置/);
assert.match(html, /工作台/);
```

- [ ] **Step 2: 运行红灯**

Run: `npm run build && node scripts/verify-app-workbench.mjs`

Expected: FAIL，当前页面没有工作台和高级设置结构。

- [ ] **Step 3: 实现布局**

替换 appHtml 的样式与 body：

- 外层背景为浅灰蓝，main 最大宽 1120px。
- header 显示“HTML → Figma 工作台”。
- 左侧上传卡片显示空态或已选择文件摘要。
- 右侧操作卡片将 convert/manualCapture 排成两列按钮，并在按钮下放一句模式说明。
- 用 details/summary 包裹 entry、viewport、waitFor、maxAutoStates、pageName。
- 用 id 为 workflowControls 的容器包裹 startRecording/snapshot/finishRecording，初始 hidden；仅 recording 或自动完成后显示。
- status、session、files 改为底部状态条和可展开文件清单。

保持 dropzone、folderInput、fileInput、entry、width、height、waitFor、maxAutoStates、pageName、convert、manualCapture、startRecording、snapshot、finishRecording、status、files、session 的 id 不变。

- [ ] **Step 4: 增加状态渲染**

在 setFiles/pollStatus 中更新上传摘要、workflowControls 的 hidden 属性、状态条 class。自动完成时显示开始补录；recording 时显示抓取/结束；其余状态隐藏无效控制。

- [ ] **Step 5: 运行绿灯**

Run: `npm run build && node scripts/verify-app-workbench.mjs && npm run check`

Expected: PASS。

### Task 2: 功能回归与文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新说明**

README 的拖拽工具章节说明：模式选择在工作台右侧；高级设置默认折叠；底部状态条提供 session 地址。

- [ ] **Step 2: 运行全量验证**

Run:

```bash
npm run check
npm run verify:upload-filter
npm run verify:live-bridge
npm run verify:interaction-states
npm run verify:pointer-card-states
npm run verify:plugin -- .html2figma-fixture/bundle.json
git diff --check
```

Expected: 全部退出码为 0。
