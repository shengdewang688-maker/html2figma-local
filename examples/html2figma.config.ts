import type { Html2FigmaConfig } from "../src/types.js";

export default {
  input: "./examples/sample.html",
  viewport: { width: 1440, height: 900 },
  states: [
    { id: "home", url: "/" },
    { id: "login-modal", from: "home", click: "[data-testid=open-login]", waitFor: 200 },
  ],
  discovery: {
    include: ["button", "a", "[role=button]", "[data-figma-capture]"],
    exclude: ["[data-no-capture]", "a[target=_blank]", "#close"],
    maxDepth: 100,
    maxAutoStates: 1000,
    maxCandidatesPerState: 200,
    maxModalActionsPerPath: 2,
    maxPageActionsPerPath: 2,
    inventoryExtraStates: 3,
    maxEmptyExpansions: 12,
    skipTextPatterns: ["^查询$", "^重置$", "^刷新$", "^导出$", "^保存$", "^取消$", "^[‹›<>]$", "^\\d+$"],
  },
  output: {
    mode: "new-version-page",
    pageName: "HTML Import {{timestamp}}",
  },
} satisfies Html2FigmaConfig;
