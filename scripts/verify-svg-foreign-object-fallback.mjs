#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-svg-test-"));

try {
  execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    ["src/index.ts", "convert", "--input", "examples/svg-foreign-object.html", "--out", outDir, "--no-server"],
    { stdio: "inherit" },
  );

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8"));
  const nodes = collectNodes(bundle.states[0].root);
  const unsupportedVectors = nodes.filter((node) => node.kind === "VECTOR" && node.svg?.includes("foreignObject"));
  const fallbacks = nodes.filter((node) => node.kind === "RASTER_FALLBACK");

  if (unsupportedVectors.length || fallbacks.length !== 1 || !fallbacks[0].assetId) {
    throw new Error(
      `expected the SVG with foreignObject to become one raster fallback; got ${unsupportedVectors.length} unsupported vector(s) and ${fallbacks.length} fallback(s)`,
    );
  }

  console.log(JSON.stringify({ ok: true, fallback: fallbacks[0].name }, null, 2));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

function collectNodes(root) {
  return [root, ...(root.children || []).flatMap(collectNodes)];
}
