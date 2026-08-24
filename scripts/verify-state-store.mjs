import assert from "node:assert/strict";
import { StateStore } from "../dist/src/capture/stateStore.js";

const viewport = { width: 390, height: 844 };

function state({ id, domHash, pageHash, origin, displayName, path }) {
  return {
    id,
    route: "/claim",
    title: "认领审核",
    viewport,
    domHash,
    pageHash,
    origin,
    displayName,
    paths: [path],
    capturedAt: "2026-07-29T00:00:00.000Z",
    screenshotPath: `${id}.png`,
    root: {
      id: "root",
      kind: "FRAME",
      name: "root",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      style: {},
      children: [],
      editable: true,
      warnings: [],
    },
    assets: [],
    warnings: [],
  };
}

const autoHome = state({
  id: "auto-home",
  domHash: "dom-home",
  pageHash: "page-home",
  origin: "auto",
  displayName: "自动首页",
  path: {
    id: "path-auto-home",
    origin: "auto",
    operations: [{ kind: "click", label: "打开认领", selector: ".claim" }],
    capturedAt: "2026-07-29T00:00:00.000Z",
  },
});
const recordedHome = state({
  id: "recorded-home",
  domHash: "dom-home-other",
  pageHash: "page-home",
  origin: "recorded",
  displayName: "人工命名首页",
  path: {
    id: "path-recorded-home",
    origin: "recorded",
    operations: [{ kind: "snapshot", label: "补录首页" }],
    capturedAt: "2026-07-29T00:01:00.000Z",
  },
});
const recordedDetail = state({
  id: "recorded-detail",
  domHash: "dom-detail",
  pageHash: "page-detail",
  origin: "recorded",
  displayName: "认领详情",
  path: {
    id: "path-recorded-detail",
    origin: "recorded",
    operations: [{ kind: "click", label: "查看详情", selector: ".claim-card" }],
    capturedAt: "2026-07-29T00:02:00.000Z",
  },
});

const store = new StateStore();
assert.equal(store.add(autoHome).kind, "added");
assert.equal(store.add(recordedHome).kind, "duplicate");
assert.equal(store.states().length, 1);
assert.equal(store.pathsFor("auto-home").length, 2);
assert.equal(store.states()[0].displayName, "人工命名首页");
assert.equal(store.add(recordedDetail).kind, "added");
assert.equal(store.states().length, 2);

store.recordOutcome({ action: "click .blocked", status: "skipped", reason: "unsafe action" });
store.recordOutcome({ action: "click .claim-card", status: "captured", stateId: "recorded-detail" });
const coverage = store.reportCoverage();
assert.deepEqual(coverage, {
  captured: 2,
  auto: 1,
  recorded: 1,
  duplicates: 1,
  outcomes: [
    { action: "click .blocked", status: "skipped", reason: "unsafe action" },
    { action: "click .claim-card", status: "captured", stateId: "recorded-detail" },
  ],
});

assert.equal(store.rename("recorded-detail", "人工详情"), true);
assert.equal(store.states()[1].displayName, "人工详情");
assert.equal(store.remove("recorded-detail"), true);
assert.equal(store.remove("missing"), false);
assert.equal(store.states().length, 1);

console.log("state store verified");
