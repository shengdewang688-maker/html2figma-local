import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/appServer.ts", import.meta.url), "utf8");

for (const expected of ["开始自动识别", "直接手动抓取", "高级设置", "工作台"]) {
  assert.match(source, new RegExp(expected), `工具页缺少“${expected}”`);
}

for (const id of [
  "dropzone", "folderInput", "fileInput", "entry", "width", "height", "waitFor", "maxAutoStates", "pageName",
  "convert", "manualCapture", "startRecording", "snapshot", "finishRecording", "status", "files", "session",
]) {
  assert.match(source, new RegExp(`id="${id}"`), `工具页缺少 #${id}`);
}

assert.match(source, /id="workflowControls"[^>]*hidden/, "补录控制必须默认隐藏");
assert.match(source, /<details[^>]*class="advanced-settings"/, "高级设置必须默认折叠");

console.log("app workbench structure verified");
