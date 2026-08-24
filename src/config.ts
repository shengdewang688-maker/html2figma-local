import path from "node:path";
import { pathToFileURL } from "node:url";
import { Html2FigmaConfig } from "./types.js";
import { resolveFromCwd } from "./utils/path.js";

const defaultConfig: Html2FigmaConfig = {
  input: "./index.html",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  states: [{ id: "home", url: "/" }],
  discovery: {
    include: [
      "button",
      "a",
      "[role=button]",
      "[data-figma-capture]",
      'input[type="checkbox"]',
      'input[type="radio"]',
      "[role=checkbox]",
      "[role=radio]",
      "[role=option]",
      "[aria-checked]",
      "[aria-selected]",
    ],
    exclude: ["[data-no-capture]", "a[target=_blank]", ".fullscreen", ".logout"],
    maxDepth: 100,
    maxAutoStates: 1000,
    maxCandidatesPerState: 200,
    clickWaitFor: 120,
    clickTimeout: 700,
    maxModalActionsPerPath: 2,
    maxPageActionsPerPath: 2,
    inventoryExtraStates: 3,
    maxEmptyExpansions: 12,
    skipTextPatterns: [
      "^$",
      "^关闭$",
      "^取消$",
      "^保存$",
      "^确定$",
      "^确认$",
      "^查询$",
      "^重置$",
      "^刷新$",
      "^导出$",
      "^下载",
      "下载$",
      "^开始导入$",
      "^失败原因下载$",
      "^全屏$",
      "^退出$",
      "^通知$",
      "^折叠菜单$",
      "×$",
      "^[‹›<>]$",
      "^\\d+$",
    ],
  },
  output: {
    mode: "new-version-page",
    pageName: "HTML Import {{timestamp}}",
  },
  navigationTimeout: 8_000,
  resourceTimeout: 2_000,
};

export async function loadConfig(configPath?: string): Promise<Html2FigmaConfig> {
  if (!configPath) {
    return structuredClone(defaultConfig);
  }

  const absolute = resolveFromCwd(configPath);
  const moduleUrl = pathToFileURL(absolute).href;
  const imported = await import(moduleUrl);
  const loaded = imported.default ?? imported.config ?? imported;
  return normalizeConfig({ ...defaultConfig, ...loaded });
}

export function mergeConfig(
  config: Html2FigmaConfig,
  overrides: { input?: string; figmaUrl?: string },
): Html2FigmaConfig {
  return normalizeConfig({
    ...config,
    input: overrides.input ?? config.input,
    figmaUrl: overrides.figmaUrl ?? config.figmaUrl,
  });
}

function normalizeConfig(config: Html2FigmaConfig): Html2FigmaConfig {
  if (!config.input) {
    throw new Error("Missing required config field: input");
  }
  if (!config.viewport?.width || !config.viewport?.height) {
    throw new Error("Missing required config field: viewport.width / viewport.height");
  }
  if (!config.states?.length) {
    config.states = [{ id: "home", url: "/" }];
  }
  if (!config.discovery) {
    config.discovery = structuredClone(defaultConfig.discovery);
  }
  if (!config.output) {
    config.output = structuredClone(defaultConfig.output);
  }
  config.navigationTimeout = config.navigationTimeout ?? defaultConfig.navigationTimeout;
  config.resourceTimeout = config.resourceTimeout ?? defaultConfig.resourceTimeout;
  config.input = isUrl(config.input) ? config.input : path.resolve(process.cwd(), config.input);
  config.sourceRoot = config.sourceRoot && !isUrl(config.sourceRoot) ? path.resolve(process.cwd(), config.sourceRoot) : config.sourceRoot;
  config.discovery.include = config.discovery.include?.length
    ? config.discovery.include
    : defaultConfig.discovery.include;
  config.discovery.exclude = config.discovery.exclude ?? [];
  config.discovery.maxDepth = config.discovery.maxDepth ?? defaultConfig.discovery.maxDepth;
  config.discovery.maxAutoStates = config.discovery.maxAutoStates ?? defaultConfig.discovery.maxAutoStates;
  config.discovery.maxCandidatesPerState =
    config.discovery.maxCandidatesPerState ?? defaultConfig.discovery.maxCandidatesPerState;
  config.discovery.clickWaitFor = config.discovery.clickWaitFor ?? defaultConfig.discovery.clickWaitFor;
  config.discovery.clickTimeout = config.discovery.clickTimeout ?? defaultConfig.discovery.clickTimeout;
  config.discovery.maxModalActionsPerPath =
    config.discovery.maxModalActionsPerPath ?? defaultConfig.discovery.maxModalActionsPerPath;
  config.discovery.maxPageActionsPerPath =
    config.discovery.maxPageActionsPerPath ?? defaultConfig.discovery.maxPageActionsPerPath;
  config.discovery.inventoryExtraStates =
    config.discovery.inventoryExtraStates ?? defaultConfig.discovery.inventoryExtraStates;
  config.discovery.maxEmptyExpansions =
    config.discovery.maxEmptyExpansions ?? defaultConfig.discovery.maxEmptyExpansions;
  config.discovery.skipTextPatterns = config.discovery.skipTextPatterns ?? defaultConfig.discovery.skipTextPatterns;
  return config;
}

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^file:\/\//i.test(input);
}
