import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "html2figma-mermaid-test-"));

try {
  execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    ["src/index.ts", "convert", "--input", "examples/mermaid-flowchart.html", "--out", outDir, "--no-server"],
    { stdio: "inherit" },
  );

  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, "bundle.json"), "utf8"));
  const state = bundle.states[0];
  const nodes = collectNodes(state.root);
  const flowchart = nodes.find((node) => node.kind === "RASTER_FALLBACK" && node.tag === "svg");

  assert.equal(bundle.states.length, 1);
  assert.ok(flowchart, "expected the locally rendered Mermaid SVG to be exported as a high-fidelity fallback");
  const rasterAsset = state.assets.find((asset) => asset.id === flowchart.assetId && asset.dataUrl);
  assert.ok(rasterAsset, "expected a raster asset for the Mermaid flowchart");
  const png = Buffer.from(rasterAsset.dataUrl.split(",")[1], "base64");
  assert.ok(
    png.readUInt32BE(16) >= Math.ceil(flowchart.rect.width * 3) &&
      png.readUInt32BE(20) >= Math.ceil(flowchart.rect.height * 3),
    "expected the Mermaid fallback to be captured at 3× pixel density",
  );
  assert.doesNotMatch(collectText(state.root).join(" "), /flowchart TD/, "expected Mermaid source to be rendered before extraction");

  console.log("mermaid fallback verified");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

function collectNodes(root) {
  return [root, ...(root.children || []).flatMap(collectNodes)];
}

function collectText(node) {
  return [node.text, ...(node.children || []).flatMap(collectText)].filter(Boolean);
}
