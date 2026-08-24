#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-pointer-card-test-"));

try {
  execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    ["src/index.ts", "convert", "--input", "examples/pointer-card-states.html", "--out", outDir, "--no-server"],
    { stdio: "inherit" },
  );

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8"));
  const screens = bundle.states.map((state) => collectText(state.root).join(" "));
  const detailScreens = screens.filter((screen) => screen.includes("认领审核详情"));

  if (bundle.states.length !== 2) {
    throw new Error(`expected a list and one representative pointer-card detail state; got ${bundle.states.length}`);
  }
  if (detailScreens.length !== 1 || !detailScreens[0].includes("详情：客户 A")) {
    throw new Error(`expected exactly one detail state reached through the first pointer card; got ${detailScreens.length}`);
  }

  console.log(JSON.stringify({ ok: true, stateCount: bundle.states.length }, null, 2));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

function collectText(node) {
  return [node.text, ...(node.children || []).flatMap(collectText)].filter(Boolean);
}
