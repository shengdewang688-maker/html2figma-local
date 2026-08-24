import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, Page } from "playwright";
import { isUrl } from "../config.js";
import {
  Asset,
  CapturedState,
  ConversionReport,
  DiscoveryConfig,
  Html2FigmaConfig,
  SceneNode,
  StateAction,
} from "../types.js";
import { dataUrlFromBytes, resolveAsset } from "./assets.js";
import { browserExtractor, buildDomSignature, buildPageSignature, ExtractedDom } from "./domExtractor.js";
import { startStaticServer } from "../companion/staticServer.js";
import { shortHash } from "../utils/hash.js";
import { resolveFromCwd, slugify } from "../utils/path.js";

const require = createRequire(import.meta.url);
let bundledMermaidScript: Promise<string> | undefined;
const highFidelityRasterScale = 3;

type CaptureOptions = {
  outDir: string;
  staticPort?: number;
  onProgress?: (message: string) => void;
};

type CaptureContext = {
  config: Html2FigmaConfig;
  outDir: string;
  baseUrl: string;
  stateById: Map<string, StateAction>;
  screenshotDir: string;
  onProgress?: (message: string) => void;
};

export type InteractiveCapture = {
  page: Page;
  captureCurrent: (stateId: string) => Promise<CapturedState>;
  waitForSettled: () => Promise<void>;
  close: () => Promise<void>;
};

/** Opens a normal browser window for user-driven recording while reusing the Scene extractor. */
export async function startInteractiveCapture(
  config: Html2FigmaConfig,
  options: CaptureOptions & { headed?: boolean },
): Promise<InteractiveCapture> {
  await fs.mkdir(options.outDir, { recursive: true });
  const screenshotDir = path.join(options.outDir, "screenshots");
  await fs.mkdir(screenshotDir, { recursive: true });
  const staticServer = isUrl(config.input)
    ? undefined
    : await startStaticServer(
        resolveFromCwd(config.input),
        options.staticPort,
        config.sourceRoot ? resolveFromCwd(config.sourceRoot) : undefined,
        injectCaptureControl,
  );
  const browser = await chromium.launch({ headless: options.headed === false });
  const page = await browser.newPage(capturePageOptions(config));
  await installCaptureResourceFallbacks(page);
  const context: CaptureContext = {
    config,
    outDir: options.outDir,
    baseUrl: staticServer?.url ?? config.input,
    stateById: new Map(config.states.map((state) => [state.id, state])),
    screenshotDir,
    onProgress: options.onProgress,
  };
  await navigateForCapture(
    page,
    resolveStateUrl(context.baseUrl, config.states[0]?.url),
    config.navigationTimeout ?? 8_000,
  );
  await waitForReady(page, config, config.states[0] ?? { id: "recording" });
  return {
    page,
    waitForSettled: () => waitForLiveSettled(page, config),
    captureCurrent: async (stateId) => {
      await page.evaluate(() => document.querySelector<HTMLElement>("[data-html2figma-capture-control]")?.style.setProperty("display", "none"));
      try {
        return await captureExtractedPage(page, context, stateId, await extractCurrentDom(page, context), false);
      } finally {
        await page.evaluate(() => document.querySelector<HTMLElement>("[data-html2figma-capture-control]")?.style.removeProperty("display"));
      }
    },
    close: async () => {
      await browser.close();
      await staticServer?.close();
    },
  };
}

function injectCaptureControl(html: string): string {
  if (html.includes("data-html2figma-capture-control")) return html;
  const control = `<button type="button" data-html2figma-capture-control aria-label="抓取当前页面到 Figma" style="position:fixed;right:24px;bottom:24px;z-index:2147483647;border:0;border-radius:999px;padding:12px 18px;background:#0f766e;color:#fff;font-size:14px;font-weight:700;box-shadow:0 8px 24px rgba(15,118,110,.35);cursor:pointer">抓取当前页面</button><script>document.querySelector('[data-html2figma-capture-control]').addEventListener('click',function(){var b=this;b.disabled=true;b.textContent='正在抓取…';Promise.resolve(window.__html2figmaSaveSnapshot&&window.__html2figmaSaveSnapshot()).then(function(){b.textContent='已抓取 ✓';setTimeout(function(){b.disabled=false;b.textContent='抓取当前页面'},1400)}).catch(function(){b.textContent='抓取失败';b.disabled=false;setTimeout(function(){b.textContent='抓取当前页面'},1800)})})</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${control}</body>`) : `${html}${control}`;
}

type Candidate = {
  label: string;
  selector: string;
  targetKey?: string;
  selectionGroup?: string;
  pointerGroup?: string;
  global?: boolean;
  modal?: boolean;
};

type DiscoveryPath = {
  seed: StateAction;
  clicks: Candidate[];
  depth: number;
  domHash?: string;
  pageHash?: string;
};

type PageInventory = {
  count: number;
  labels: string[];
};

export async function captureProject(
  config: Html2FigmaConfig,
  options: CaptureOptions,
): Promise<{ states: CapturedState[]; report: ConversionReport }> {
  await fs.mkdir(options.outDir, { recursive: true });
  const screenshotDir = path.join(options.outDir, "screenshots");
  await fs.rm(screenshotDir, { recursive: true, force: true });
  await fs.mkdir(screenshotDir, { recursive: true });

  const staticServer = isUrl(config.input)
    ? undefined
    : await startStaticServer(
        resolveFromCwd(config.input),
        options.staticPort,
        config.sourceRoot ? resolveFromCwd(config.sourceRoot) : undefined,
      );
  const baseUrl = staticServer?.url ?? config.input;
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage(capturePageOptions(config));
    await installCaptureResourceFallbacks(page);
    const context: CaptureContext = {
      config,
      outDir: options.outDir,
      baseUrl,
      stateById: new Map(config.states.map((state) => [state.id, state])),
      screenshotDir,
      onProgress: options.onProgress,
    };

    const captured: CapturedState[] = [];
    const seenHashes = new Set<string>();
    const seenPageHashes = new Set<string>();

    for (const state of config.states) {
      await prepareState(page, context, state);
      const extracted = await extractCurrentDom(page, context);
      if (state.capture !== "always" && seenPageHashes.has(extracted.pageHash)) {
        context.onProgress?.(`Skipped duplicate explicit state "${state.id}".`);
        continue;
      }
      const result = await captureExtractedPage(page, context, state.id, extracted);
      result.origin = "explicit";
      result.pageHash = extracted.pageHash;
      result.paths = [{
        id: `path-${state.id}`,
        origin: "explicit",
        operations: [{ kind: "navigate", label: state.id, url: result.route, at: result.capturedAt }],
        capturedAt: result.capturedAt,
      }];
      captured.push(result);
      seenHashes.add(result.domHash);
      seenPageHashes.add(extracted.pageHash);
      context.onProgress?.(`Captured ${captured.length} explicit state(s)...`);
    }

    const autoStates = await discoverStates(page, context, seenHashes, seenPageHashes);
    captured.push(...autoStates);

    return {
      states: captured,
      report: buildReport(captured),
    };
  } finally {
    await browser.close();
    await staticServer?.close();
  }
}

async function prepareState(page: Page, context: CaptureContext, state: StateAction): Promise<void> {
  if (state.from) {
    const parent = context.stateById.get(state.from);
    if (!parent) {
      throw new Error(`State "${state.id}" references missing parent "${state.from}"`);
    }
    await prepareState(page, context, parent);
  } else {
    await navigateToState(page, context, state);
  }

  if (state.fill) {
    for (const [selector, value] of Object.entries(state.fill)) {
      await page.locator(selector).first().fill(value);
    }
  }
  if (state.hover) {
    await page.locator(state.hover).first().hover();
  }
  if (state.click) {
    await page.locator(state.click).first().click();
  }
  if (state.press) {
    await page.keyboard.press(state.press);
  }
  await waitForReady(page, context.config, state);
}

async function navigateToState(page: Page, context: CaptureContext, state: StateAction): Promise<void> {
  const target = resolveStateUrl(context.baseUrl, state.url);
  await navigateForCapture(page, target, context.config.navigationTimeout ?? 8_000);
  await waitForReady(page, context.config, state);
}

/**
 * Capture-only network resilience. The user's HTML is never rewritten and its
 * normal browser use keeps its original URLs. During Playwright capture, known
 * Mermaid CDN scripts are served from the bundled compatible runtime so a
 * blocked CDN cannot hold the parser before DOMContentLoaded.
 */
async function installCaptureResourceFallbacks(page: Page): Promise<void> {
  const mermaidScript = await loadBundledMermaidScript();
  await page.route((url) => isSupportedMermaidCdnUrl(url.toString()), async (route) => {
    if (route.request().resourceType() !== "script") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: mermaidScript,
    });
  });
}

function loadBundledMermaidScript(): Promise<string> {
  bundledMermaidScript ??= fs.readFile(require.resolve("mermaid/dist/mermaid.min.js"), "utf8");
  return bundledMermaidScript;
}

function isSupportedMermaidCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!new Set(["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"]).has(url.hostname.toLowerCase())) {
      return false;
    }
    return /mermaid(?:\.min)?\.js$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function navigateForCapture(page: Page, target: string, timeout: number): Promise<void> {
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout });
  } catch (error) {
    if (!isNavigationTimeout(error) || !(await hasUsableDocument(page))) {
      throw error;
    }
  }
}

function isNavigationTimeout(error: unknown): boolean {
  return error instanceof Error && /Timeout .* exceeded/i.test(error.message);
}

async function hasUsableDocument(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = document.body;
      return Boolean(body && (body.children.length > 0 || body.textContent?.trim()));
    })
    .catch(() => false);
}

async function extractCurrentDom(
  page: Page,
  context: CaptureContext,
): Promise<ExtractedDom & { domHash: string; pageHash: string }> {
  const extracted = await page.evaluate(browserExtractor, context.config.viewport);
  const semanticSignature = await page
    .evaluate((source) => Function(source)(), pageStateSignatureScript)
    .catch((error) => {
      if (process.env.HTML2FIGMA_DEBUG_DISCOVERY === "1") {
        console.log(`[discovery] semantic page signature failed: ${formatError(error)}`);
      }
      return undefined;
    });
  return {
    ...extracted,
    domHash: buildDomSignature(extracted.root),
    pageHash: buildSemanticPageHash(semanticSignature, extracted.root),
  };
}

async function captureExtractedPage(
  page: Page,
  context: CaptureContext,
  stateId: string,
  extracted: ExtractedDom & { domHash: string; pageHash: string },
  fullPage = true,
): Promise<CapturedState> {
  const rasterAssets = await captureRasterAssets(page, extracted.rasterIds);
  const resolvedAssets = await Promise.all(
    [...extracted.assets, ...rasterAssets].map((asset) => resolveAsset(asset, page.url())),
  );
  const root = attachAssetWarnings(extracted.root, resolvedAssets);
  const screenshotPath = path.join(context.screenshotDir, `${slugify(stateId)}.png`);
  // Baseline screenshots are only for diagnostics. Keep their existing CSS-pixel
  // dimensions; high-density pixels are reserved for image fallbacks sent to Figma.
  await page.screenshot({ path: screenshotPath, fullPage, scale: "css" });

  return {
    id: stateId,
    route: page.url(),
    title: await page.title(),
    viewport: context.config.viewport,
    domHash: extracted.domHash,
    pageHash: extracted.pageHash,
    capturedAt: new Date().toISOString(),
    screenshotPath,
    root,
    assets: resolvedAssets,
    warnings: [...extracted.warnings, ...collectAssetWarnings(resolvedAssets)],
  };
}

async function discoverStates(
  page: Page,
  context: CaptureContext,
  seenHashes: Set<string>,
  seenPageHashes: Set<string>,
): Promise<CapturedState[]> {
  let maxAutoStates = context.config.discovery.maxAutoStates ?? 12;
  const maxDepth = context.config.discovery.maxDepth ?? 0;
  const maxModalActionsPerPath = context.config.discovery.maxModalActionsPerPath ?? 2;
  const maxPageActionsPerPath = context.config.discovery.maxPageActionsPerPath ?? 2;
  if (maxDepth <= 0 || maxAutoStates <= 0) {
    return [];
  }

  const inventory = await inspectPageInventory(page, context);
  if (inventory.count > 0) {
    const inventoryExtraStates = context.config.discovery.inventoryExtraStates ?? 3;
    const inventoryLimit = Math.max(0, inventory.count + inventoryExtraStates);
    maxAutoStates = Math.min(maxAutoStates, inventoryLimit);
    context.onProgress?.(
      `Static scan found about ${inventory.count} page/dialog target(s); exploration cap ${maxAutoStates}.`,
    );
  }

  const seedPaths: DiscoveryPath[] = [];
  for (const seed of context.config.states) {
    try {
      await prepareState(page, context, seed);
      const extracted = await extractCurrentDom(page, context);
      seedPaths.push({
        seed,
        clicks: [],
        depth: 0,
        domHash: extracted.domHash,
        pageHash: extracted.pageHash,
      });
    } catch {
      seedPaths.push({
        seed,
        clicks: [],
        depth: 0,
      });
    }
  }
  const visitedPaths = new Set(seedPaths.map((path) => discoveryPathSignature(path)));
  const expandedPageHashes = new Set<string>();
  const globalCandidateOutcomes = new Map<string, string>();
  const debugDiscovery = process.env.HTML2FIGMA_DEBUG_DISCOVERY === "1";
  const results: CapturedState[] = [];

  const explore = async (current: DiscoveryPath): Promise<DiscoveryPath[]> => {
    const discoveredPaths: DiscoveryPath[] = [];
    if (current.depth >= maxDepth || results.length >= maxAutoStates) return discoveredPaths;
    let candidates: Candidate[];
    let currentPageHash = current.pageHash;
    try {
      await prepareDiscoveryPath(page, context, current);
      if (!currentPageHash) {
        currentPageHash = (await extractCurrentDom(page, context)).pageHash;
      }
      if (expandedPageHashes.has(currentPageHash)) {
        return discoveredPaths;
      }
      expandedPageHashes.add(currentPageHash);
      candidates = await getDiscoveryCandidates(page, context.config.discovery);
    } catch {
      // Discovery is intentionally best effort; explicit states are authoritative.
      return discoveredPaths;
    }

    const pathAlreadyUsedGlobalNavigation = current.clicks.some((click) => click.global);
    const modalActionsInPath = current.clicks.filter((click) => click.modal).length;
    const pageActionsInPath = current.clicks.filter((click) => !click.global && !click.modal).length;
    const representativeGroupsInPath = new Set(
      current.clicks.map((click) => click.selectionGroup || click.pointerGroup).filter(Boolean),
    );
    const exploredRepresentativeGroups = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      if (results.length >= maxAutoStates) {
        return discoveredPaths;
      }
      if (candidate.global && pathAlreadyUsedGlobalNavigation) {
        continue;
      }
      if (candidate.modal && modalActionsInPath >= maxModalActionsPerPath) {
        continue;
      }
      if (!candidate.global && !candidate.modal && pageActionsInPath >= maxPageActionsPerPath) {
        continue;
      }
      const representativeGroup = candidate.selectionGroup || candidate.pointerGroup;
      if (
        representativeGroup &&
        (representativeGroupsInPath.has(representativeGroup) || exploredRepresentativeGroups.has(representativeGroup))
      ) {
        continue;
      }
      const candidateSignature = discoveryCandidateSignature(candidate);
      if (candidate.global && globalCandidateOutcomes.has(candidateSignature)) {
        continue;
      }
      const nextPath: DiscoveryPath = {
        seed: current.seed,
        clicks: [...current.clicks, candidate],
        depth: current.depth + 1,
      };
      const signature = discoveryPathSignature(nextPath);
      if (visitedPaths.has(signature)) {
        continue;
      }
      visitedPaths.add(signature);
      if (representativeGroup) {
        exploredRepresentativeGroups.add(representativeGroup);
      }

      try {
        const startedAt = Date.now();
        await prepareDiscoveryPath(page, context, nextPath);
        const extracted = await extractCurrentDom(page, context);
        if (candidate.global) {
          globalCandidateOutcomes.set(candidateSignature, extracted.domHash);
        }
        if (seenPageHashes.has(extracted.pageHash)) {
          if (debugDiscovery) {
            console.log(
              `[discovery] duplicate depth=${nextPath.depth} ${candidate.global ? "global" : "local"} ${candidate.label} ${Date.now() - startedAt}ms`,
            );
          }
          continue;
        }

        const stateId = autoStateId(nextPath, results.length + 1, index + 1);
        const result = await captureExtractedPage(page, context, stateId, extracted);
        result.origin = "auto";
        result.pageHash = extracted.pageHash;
        result.displayName = candidate.label;
        result.paths = [{
          id: `path-${stateId}`,
          origin: "auto",
          operations: nextPath.clicks.map((click) => ({ kind: "click", label: click.label, selector: click.selector, at: result.capturedAt })),
          capturedAt: result.capturedAt,
        }];
        results.push(result);
        seenHashes.add(result.domHash);
        seenPageHashes.add(extracted.pageHash);
        context.onProgress?.(`Discovered ${results.length} additional state(s)...`);
        if (debugDiscovery) {
          console.log(
            `[discovery] captured ${stateId} depth=${nextPath.depth} ${candidate.global ? "global" : "local"} ${candidate.label} ${Date.now() - startedAt}ms`,
          );
        }
        nextPath.domHash = result.domHash;
        nextPath.pageHash = extracted.pageHash;
        discoveredPaths.push(nextPath);
      } catch (error) {
        if (debugDiscovery) {
          console.log(
            `[discovery] failed depth=${nextPath.depth} ${candidate.global ? "global" : "local"} ${candidate.label}: ${formatError(error)}`,
          );
        }
        // Discovery is intentionally best effort; explicit states are authoritative.
      }
    }

    return discoveredPaths;
  };

  const queue = [...seedPaths];
  const maxEmptyExpansions = context.config.discovery.maxEmptyExpansions ?? 12;
  let emptyExpansions = 0;
  while (queue.length > 0 && results.length < maxAutoStates) {
    const current = queue.shift()!;
    const previousResultCount = results.length;
    const discoveredPaths = await explore(current);
    if (results.length === previousResultCount && discoveredPaths.length === 0) {
      emptyExpansions += 1;
      if (maxEmptyExpansions > 0 && emptyExpansions >= maxEmptyExpansions) {
        context.onProgress?.(
          `Stopped discovery after ${emptyExpansions} empty expansion(s); captured ${results.length} additional state(s).`,
        );
        break;
      }
    } else {
      emptyExpansions = 0;
    }
    for (const discoveredPath of discoveredPaths) {
      if (discoveredPath.depth < maxDepth) {
        queue.push(discoveredPath);
      }
    }
  }

  return results;
}

function buildSemanticPageHash(semanticSignature: unknown, root: SceneNode): string {
  if (semanticSignature) {
    const serialized = JSON.stringify(semanticSignature);
    if (serialized) {
      return shortHash(serialized);
    }
  }
  return buildPageSignature(root);
}

const pageStateSignatureScript = `
  const normalizeText = (value) =>
    (value || "")
      .replace(/\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}日?/g, "<date>")
      .replace(/\\d{2,4}[-/]\\d{1,2}[-/]\\d{1,2}/g, "<date>")
      .replace(/[A-Z]{1,8}\\d{2,}/g, "<code>")
      .replace(/\\d+/g, "#")
      .replace(/\\s+/g, " ")
      .trim();
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) !== 0
    );
  };
  const elementLabel = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy ? document.getElementById(labelledBy)?.textContent : "";
    return normalizeText(
      element.getAttribute("aria-label") ||
        labelledText ||
        element.getAttribute("data-page-panel") ||
        element.getAttribute("data-page") ||
        element.id ||
        element.textContent,
    ).slice(0, 120);
  };
  const chooseTopModal = () => {
    const modalSelectors = [
      "[role=dialog]",
      "[aria-modal=true]",
      ".modal-dialog",
      ".sub-modal-dialog",
      ".upload-dialog",
      ".cancel-dialog",
      ".activity-form-dialog",
      ".activity-import-dialog",
      ".activity-history-dialog",
      ".modal-mask:not([hidden])",
      ".sub-modal-mask:not([hidden])",
      ".sheet.show",
      ".bottom-sheet.show",
      ".drawer.show",
      ".popup.show",
      ".popover.show",
      ".overlay.show",
      "dialog[open]",
      "[popover]:not([hidden])",
      "[id$='modal']:not([hidden])",
      "[id$='-modal']:not([hidden])",
    ];
    const modals = modalSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => visible(element));
    if (!modals.length) return null;
    const selected = modals
      .map((element, index) => {
        const dialog =
          element.matches("[role=dialog], [aria-modal=true], dialog[open], .modal-dialog, .sub-modal-dialog, .upload-dialog, .cancel-dialog")
            ? element
            : element.querySelector("[role=dialog], [aria-modal=true], dialog[open], .modal-dialog, .sub-modal-dialog, .upload-dialog, .cancel-dialog") ||
              element;
        const style = getComputedStyle(element);
        const zIndex = Number.parseInt(style.zIndex || "0", 10);
        const rect = element.getBoundingClientRect();
        return {
          element: dialog,
          index,
          area: Math.round(rect.width * rect.height),
          zIndex: Number.isFinite(zIndex) ? zIndex : 0,
        };
      })
      .sort((a, b) => a.zIndex - b.zIndex || a.area - b.area || a.index - b.index)
      .slice(-1)[0];
    return selected?.element || null;
  };
  const chooseMainPage = () => {
    const chooseLargest = (elements) =>
      elements
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          return { element, index, area: Math.round(rect.width * rect.height) };
        })
        .sort((a, b) => a.area - b.area || a.index - b.index)
        .slice(-1)[0]?.element;
    const explicitPages = Array.from(document.querySelectorAll("[data-page-panel], main .page, .app .page")).filter(
      (element) => visible(element),
    );
    const explicitPage = chooseLargest(explicitPages);
    if (explicitPage) return explicitPage;
    if (document.querySelector("[data-page-panel], main .page, .app .page")) return null;
    const mainScopes = Array.from(document.querySelectorAll("main, [role=main]")).filter((element) => visible(element));
    const mainScope = chooseLargest(mainScopes);
    if (mainScope) return mainScope;
    return document.body;
  };
  const controlText = (scope) =>
    Array.from(
      scope.querySelectorAll(
        "h1,h2,h3,h4,button,a,label,th,legend,[role=tab],[aria-label],[data-page],[data-page-panel]",
      ),
    )
      .filter((element) => visible(element))
      .map((element) => elementLabel(element))
      .filter(Boolean)
      .slice(0, 240);
  const structure = (scope) => {
    const nodes = [];
    const walk = (element, depth) => {
      if (depth > 5 || nodes.length >= 300 || !visible(element)) return;
      const rect = element.getBoundingClientRect();
      const role = element.getAttribute("role") || "";
      const semanticClass = Array.from(element.classList || [])
        .filter((className) => /(page|panel|modal|dialog|table|form|query|action|menu|tab|card|section)/i.test(className))
        .slice(0, 3)
        .join(".");
      nodes.push([
        element.tagName.toLowerCase(),
        role || semanticClass,
        Math.round(rect.width / 8) * 8,
        Math.round(rect.height / 8) * 8,
      ]);
      Array.from(element.children).forEach((child) => walk(child, depth + 1));
    };
    walk(scope, 0);
    return nodes;
  };

  const modal = chooseTopModal();
  const mainPage = chooseMainPage();
  if (!modal && !mainPage) {
    return {
      kind: "empty-page",
      label: "no-visible-page-panel",
      controls: [],
      structure: [],
    };
  }
  const scope = modal || mainPage || document.body;
  const interactionState = Array.from(
    scope.querySelectorAll(
      "input,option,[aria-checked],[aria-selected],[aria-expanded],[aria-disabled],[disabled]",
    ),
  )
    .filter((element) => visible(element))
    .map((element) => {
      const control = element;
      const input = control instanceof HTMLInputElement;
      const option = control instanceof HTMLOptionElement;
      return [
        control.tagName.toLowerCase(),
        control.getAttribute("type") || control.getAttribute("role") || "",
        control.getAttribute("name") || "",
        input ? control.checked : option ? control.selected : "",
        control.getAttribute("aria-checked") || "",
        control.getAttribute("aria-selected") || "",
        control.getAttribute("aria-expanded") || "",
        input ? control.disabled : control.getAttribute("aria-disabled") || control.hasAttribute("disabled"),
      ];
    });
  return {
    kind: modal ? "modal" : "page",
    label: elementLabel(scope),
    controls: controlText(scope),
    structure: structure(scope),
    interactionState,
  };
`;

async function inspectPageInventory(page: Page, context: CaptureContext): Promise<PageInventory> {
  const seed = context.config.states[0];
  if (!seed) return { count: 0, labels: [] };
  try {
    await prepareState(page, context, seed);
    return page.evaluate(
      ({ include, exclude, skipTextPatterns, source }) => {
        return Function("include", "exclude", "skipTextPatterns", source)(include, exclude, skipTextPatterns);
      },
      {
        include: context.config.discovery.include,
        exclude: context.config.discovery.exclude,
        skipTextPatterns: context.config.discovery.skipTextPatterns,
        source: inventoryScript,
      },
    ).then((labels) => ({ count: labels.length, labels }));
  } catch {
    return { count: 0, labels: [] };
  }
}

const inventoryScript = `
const labels = new Set();
const labelFor = (element, fallback) =>
  (
    element.getAttribute("aria-label") ||
    element.getAttribute("aria-labelledby") ||
    element.getAttribute("data-page") ||
    element.id ||
    element.textContent ||
    fallback
  )
    .trim()
    .replace(/\\s+/g, " ")
    .slice(0, 80);
const skipByText = (label) =>
  (skipTextPatterns || []).some((pattern) => {
    try {
      return new RegExp(pattern).test(label);
    } catch {
      return false;
    }
  });
const excluded = (element) => exclude.some((selector) => element.matches(selector));

document.querySelectorAll("[data-page], [data-page-panel]").forEach((element) => {
  labels.add("page:" + labelFor(element, "page"));
});
document
  .querySelectorAll("[role=dialog], [aria-modal=true], .modal-mask, .sub-modal-mask, [id$='modal'], [id$='-modal']")
  .forEach((element) => {
    labels.add("dialog:" + labelFor(element, "dialog"));
  });
include
  .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
  .filter((element) => !excluded(element))
  .forEach((element) => {
    const label = labelFor(element, element.tagName.toLowerCase());
    const idClass = (element.id || "") + " " + (element.getAttribute("class") || "");
    if (skipByText(label)) return;
    if (/(open|add|create|new|import|history|copy|view|edit|modal|menu|申请|新增|导入|历史|复制|查看|编辑)/i.test(label + " " + idClass)) {
      labels.add("action:" + label);
    }
  });
return Array.from(labels);
`;

async function prepareDiscoveryPath(page: Page, context: CaptureContext, path: DiscoveryPath): Promise<void> {
  await prepareState(page, context, path.seed);
  for (const click of path.clicks) {
    await clickDiscoveryCandidate(page, context, click);
  }
}

async function clickDiscoveryCandidate(page: Page, context: CaptureContext, candidate: Candidate): Promise<void> {
  await page.locator(candidate.selector).first().click({
    timeout: context.config.discovery.clickTimeout ?? 700,
  });
  await waitForReady(page, context.config, {
    id: "auto-discovery",
    waitFor: context.config.discovery.clickWaitFor ?? 120,
  });
}

function discoveryPathSignature(path: DiscoveryPath): string {
  return `${path.seed.id}:${path.clicks.map((click) => click.selector).join(" > ")}`;
}

function discoveryCandidateSignature(candidate: Candidate): string {
  return candidate.targetKey || `${candidate.selector}:${candidate.label}`;
}

function autoStateId(path: DiscoveryPath, ordinal: number, candidateIndex: number): string {
  const label = slugify(path.clicks[path.clicks.length - 1]?.label || "state");
  return `auto-${slugify(path.seed.id)}-${path.depth}-${ordinal}-${candidateIndex}-${label}`;
}

async function getDiscoveryCandidates(page: Page, discovery: DiscoveryConfig): Promise<Candidate[]> {
  return page.evaluate(
    ({ include, exclude, maxCandidatesPerState, skipTextPatterns, source }) => {
      return Function("include", "exclude", "maxCandidatesPerState", "skipTextPatterns", source)(
        include,
        exclude,
        maxCandidatesPerState,
        skipTextPatterns,
      );
    },
    { ...discovery, source: discoveryScript },
  );
}

const discoveryScript = `
const excluded = (element) => exclude.some((selector) => element.matches(selector));
const visible = (element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
};
const enabled = (element) => {
  if (element.disabled) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  if (element.closest("[disabled], [aria-disabled=true]")) return false;
  return true;
};
const receivesPointer = (element) => {
  const rect = element.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
  const target = document.elementFromPoint(x, y);
  return target === element || (!!target && element.contains(target));
};
const priority = (element) => {
  if (element.hasAttribute("data-figma-capture")) return 0;
  if (element.hasAttribute("data-page") || element.closest("[data-page]")) return 1;
  if (element.getAttribute("aria-haspopup") || element.getAttribute("aria-expanded")) return 2;
  if (element.matches("a[href]:not([href='#']):not([href=''])")) return 3;
  if (element.matches("button, [role=button]")) return 4;
  return 5;
};
const selectionGroupFor = (element) => {
  const explicit = element.getAttribute("data-figma-state-group") || element.closest("[data-figma-state-group]")?.getAttribute("data-figma-state-group");
  if (explicit) return "explicit:" + explicit;
  const inputType = element.matches("input") ? (element.getAttribute("type") || "text").toLowerCase() : "";
  const role = element.getAttribute("role") || "";
  const isSelectionControl =
    inputType === "checkbox" ||
    inputType === "radio" ||
    ["checkbox", "radio", "option"].includes(role) ||
    element.hasAttribute("aria-checked") ||
    element.hasAttribute("aria-selected");
  if (!isSelectionControl) return "";
  const groupScope = element.closest("[role=radiogroup], [role=listbox], [role=grid], form, table, ul, ol");
  const scopeKey = groupScope
    ? groupScope.id || groupScope.getAttribute("aria-label") || cssPath(groupScope)
    : "document";
  const name = element.getAttribute("name") || "";
  return ["selection", inputType || role || "aria", name || "unnamed", scopeKey].join(":");
};
const globalRegion = (element) =>
  !!element.closest("nav, aside, header, [role=navigation], .sidebar, .side-nav, .topbar, .tabs-bar");
const targetKeyFor = (element) => {
  const pageTarget = element.getAttribute("data-page") || element.closest("[data-page]")?.getAttribute("data-page");
  if (pageTarget) return "page:" + pageTarget;
  const controls = element.getAttribute("aria-controls");
  if (controls) return "controls:" + controls;
  const href = element.getAttribute("href");
  if (href && href !== "#") return "href:" + href;
  const dialogTarget = element.getAttribute("data-target") || element.getAttribute("data-modal-target");
  if (dialogTarget) return "target:" + dialogTarget;
  return "";
};
const skippedByText = (element, label) => {
  if (element.hasAttribute("data-figma-capture")) return false;
  return (skipTextPatterns || []).some((pattern) => {
    try {
      return new RegExp(pattern).test(label);
    } catch {
      return false;
    }
  });
};
const topModalScope = () => {
  const modalSelectors = [
    "[role=dialog]",
    "[aria-modal=true]",
    ".modal-dialog",
    ".sub-modal-dialog",
    ".upload-dialog",
    ".cancel-dialog",
    ".activity-form-dialog",
    ".activity-import-dialog",
    ".activity-history-dialog",
    ".modal-mask:not([hidden])",
    ".sub-modal-mask:not([hidden])",
    ".sheet.show",
    ".bottom-sheet.show",
    ".drawer.show",
    ".popup.show",
    ".popover.show",
    ".overlay.show",
    "dialog[open]",
    "[popover]:not([hidden])",
  ];
  const modals = modalSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((element) => visible(element));
  if (!modals.length) return null;
  return modals
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      const target = document.elementFromPoint(x, y);
      const zIndex = Number.parseInt(getComputedStyle(element).zIndex || "0", 10);
      const isMask = element.matches(".modal-mask, .sub-modal-mask");
      return {
        element,
        index,
        hit: target === element || (!!target && element.contains(target)) ? 1 : 0,
        kind: isMask ? 0 : 1,
        zIndex: Number.isFinite(zIndex) ? zIndex : 0,
      };
    })
    .sort((a, b) => a.hit - b.hit || a.kind - b.kind || a.zIndex - b.zIndex || a.index - b.index)
    .slice(-1)[0].element;
};
const cssPath = (element) => {
  if (element.id) return "#" + CSS.escape(element.id);
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    const parentElement = current.parentElement;
    if (!parentElement) break;
    const siblings = Array.from(parentElement.children).filter((child) => child.tagName === current.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(current.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
    current = parentElement;
  }
  return "body > " + parts.join(" > ");
};
const pointerGroupFor = (element) => {
  if (element.matches("button,a,input,select,textarea,[role=button],[role=link],[role=tab]")) return "";
  if (getComputedStyle(element).cursor !== "pointer") return "";
  const semanticClass = Array.from(element.classList || [])
    .filter((className) => /(card|row|item|tile|entry|result)/i.test(className))
    .slice(0, 2)
    .join(".");
  if (!semanticClass) return "";
  const scope = element.closest("[role=list], [role=grid], [role=table], [role=tablist], ul, ol, tbody, main, section, article");
  return "pointer:" + semanticClass + ":" + (scope ? cssPath(scope) : "document");
};
const seen = new Set();
const scope = topModalScope();
const selectionSelectors = [
  'input[type="checkbox"]',
  'input[type="radio"]',
  "[role=checkbox]",
  "[role=radio]",
  "[role=option]",
  "[aria-checked]",
  "[aria-selected]",
];
const includedElements = Array.from(new Set([...(include || []), ...selectionSelectors]))
  .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
const pointerElements = Array.from(document.querySelectorAll("*")).filter((element) => !!pointerGroupFor(element));
const candidates = [...includedElements, ...pointerElements]
  .filter((element) => (!scope || scope.contains(element)) && visible(element) && enabled(element) && receivesPointer(element) && !excluded(element))
  .map((element) => {
    const label =
      element.getAttribute("aria-label") ||
      (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40) ||
      element.tagName.toLowerCase();
    return {
      label,
      selector: cssPath(element),
      targetKey: targetKeyFor(element),
      selectionGroup: selectionGroupFor(element),
      pointerGroup: pointerGroupFor(element),
      priority: priority(element),
      global: globalRegion(element),
      skipped: skippedByText(element, label),
    };
  })
  .filter((candidate) => !candidate.skipped)
  .filter((candidate) => {
    if (seen.has(candidate.selector)) return false;
    seen.add(candidate.selector);
    return true;
  })
  .sort((a, b) => a.priority - b.priority);
const limit = Number(maxCandidatesPerState);
return (Number.isFinite(limit) && limit > 0 ? candidates.slice(0, limit) : candidates)
  .map(({ label, selector, targetKey, selectionGroup, pointerGroup, global }) => ({
    label,
    selector,
    targetKey,
    selectionGroup: selectionGroup || undefined,
    pointerGroup: pointerGroup || undefined,
    global,
    modal: !!scope,
  }));
`;

async function captureRasterAssets(page: Page, rasterIds: string[]): Promise<Asset[]> {
  const assets: Asset[] = [];
  for (const id of rasterIds) {
    try {
      const bytes = await page
        .locator(`[data-html2figma-id="${id}"]`)
        .first()
        .screenshot({ timeout: 3_000, scale: "device" });
      assets.push({
        id,
        kind: "raster",
        source: id,
        mimeType: "image/png",
        dataUrl: dataUrlFromBytes(Buffer.from(bytes), "image/png"),
        warnings: [`Captured as ${highFidelityRasterScale}× high-resolution raster fallback.`],
      });
    } catch (error) {
      assets.push({
        id,
        kind: "raster",
        source: id,
        mimeType: "image/png",
        warnings: [`Failed to capture raster fallback: ${formatError(error)}`],
      });
    }
  }
  return assets;
}

function capturePageOptions(config: Html2FigmaConfig) {
  return {
    viewport: { width: config.viewport.width, height: config.viewport.height },
    // Complex SVGs that include foreignObject cannot be imported as editable
    // Figma vectors. Capture their faithful raster fallback at retina-plus
    // density so labels remain readable when the Figma canvas is zoomed.
    deviceScaleFactor: Math.max(highFidelityRasterScale, config.viewport.deviceScaleFactor ?? 1),
  };
}

function attachAssetWarnings(root: SceneNode, assets: Asset[]): SceneNode {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const visit = (node: SceneNode): SceneNode => {
    const asset = node.assetId ? assetById.get(node.assetId) : undefined;
    return {
      ...node,
      warnings: asset?.warnings?.length ? [...node.warnings, ...asset.warnings] : node.warnings,
      children: node.children.map(visit),
    };
  };
  return visit(root);
}

function collectAssetWarnings(assets: Asset[]): string[] {
  return assets.flatMap((asset) => asset.warnings.map((warning) => `${asset.id}: ${warning}`));
}

function buildReport(states: CapturedState[]): ConversionReport {
  const stateReports = states.map((state) => ({
    id: state.id,
    route: state.route,
    domHash: state.domHash,
    nodeCount: countNodes(state.root),
    assetCount: state.assets.length,
    rasterFallbackCount: countByKind(state.root, "RASTER_FALLBACK"),
    screenshotPath: state.screenshotPath,
    warnings: state.warnings,
    origin: state.origin,
    displayName: state.displayName,
    pathCount: state.paths?.length ?? 0,
  }));
  return {
    stateCount: states.length,
    assetCount: states.reduce((sum, state) => sum + state.assets.length, 0),
    rasterFallbackCount: stateReports.reduce((sum, state) => sum + state.rasterFallbackCount, 0),
    warnings: stateReports.flatMap((state) => state.warnings),
    coverage: {
      captured: states.length,
      auto: states.filter((state) => state.origin === "auto").length,
      recorded: states.filter((state) => state.origin === "recorded").length,
      duplicates: 0,
      outcomes: [],
    },
    states: stateReports,
  };
}

function countNodes(node: SceneNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

function countByKind(node: SceneNode, kind: SceneNode["kind"]): number {
  return (node.kind === kind ? 1 : 0) + node.children.reduce((sum, child) => sum + countByKind(child, kind), 0);
}

async function waitForReady(page: Page, config: Html2FigmaConfig, state: StateAction): Promise<void> {
  const selector = state.readySelector ?? config.readySelector;
  if (selector) {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  if (state.waitFor) {
    await page.waitForTimeout(state.waitFor);
  }
  await page
    .evaluate(
      async ({ timeout }) => {
        const waitForResources = async () => {
          await document.fonts?.ready;
          await Promise.all(
            Array.from(document.images)
              .filter((image) => !image.complete)
              .map(
                (image) =>
                  new Promise<void>((resolve) => {
                    image.addEventListener("load", () => resolve(), { once: true });
                    image.addEventListener("error", () => resolve(), { once: true });
                  }),
              ),
          );
        };
        await Promise.race([
          waitForResources(),
          new Promise<void>((resolve) => window.setTimeout(resolve, timeout)),
        ]);
      },
      { timeout: config.resourceTimeout ?? 2_000 },
    )
    .catch(() => {
      // Resource readiness is best-effort; conversion should not hang on fonts/images.
    });
}

async function waitForLiveSettled(page: Page, config: Html2FigmaConfig): Promise<void> {
  await waitForReady(page, config, { id: "recording" });
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          let timer = window.setTimeout(resolve, 300);
          const observer = new MutationObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              observer.disconnect();
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }, 250);
          });
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        }),
    )
    .catch(() => undefined);
}

function resolveStateUrl(baseUrl: string, stateUrl?: string): string {
  if (!stateUrl) return baseUrl;
  if (/^https?:\/\//i.test(stateUrl) || /^file:\/\//i.test(stateUrl)) return stateUrl;
  return new URL(stateUrl, baseUrl).href;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
