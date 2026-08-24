import fs from "node:fs/promises";
import path from "node:path";
import { CapturedState, ConversionBundle, ConversionReport, Html2FigmaConfig } from "../types.js";

export async function writeBundle(
  config: Html2FigmaConfig,
  states: CapturedState[],
  report: ConversionReport,
  outDir: string,
): Promise<{ bundle: ConversionBundle; bundlePath: string; reportPath: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const bundle: ConversionBundle = {
    version: 1,
    source: {
      input: config.input,
      figmaUrl: config.figmaUrl,
      capturedAt: new Date().toISOString(),
    },
    output: config.output,
    states,
    report,
  };

  const bundlePath = path.join(outDir, "bundle.json");
  const reportPath = path.join(outDir, "report.json");
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf8");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return { bundle, bundlePath, reportPath };
}
