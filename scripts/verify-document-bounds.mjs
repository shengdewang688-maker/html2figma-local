#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-bounds-test-"));

try {
  execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    ["src/index.ts", "convert", "--input", "examples/overflow-document.html", "--out", outDir, "--no-server"],
    { stdio: "inherit" },
  );

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8"));
  const root = bundle.states[0].root;
  if (root.rect.width < 1600 || root.rect.height < 1200) {
    throw new Error(
      `expected root frame to contain the full 1600x1200 document, got ${root.rect.width}x${root.rect.height}`,
    );
  }

  console.log(JSON.stringify({ ok: true, root: root.rect }, null, 2));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
