import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, mergeConfig } from "../config.js";
import { captureProject } from "../capture/capture.js";
import { writeBundle } from "../output/bundle.js";
import { startSessionServer, SessionServer } from "../companion/sessionServer.js";
import { applyTemplate, timestampForName } from "../utils/time.js";
import { slugify } from "../utils/path.js";
import { CapturedState, ConversionReport, Html2FigmaConfig } from "../types.js";
import { filterUploadFiles, isHtmlEntryFile, orderHtmlFiles } from "./uploadFilter.js";
import { LiveCaptureSession, LiveCaptureSessionStatus } from "../recording/liveCaptureSession.js";

type AppServerOptions = {
  outDir: string;
  appPort: number;
  sessionPort: number;
  openBrowser: boolean;
};

type AppServer = {
  url: string;
  sessionUrl: string;
  close: () => Promise<void>;
};

type UploadFile = {
  path: string;
  data: string;
};

type ConvertRequest = {
  files?: UploadFile[];
  entryPath?: string;
  viewport?: {
    width?: number;
    height?: number;
  };
  waitFor?: number;
  maxAutoStates?: number;
  pageName?: string;
  manualOnly?: boolean;
};

type Status = {
  state: "idle" | "running" | "done" | "error";
  message: string;
  sessionUrl: string;
  appUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  report?: ConversionReport;
  recording?: LiveCaptureSessionStatus;
};

type CompletedConversion = { config: Html2FigmaConfig; states: CapturedState[]; report: ConversionReport };

const maxRequestBytes = 200 * 1024 * 1024;

export async function startAppServer(options: AppServerOptions): Promise<AppServer> {
  await fs.mkdir(options.outDir, { recursive: true });
  const session = await startSessionServer(options.outDir, options.sessionPort);
  let status: Status = {
    state: "idle",
    message: "Drop an HTML project to start.",
    sessionUrl: sessionUrlForFigma(session),
  };
  let running: Promise<void> | undefined;
  let latest: CompletedConversion | undefined;
  let recording: LiveCaptureSession | undefined;

  const server = http.createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, appHtml);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        if (recording) status = { ...status, recording: recording.status() };
        sendJson(response, status);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/convert") {
        if (running) {
          response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "A conversion is already running." }));
          return;
        }

        const body = (await readRequestBody(request)) as ConvertRequest;
        status = {
          state: "running",
          message: "Saving uploaded files...",
          sessionUrl: sessionUrlForFigma(session),
          appUrl: `http://127.0.0.1:${addressPort(server)}`,
          startedAt: new Date().toISOString(),
        };

        running = runConversion(body, options.outDir, updateStatus).then((result) => {
          latest = result;
        });
        running
          .catch((error) => {
            status = {
              ...status,
              state: "error",
              message: formatError(error),
              finishedAt: new Date().toISOString(),
            };
          })
          .finally(() => {
            running = undefined;
          });

        sendJson(response, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/recording/start") {
        if (!latest) throw new Error("请先完成自动识别后再开始补录。");
        if (running) throw new Error("自动识别仍在运行，请等待完成后再开始补录。");
        if (recording?.status().state === "recording" || recording?.status().state === "stopping") {
          throw new Error("当前已有补录窗口正在运行，请结束补录后再重新开始。");
        }
        if (recording) {
          await recording.close();
          recording = undefined;
        }
        recording = new LiveCaptureSession(latest.config, options.outDir, latest.states);
        const sessionStatus = await recording.start();
        status = { ...status, recording: sessionStatus, message: sessionStatus.message };
        sendJson(response, { ok: true, recording: sessionStatus });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/recording/snapshot") {
        if (!recording) throw new Error("补录尚未开始。");
        await recording.snapshot();
        status = { ...status, recording: recording.status() };
        sendJson(response, { ok: true, recording: recording.status() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/recording/finish") {
        if (!recording || !latest) throw new Error("补录尚未开始。");
        const states = await recording.finish();
        const report = reportForStates(states, recording.coverage());
        await writeBundle(latest.config, states, report, options.outDir);
        latest = { ...latest, states, report };
        status = { ...status, state: "done", report, recording: recording.status(), message: `已合并 ${states.length} 个唯一状态，可导入 Figma。` };
        recording = undefined;
        sendJson(response, { ok: true, report });
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: formatError(error) }));
    }
  });

  const port = await listen(server, options.appPort);
  const appUrl = `http://127.0.0.1:${port}`;
  status = { ...status, appUrl };

  if (options.openBrowser) {
    openUrl(appUrl);
  }

  return {
    url: appUrl,
    sessionUrl: sessionUrlForFigma(session),
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        session.close(),
        recording?.close(),
      ]);
    },
  };

  function updateStatus(next: Partial<Status>): void {
    status = {
      ...status,
      ...next,
      sessionUrl: sessionUrlForFigma(session),
      appUrl,
    };
  }
}

async function runConversion(request: ConvertRequest, outDir: string, setStatus: (status: Partial<Status>) => void): Promise<CompletedConversion> {
  const files = request.files ?? [];
  if (!files.length) {
    throw new Error("No files received. Drop an HTML file, CSS file, or a folder.");
  }

  const sourceDir = path.join(outDir, "uploaded-source");
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.mkdir(sourceDir, { recursive: true });

  setStatus({ message: `Writing ${files.length} file(s)...` });
  const writtenFiles: string[] = [];
  for (const file of files) {
    const relative = sanitizeRelativePath(file.path);
    const target = path.join(sourceDir, relative);
    if (!isInside(sourceDir, target)) {
      throw new Error(`Unsafe file path: ${file.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(file.data, "base64"));
    writtenFiles.push(relative);
  }

  const includedFiles = filterUploadFiles(writtenFiles);
  const htmlFiles = orderHtmlFiles(request.entryPath, includedFiles);
  const entryRelative = htmlFiles[0];
  const entryPath = path.join(sourceDir, entryRelative);
  const viewport = {
    width: clampInteger(request.viewport?.width, 320, 4096, 1440),
    height: clampInteger(request.viewport?.height, 320, 4096, 900),
    deviceScaleFactor: 1,
  };
  const waitFor = clampInteger(request.waitFor, 0, 10000, 120);
  const maxAutoStates = clampInteger(request.maxAutoStates, 0, 5000, 1000);

  const baseConfig = await loadConfig();
  const config = mergeConfig(baseConfig, { input: entryPath });
  config.sourceRoot = sourceDir;
  config.viewport = viewport;
  const stateFiles = request.manualOnly ? [entryRelative] : htmlFiles;
  config.states = stateFiles.map((htmlFile, index) => ({
    id: stateIdForHtml(htmlFile, index),
    url: `/${encodeUrlPath(htmlFile)}`,
    waitFor,
  }));
  config.discovery = {
    ...config.discovery,
    maxDepth: request.manualOnly || maxAutoStates <= 0 ? 0 : config.discovery.maxDepth,
    maxAutoStates: request.manualOnly ? 0 : maxAutoStates,
  };
  config.output = {
    mode: "new-version-page",
    pageName: applyTemplate(request.pageName?.trim() || "HTML Import {{timestamp}}", {
      timestamp: timestampForName(),
    }),
  };

  setStatus({ message: `Capturing ${htmlFiles.length} HTML file(s)...` });
  const { states, report } = await captureProject(config, {
    outDir,
    staticPort: 4173,
    onProgress: (message) => setStatus({ message }),
  });

  setStatus({ message: "Writing Figma bundle..." });
  await writeBundle(config, states, report, outDir);
  setStatus({
    state: "done",
    message: `Ready for Figma: captured ${report.stateCount} state(s), ${report.assetCount} asset(s).`,
    finishedAt: new Date().toISOString(),
    report,
  });
  return { config, states, report };
}

function reportForStates(states: CapturedState[], coverage: NonNullable<ConversionReport["coverage"]>): ConversionReport {
  const rows = states.map((state) => ({
    id: state.id, route: state.route, domHash: state.domHash,
    nodeCount: countNodes(state.root), assetCount: state.assets.length,
    rasterFallbackCount: 0, screenshotPath: state.screenshotPath, warnings: state.warnings,
    origin: state.origin, displayName: state.displayName, pathCount: state.paths?.length ?? 0,
  }));
  return {
    stateCount: states.length, assetCount: states.reduce((sum, state) => sum + state.assets.length, 0),
    rasterFallbackCount: 0, warnings: rows.flatMap((row) => row.warnings), coverage, states: rows,
  };
}

function countNodes(node: CapturedState["root"]): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function stateIdForHtml(filePath: string, index: number): string {
  if (index === 0) {
    return "home";
  }
  return slugify(filePath.replace(/\.(?:html?|xhtml|xht|shtml?|shtm)$/i, ""));
}

function encodeUrlPath(filePath: string): string {
  return filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sanitizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\w:\//, "").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part && part !== "." && part !== "..");
  if (!parts.length || parts.some((part) => part.includes("\0"))) {
    throw new Error(`Invalid file path: ${value}`);
  }
  return parts.join("/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function sessionUrlForFigma(session: SessionServer): string {
  return `${session.url.replace("127.0.0.1", "localhost")}/session/latest`;
}

function sendHtml(response: http.ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxRequestBytes) {
        reject(new Error("Upload is too large. Keep the HTML project under 200 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    request.on("error", reject);
  });
}

function listen(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
        } else {
          reject(error);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(addressPort(server) || port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryPort(preferredPort);
  });
}

function addressPort(server: http.Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function openUrl(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const appHtml = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HTML2Figma Drop Tool</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --ink: #172033;
        --muted: #667085;
        --line: #d9e0ea;
        --accent: #0f766e;
        --accent-dark: #115e59;
        --danger: #b42318;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          linear-gradient(180deg, rgba(15, 118, 110, 0.08), transparent 260px),
          var(--bg);
      }
      main {
        width: min(1040px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
        display: grid;
        gap: 18px;
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
      }
      p {
        margin: 8px 0 0;
        color: var(--muted);
        line-height: 1.55;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
        gap: 16px;
      }
      .panel,
      .dropzone {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      .dropzone {
        min-height: 360px;
        padding: 28px;
        display: grid;
        place-items: center;
        text-align: center;
        border-style: dashed;
        transition:
          border-color 160ms ease,
          background 160ms ease,
          transform 160ms ease;
      }
      .dropzone.dragging {
        border-color: var(--accent);
        background: #eefaf7;
        transform: translateY(-1px);
      }
      .drop-inner {
        max-width: 520px;
      }
      .icon {
        width: 56px;
        height: 56px;
        margin: 0 auto 14px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: #e7f6f3;
        color: var(--accent-dark);
      }
      .drop-title {
        font-size: 20px;
        font-weight: 750;
      }
      .actions {
        margin-top: 22px;
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 10px;
      }
      button,
      .file-button {
        height: 38px;
        border: 1px solid var(--accent);
        border-radius: 6px;
        padding: 0 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: var(--accent);
        color: white;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
      }
      button.secondary,
      .file-button.secondary {
        background: white;
        color: var(--accent-dark);
      }
      button:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      input[type="file"] {
        display: none;
      }
      .panel {
        padding: 18px;
        display: grid;
        gap: 14px;
        align-content: start;
      }
      .field {
        display: grid;
        gap: 6px;
      }
      label,
      .label {
        font-size: 12px;
        font-weight: 750;
        color: #344054;
      }
      input,
      select {
        width: 100%;
        height: 36px;
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 0 10px;
        font: inherit;
        color: var(--ink);
        background: white;
      }
      .two {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .status {
        min-height: 86px;
        padding: 12px;
        border-radius: 6px;
        background: #f2f4f7;
        color: #344054;
        font-size: 13px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .status.error {
        background: #fff1f0;
        color: var(--danger);
      }
      .status.done {
        background: #ecfdf3;
        color: #067647;
      }
      .files {
        max-height: 132px;
        overflow: auto;
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      .files li {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .session {
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }
      @media (max-width: 760px) {
        header,
        .grid {
          display: grid;
          grid-template-columns: 1fr;
        }
      }

      /* Minimal workbench layout */
      :root { --bg: #f3f6fb; --ink: #17233d; --muted: #6a7890; --line: #dce4f0; --accent: #2857d6; --accent-dark: #1945bb; --accent-soft: #eef3ff; }
      body { background: radial-gradient(circle at 50% -10%, #dfe9ff 0, transparent 38rem), var(--bg); }
      main { width: min(1120px, calc(100vw - 32px)); gap: 20px; }
      header { align-items: center; }
      h1 { font-size: clamp(26px, 4vw, 34px); }
      .eyebrow { margin: 0 0 8px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .grid { grid-template-columns: minmax(0, 1.22fr) minmax(310px, .78fr); gap: 20px; }
      .panel, .dropzone { border-radius: 16px; }
      .dropzone { min-height: 440px; padding: 36px; border: 2px dashed #cbd8ed; }
      .dropzone.dragging { border-color: var(--accent); background: #f5f8ff; }
      .drop-inner { max-width: 460px; }
      .icon { width: 64px; height: 64px; margin-bottom: 18px; background: var(--accent-soft); color: var(--accent); }
      .drop-title { font-size: 22px; font-weight: 800; }
      .actions { margin-top: 24px; }
      button, .file-button { height: 42px; border-radius: 9px; background: var(--accent); }
      button.secondary, .file-button.secondary { color: var(--accent-dark); border-color: #c8d4ec; }
      .panel { padding: 22px; gap: 16px; }
      input, select { height: 40px; border-radius: 8px; }
      .mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .mode { min-height: 108px; height: auto; padding: 14px; align-items: flex-start; flex-direction: column; text-align: left; }
      .mode small { color: inherit; opacity: .74; font-weight: 500; line-height: 1.35; }
      .advanced-settings { border-top: 1px solid var(--line); padding-top: 14px; }
      .advanced-settings summary, .file-details summary { cursor: pointer; color: #475467; font-size: 13px; font-weight: 750; }
      .advanced-settings summary { list-style: none; }
      .advanced-settings summary::-webkit-details-marker { display: none; }
      .advanced-settings summary::after { content: "+"; float: right; color: var(--accent); font-size: 17px; line-height: 12px; }
      .advanced-settings[open] summary::after { content: "−"; }
      .advanced-content { display: grid; gap: 12px; padding-top: 14px; }
      #workflowControls { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; border-top: 1px solid var(--line); padding: 18px 0 2px; }
      #workflowControls button { min-width: 132px; }
      #workflowControls[hidden] { display: none; }
      .status-bar { padding: 14px 16px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 14px; align-items: center; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
      .status-label { color: var(--muted); font-size: 12px; font-weight: 750; }
      .status { min-height: 0; padding: 0; border-radius: 0; background: transparent; }
      .status.error, .status.done { background: transparent; }
      .file-details { border-top: 1px solid var(--line); padding-top: 14px; }
      .session { grid-column: 2; }
      @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } .panel { grid-template-columns: 1fr; } .panel > .field:first-child, .mode-grid { grid-column: 1; grid-row: auto; } .dropzone { min-height: 330px; } }
      @media (max-width: 480px) { main { width: calc(100vw - 24px); padding: 22px 0; } .mode-grid, .two, .status-bar { grid-template-columns: 1fr; } .session { grid-column: auto; } }

      /* Apple-inspired: restrained colour, generous space, quiet surfaces. */
      :root { --bg: #f5f5f7; --panel: #fff; --ink: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #0071e3; --accent-dark: #0071e3; --accent-soft: #e8f3ff; }
      body { background: #f5f5f7; letter-spacing: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Helvetica Neue", Arial, sans-serif; font-size: 15px; }
      main { width: min(960px, calc(100vw - 40px)); padding: 44px 0 40px; gap: 18px; }
      header { justify-content: center; text-align: center; }
      .eyebrow { color: #6e6e73; font-size: 13px; font-weight: 500; letter-spacing: .01em; text-transform: none; }
      h1 { font-size: clamp(36px, 4.4vw, 44px); font-weight: 600; letter-spacing: -.035em; }
      header p { display: none; }
      .grid { grid-template-columns: 1fr; gap: 18px; align-items: stretch; }
      .panel, .dropzone { border: 0; border-radius: 28px; box-shadow: none; }
      .dropzone { min-height: 270px; background: #fff; border: 1px solid rgba(0,0,0,.04); }
      .dropzone.dragging { border-color: #0071e3; background: #f0f8ff; transform: none; }
      .icon { width: 72px; height: 72px; border-radius: 22px; background: #f5f5f7; color: #0071e3; }
      .drop-title { font-size: 25px; font-weight: 600; letter-spacing: -.025em; }
      .drop-inner p { font-size: 15px; }
      button, .file-button { height: 44px; border: 0; border-radius: 980px; background: #0071e3; font-weight: 600; font-size: 15px; padding: 0 18px; }
      button:hover:not(:disabled), .file-button:hover { background: #0077ed; }
      button.secondary, .file-button.secondary { border: 1px solid #0071e3; color: #0071e3; background: transparent; }
      .panel { background: #fff; min-height: 0; padding: 22px 30px; grid-template-columns: 1fr; grid-template-rows: auto auto auto auto; align-items: stretch; }
      .panel > .field:first-child { grid-column: 1; width: min(700px, 100%); margin: 0 auto; padding: 10px 14px; border-radius: 14px; background: #f5f5f7; }
      .mode-grid { grid-column: 1; grid-row: auto; width: min(760px, 100%); margin: 0 auto; align-self: stretch; }
      .advanced-settings, #workflowControls, .file-details { grid-column: 1 / -1; }
      label, .label { color: #1d1d1f; font-size: 13px; font-weight: 600; }
      input, select { background: #f5f5f7; border: 0; border-radius: 12px; height: 44px; }
      .mode-grid { gap: 12px; }
      .mode { min-height: 104px; border-radius: 18px; padding: 16px 20px; background: #fff; border: 1px solid #0071e3; color: #0071e3; justify-content: center; }
      .mode.secondary { background: #0071e3; border: 1px solid #0071e3; color: #fff; }
      .mode:disabled { opacity: 1; cursor: not-allowed; }
      .mode span { font-size: 17px; font-weight: 600; letter-spacing: -.015em; }
      .mode small { font-size: 14px; font-weight: 400; }
      .advanced-settings, .file-details { border-color: #e8e8ed; }
      #workflowControls { border-color: #e8e8ed; }
      .status-bar { background: #fff; border: 0; border-radius: 18px; padding: 14px 20px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
      .status-label { font-size: 13px; font-weight: 600; }
      .status, .session { font-size: 14px; line-height: 1.45; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <div class="eyebrow">✨ 本地原型转换</div>
          <h1>HTML原型 → Figma画板</h1>
          <p aria-hidden="true"></p>
        </div>
      </header>

      <section class="grid">
        <div id="dropzone" class="dropzone">
          <div class="drop-inner">
            <div class="icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M12 15V3m0 0 4 4m-4-4-4 4M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div id="dropTitle" class="drop-title">上传 HTML 原型 ✦</div>
            <p id="dropHint" hidden></p>
            <div class="actions">
              <label class="file-button">
                📁 选择文件夹
                <input id="folderInput" type="file" webkitdirectory directory multiple />
              </label>
              <label class="file-button secondary">
                📄 选择文件
                <input id="fileInput" type="file" multiple />
              </label>
            </div>
          </div>
        </div>

        <aside class="panel" aria-label="转换工作台">
          <div class="field">
            <label for="entry">📍 入口页面</label>
            <select id="entry"></select>
          </div>
          <div class="mode-grid">
            <button id="convert" class="mode" disabled><span>🪄 自动识别</span><small>适合简单流程</small></button>
            <button id="manualCapture" class="secondary mode" disabled><span>✋ 手动抓取</span><small>适合复杂流程</small></button>
          </div>
          <details class="advanced-settings">
            <summary>⚙️ 设置</summary>
            <div class="advanced-content">
              <div class="two">
                <div class="field"><label for="width">宽</label><input id="width" type="number" value="1440" min="320" max="4096" /></div>
                <div class="field"><label for="height">高</label><input id="height" type="number" value="900" min="320" max="4096" /></div>
              </div>
              <div class="two">
                <div class="field"><label for="waitFor">等待 ms</label><input id="waitFor" type="number" value="120" min="0" max="10000" /></div>
                <div class="field"><label for="maxAutoStates">自动状态上限</label><input id="maxAutoStates" type="number" value="1000" min="0" max="5000" /></div>
              </div>
              <div class="field"><label for="pageName">Figma 页面名</label><input id="pageName" value="HTML Import {{timestamp}}" /></div>
            </div>
          </details>
          <div id="workflowControls" hidden>
            <button id="startRecording" class="secondary" disabled>开始抓取</button>
            <button id="snapshot" class="secondary" disabled>抓取当前页</button>
            <button id="finishRecording" class="secondary" disabled>完成抓取</button>
          </div>
          <details class="file-details">
            <summary>📂 文件清单</summary>
            <ul id="files" class="files"></ul>
          </details>
        </aside>
      </section>
      <section class="status-bar" aria-live="polite">
        <div class="status-label">📊 状态</div>
        <div id="status" class="status">等待选择 HTML 项目。</div>
        <div id="session" class="session">插件地址：等待服务启动</div>
      </section>
    </main>

    <script>
      const dropzone = document.getElementById("dropzone");
      const folderInput = document.getElementById("folderInput");
      const fileInput = document.getElementById("fileInput");
      const fileList = document.getElementById("files");
      const entrySelect = document.getElementById("entry");
      const convertButton = document.getElementById("convert");
      const manualCaptureButton = document.getElementById("manualCapture");
      const statusBox = document.getElementById("status");
      const sessionBox = document.getElementById("session");
      const startRecordingButton = document.getElementById("startRecording");
      const snapshotButton = document.getElementById("snapshot");
      const finishRecordingButton = document.getElementById("finishRecording");
      const workflowControls = document.getElementById("workflowControls");
      const dropTitle = document.getElementById("dropTitle");
      const dropHint = document.getElementById("dropHint");

      let selectedFiles = [];
      let polling = 0;
      let startManualAfterConvert = false;

      function isIgnoredProjectPath(filePath) {
        const parts = filePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
        return parts.some((part, index) => {
          const staticDeployment =
            (part === ".output" && parts[index + 1] === "public") ||
            (part === ".vercel" && parts[index + 1] === "output" && parts[index + 2] === "static");
          return !staticDeployment && (part.startsWith(".") || ["node_modules", "coverage"].includes(part));
        });
      }

      function isHtmlEntryFile(filePath) {
        return /\.(?:html?|xhtml|xht|shtml?|shtm)$/i.test(filePath);
      }

      function preferredEntry(options) {
        return (
          options.find((option) => /(^|\/)(?:(?:dist|build|out|public|wwwroot)|\.output\/public|\.vercel\/output\/static)\/index\.(?:html?|xhtml|xht|shtml?|shtm)$/i.test(option.value)) ||
          options.find((option) => /(^|\/)index\.(?:html?|xhtml|xht|shtml?|shtm)$/i.test(option.value)) ||
          options[0]
        );
      }

      function setStatus(message, state = "idle") {
        statusBox.textContent = message;
        statusBox.className = "status" + (state === "done" ? " done" : state === "error" ? " error" : "");
      }

      function setWorkflowVisibility(status) {
        const recording = status.recording;
        const recordingActive = recording && recording.state === "recording";
        workflowControls.hidden = !(recordingActive || status.state === "done");
        startRecordingButton.disabled = status.state !== "done" || recordingActive;
        snapshotButton.disabled = !recordingActive;
        finishRecordingButton.disabled = !recordingActive;
      }

      async function filesFromInput(inputFiles) {
        return Array.from(inputFiles).map((file) => ({
          file,
          path: file.webkitRelativePath || file.name,
        }));
      }

      async function filesFromDrop(event) {
        const items = Array.from(event.dataTransfer.items || []);
        const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
        if (!entries.length) {
          return filesFromInput(event.dataTransfer.files);
        }
        const collected = [];
        for (const entry of entries) {
          await walkEntry(entry, "", collected);
        }
        return collected;
      }

      function walkEntry(entry, prefix, collected) {
        return new Promise((resolve, reject) => {
          if (entry.isFile) {
            entry.file(
              (file) => {
                collected.push({ file, path: prefix + file.name });
                resolve();
              },
              reject,
            );
            return;
          }
          if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () => {
              reader.readEntries(async (entries) => {
                try {
                  if (!entries.length) {
                    resolve();
                    return;
                  }
                  for (const child of entries) {
                    await walkEntry(child, prefix + entry.name + "/", collected);
                  }
                  readBatch();
                } catch (error) {
                  reject(error);
                }
              }, reject);
            };
            readBatch();
            return;
          }
          resolve();
        });
      }

      async function setFiles(files) {
        const ignoredCount = files.filter((item) => isIgnoredProjectPath(item.path)).length;
        selectedFiles = files.filter((item) => !isIgnoredProjectPath(item.path));
        fileList.innerHTML = "";
        for (const item of selectedFiles.slice(0, 80)) {
          const li = document.createElement("li");
          li.textContent = item.path;
          fileList.appendChild(li);
        }
        if (selectedFiles.length > 80) {
          const li = document.createElement("li");
          li.textContent = "..." + (selectedFiles.length - 80) + " more";
          fileList.appendChild(li);
        }

        const htmlFiles = selectedFiles.filter((item) => isHtmlEntryFile(item.path));
        entrySelect.innerHTML = "";
        for (const item of htmlFiles) {
          const option = document.createElement("option");
          option.value = item.path;
          option.textContent = item.path;
          entrySelect.appendChild(option);
        }
        const entryOption = preferredEntry(Array.from(entrySelect.options));
        if (entryOption) {
          entrySelect.value = entryOption.value;
        }
        convertButton.disabled = !htmlFiles.length;
        manualCaptureButton.disabled = !htmlFiles.length;
        workflowControls.hidden = true;
        dropTitle.textContent = htmlFiles.length ? "原型已就绪 ✓" : "上传 HTML 原型 ✦";
        dropHint.textContent = htmlFiles.length
          ? "已发现 " + htmlFiles.length + " 个可运行页面（含 HTML/XHTML）。选择一种抓取模式开始。"
          : "推荐拖整个项目或构建产物目录；支持 HTML/XHTML、CSS、模块、图片、字体、媒体和 WASM 资源。";
        setStatus(
          htmlFiles.length
            ? "已准备 " + selectedFiles.length + " 个文件，发现 " + htmlFiles.length + " 个可运行页面" + (ignoredCount ? "；已忽略 " + ignoredCount + " 个依赖/缓存文件" : "") + "。点击生成后，到 Figma 插件里 Import latest session。"
            : "没有找到可运行的 HTML/XHTML 入口。若这是 Vue、React、Svelte 或 Astro 源码，请先构建后拖入 dist、build、out 等静态导出目录。",
          htmlFiles.length ? "idle" : "error",
        );
      }

      async function fileToPayload(item) {
        const buffer = await item.file.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return {
          path: item.path,
          data: btoa(binary),
        };
      }

      async function convert(manualOnly = false) {
        if (!selectedFiles.length) return;
        convertButton.disabled = true;
        setStatus("正在读取文件...");
        try {
          const files = [];
          for (const item of selectedFiles) {
            files.push(await fileToPayload(item));
          }
          setStatus("正在上传并转换...");
          const response = await fetch("/api/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              files,
              entryPath: entrySelect.value,
              viewport: {
                width: Number(document.getElementById("width").value),
                height: Number(document.getElementById("height").value),
              },
              waitFor: Number(document.getElementById("waitFor").value),
              maxAutoStates: Number(document.getElementById("maxAutoStates").value),
              pageName: document.getElementById("pageName").value,
              manualOnly,
            }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          pollStatus();
        } catch (error) {
          setStatus(error && error.message ? error.message : String(error), "error");
          convertButton.disabled = false;
        }
      }

      async function pollStatus() {
        window.clearTimeout(polling);
        try {
          const response = await fetch("/api/status", { cache: "no-store" });
          const status = await response.json();
          sessionBox.textContent = "插件地址：" + status.sessionUrl;
          setStatus(status.message, status.state);
          setWorkflowVisibility(status);
          if (status.state === "running") {
            polling = window.setTimeout(pollStatus, 1000);
          } else if (status.state === "done" && startManualAfterConvert) {
            startManualAfterConvert = false;
            recordingRequest("/api/recording/start");
          } else {
            convertButton.disabled = !entrySelect.value;
          }
        } catch (error) {
          setStatus(error && error.message ? error.message : String(error), "error");
          convertButton.disabled = !entrySelect.value;
        }
      }

      async function recordingRequest(path) {
        try {
          const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          pollStatus();
        } catch (error) {
          setStatus(error && error.message ? error.message : String(error), "error");
        }
      }

      ["dragenter", "dragover"].forEach((name) => {
        dropzone.addEventListener(name, (event) => {
          event.preventDefault();
          dropzone.classList.add("dragging");
        });
      });
      ["dragleave", "drop"].forEach((name) => {
        dropzone.addEventListener(name, (event) => {
          event.preventDefault();
          dropzone.classList.remove("dragging");
        });
      });
      dropzone.addEventListener("drop", async (event) => {
        setFiles(await filesFromDrop(event));
      });
      folderInput.addEventListener("change", async () => setFiles(await filesFromInput(folderInput.files)));
      fileInput.addEventListener("change", async () => setFiles(await filesFromInput(fileInput.files)));
      convertButton.addEventListener("click", convert);
      manualCaptureButton.addEventListener("click", () => { startManualAfterConvert = true; convert(true); });
      startRecordingButton.addEventListener("click", () => recordingRequest("/api/recording/start"));
      snapshotButton.addEventListener("click", () => recordingRequest("/api/recording/snapshot"));
      finishRecordingButton.addEventListener("click", () => recordingRequest("/api/recording/finish"));
      pollStatus();
    </script>
  </body>
</html>`;
