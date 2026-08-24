#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-interaction-test-"));

try {
  execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    ["src/index.ts", "convert", "--input", "examples/interaction-states.html", "--out", outDir, "--no-server"],
    { stdio: "inherit" },
  );

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8"));
  const screens = bundle.states.map((state) => collectText(state.root).join(" "));
  const selectedListScreens = screens.filter(
    (screen) =>
      screen.includes("已选择：") &&
      !screen.includes("确认注销已选择的渠道。") &&
      !screen.includes("为已选择的渠道指定新归属。"),
  );

  if (bundle.states.length !== 4) {
    throw new Error(`expected default, one selected representative, cancel, and reassign states; got ${bundle.states.length}`);
  }
  if (selectedListScreens.length !== 1 || !selectedListScreens[0].includes("已选择：A")) {
    throw new Error(`expected exactly one representative selected state for channel A; got ${selectedListScreens.length}`);
  }
  if (!screens.some((screen) => screen.includes("确认注销已选择的渠道。"))) {
    throw new Error("expected the selected flow to reach the cancellation dialog");
  }
  if (!screens.some((screen) => screen.includes("为已选择的渠道指定新归属。"))) {
    throw new Error("expected the selected flow to reach the reassignment dialog");
  }

  console.log(JSON.stringify({ ok: true, stateCount: bundle.states.length }, null, 2));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

function collectText(node) {
  return [node.text, ...(node.children || []).flatMap(collectText)].filter(Boolean);
}
