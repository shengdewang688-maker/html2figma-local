#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { loadConfig, mergeConfig } from "./config.js";
import { captureProject } from "./capture/capture.js";
import { writeBundle } from "./output/bundle.js";
import { startSessionServer } from "./companion/sessionServer.js";
import { startAppServer } from "./app/appServer.js";
import { CliOptions } from "./types.js";
import { resolveFromCwd } from "./utils/path.js";
import { applyTemplate, timestampForName } from "./utils/time.js";

const program = new Command();

program
  .name("html2figma")
  .description("Capture local HTML into editable Figma-ready Scene JSON.")
  .version("0.1.0");

program
  .command("convert")
  .description("Capture a local HTML file or URL and expose it to the Figma companion plugin.")
  .option("-i, --input <path-or-url>", "HTML file, local URL, or remote URL to capture")
  .option("--figma-url <url>", "Existing Figma design URL for bookkeeping")
  .option("-c, --config <path>", "Config file path")
  .option("-o, --out <dir>", "Output directory", ".html2figma")
  .option("-p, --port <port>", "Companion session server port", parseIntValue, 4777)
  .option("--no-server", "Do not keep the companion session server running")
  .action(async (options: CliOptions) => {
    await runConvert(options);
  });

program
  .command("serve")
  .description("Serve an existing bundle directory to the Figma companion plugin.")
  .option("-o, --out <dir>", "Output directory containing bundle.json", ".html2figma")
  .option("-p, --port <port>", "Companion session server port", parseIntValue, 4777)
  .action(async (options: Pick<CliOptions, "out" | "port">) => {
    const outDir = resolveFromCwd(options.out);
    const server = await startSessionServer(outDir, options.port);
    printServeInstructions(server.url);
    await waitForever();
  });

program
  .command("app")
  .description("Start a local drag-and-drop HTML/CSS tool for the Figma companion plugin.")
  .option("-o, --out <dir>", "Output directory for uploaded files and bundle.json", ".html2figma")
  .option("-p, --port <port>", "Companion session server port used by the Figma plugin", parseIntValue, 4777)
  .option("--app-port <port>", "Drag-and-drop app port", parseIntValue, 4888)
  .option("--no-browser", "Do not open the browser automatically")
  .action(async (options: Pick<CliOptions, "out" | "port" | "appPort" | "noBrowser">) => {
    const outDir = resolveFromCwd(options.out);
    const app = await startAppServer({
      outDir,
      appPort: options.appPort ?? 4888,
      sessionPort: options.port,
      openBrowser: options.noBrowser !== true,
    });
    printAppInstructions(app.url, app.sessionUrl);
    await waitForever();
    await app.close();
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});

async function runConvert(options: CliOptions): Promise<void> {
  const outDir = resolveFromCwd(options.out);
  const config = mergeConfig(await loadConfig(options.config), {
    input: options.input,
    figmaUrl: options.figmaUrl,
  });

  config.output = {
    ...config.output,
    pageName: applyTemplate(config.output.pageName, { timestamp: timestampForName() }),
  };

  console.log(`Capturing ${config.input}`);
  const { states, report } = await captureProject(config, {
    outDir,
    staticPort: config.serverPort,
  });
  const { bundlePath, reportPath } = await writeBundle(config, states, report, outDir);

  console.log(`Captured ${report.stateCount} state(s), ${report.assetCount} asset(s).`);
  console.log(`Bundle: ${path.relative(process.cwd(), bundlePath)}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (report.warnings.length) {
    console.log(`Warnings: ${report.warnings.length}. See report.json for details.`);
  }

  if (options.noServer || options.server === false) {
    return;
  }

  const server = await startSessionServer(outDir, options.port);
  printServeInstructions(server.url);
  await waitForever();
}

function printServeInstructions(url: string): void {
  console.log("");
  console.log(`Companion session server: ${url}/session/latest`);
  console.log("Open Figma, run the local companion plugin from plugin/manifest.json, then click Import latest session.");
  console.log("Press Ctrl+C here after the Figma import finishes.");
}

function printAppInstructions(appUrl: string, sessionUrl: string): void {
  console.log("");
  console.log(`Drag-and-drop app: ${appUrl}`);
  console.log(`Figma plugin session URL: ${sessionUrl}`);
  console.log("Drop your HTML/CSS project in the browser, generate the bundle, then run the Figma companion plugin.");
  console.log("Press Ctrl+C here when you are done.");
}

function parseIntValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function waitForever(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
