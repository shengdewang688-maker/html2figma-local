import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startInteractiveCapture } from "../dist/src/capture/capture.js";
import { StateStore } from "../dist/src/capture/stateStore.js";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-visible-sheet-"));
const input = path.resolve("examples/aria-hidden-sheet.html");
const runtime = await startInteractiveCapture(
  {
    input,
    sourceRoot: path.dirname(input),
    viewport: { width: 430, height: 932, deviceScaleFactor: 1 },
    states: [{ id: "home", url: "/" }],
    discovery: { include: ["button"], exclude: [], maxDepth: 0 },
    output: { mode: "new-version-page", pageName: "visible sheet test" },
  },
  { outDir, headed: false, staticPort: 45173 },
);

try {
  const home = await runtime.captureCurrent("home");
  await runtime.page.locator("#filterBtn").click();
  await runtime.waitForSettled();

  assert.equal(await runtime.page.locator("#filterSheet").getAttribute("aria-hidden"), "true");
  assert.equal(await runtime.page.locator("#filterSheet").evaluate((element) => getComputedStyle(element).display), "flex");

  const sheet = await runtime.captureCurrent("filter-sheet");
  assert.notEqual(sheet.pageHash, home.pageHash, "a recorded capture must retain its semantic page hash");
  assert.notEqual(sheet.domHash, home.domHash, "a visible sheet must change the exported scene");
  assert.equal(collectText(home.root).includes("时间筛选"), false);
  assert.equal(collectText(sheet.root).includes("时间筛选"), true);

  const store = new StateStore();
  assert.equal(store.add(home).kind, "added");
  assert.equal(store.add(sheet).kind, "added");
  assert.equal(store.states().length, 2, "the visible sheet cannot be deduplicated with its background page");

  console.log("visible sheet capture verified");
} finally {
  await runtime.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}

function collectText(node) {
  return [node.text, ...(node.children || []).flatMap(collectText)].filter(Boolean);
}
