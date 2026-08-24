# html2figma-local

Local CLI plus a small Figma companion plugin for converting runnable HTML into editable Figma layers.

## 中文使用文档

如果要发给另一台电脑使用，或者给不熟悉命令行的人操作，请直接看：

[docs/新电脑使用说明.md](docs/新电脑使用说明.md)

## Quick Start

Drag-and-drop UI:

```bash
npm install
npm run app
```

Or use the platform launcher:

- macOS: double-click `scripts/start-html2figma-mac.command`
- Windows: double-click `scripts/start-html2figma-windows.bat`

Open the shown local page, drop a runnable frontend project or its static export folder, generate the bundle, then run the Figma companion plugin and click **Import latest session**. The drag-and-drop app discovers `.html`, `.htm`, `.xhtml`, `.xht`, `.shtml`, and `.shtm` entry pages in the uploaded folder and puts them into one Figma-ready bundle.

CLI:

```bash
npm install
npm run build
npm run dev -- convert --input ./examples/sample.html --config ./examples/html2figma.config.ts
```

The CLI writes:

- `.html2figma/bundle.json` - captured Scene JSON consumed by the Figma plugin
- `.html2figma/report.json` - state, asset, warning, and fallback summary
- `.html2figma/screenshots/*.png` - browser screenshots used as visual baselines

By default the CLI keeps a local session server running at:

```text
http://127.0.0.1:4777/session/latest
```

In Figma, load `plugin/manifest.json` as a development plugin, run **HTML2Figma Local Companion**, and click **Import latest session**.

## CLI

### Drag-and-drop app

```bash
html2figma app
```

The app starts two local services:

- `http://127.0.0.1:4888` - browser UI for dropping local HTML/CSS projects
- `http://localhost:4777/session/latest` - bundle endpoint consumed by the Figma plugin

This works on macOS and Windows as long as Node.js and Playwright Chromium are installed.

### Supported frontend deliverables

Upload a folder that can already run in a browser. The local preview server supports static HTML/XHTML entry documents, CSS, JavaScript/ES modules, JSON/Web Manifest, WebAssembly, SVG, PNG/JPEG/GIF/WebP/AVIF images, WOFF/WOFF2/TTF/OTF/EOT fonts, and common audio/video files. It also handles SPA deep links and recognises static exports in `dist/`, `build/`, `out/`, `public/`, `wwwroot/`, `.output/public/`, and `.vercel/output/static/`.

For React, Vue, Angular, Svelte, Astro, Next.js, Nuxt, and similar projects, upload the generated static export directory instead of source files such as `.tsx`, `.vue`, or `.svelte`. The app will explain this when no runnable entry document is present. Server-rendered applications, API calls requiring sign-in, and build-only source projects must be made runnable or exported before capture.

During capture only, blocked CDN Mermaid scripts are resolved with the tool's bundled runtime. Your source files and their normal browser behaviour are not changed.

For non-command-line users, the launchers in `scripts/` run the same app and install dependencies on first use.

The Figma plugin is configured for `localhost:4777`, so the app now fails clearly if that port is already occupied. Close the old html2figma terminal/window and start again.

### Command line conversion

```bash
html2figma convert \
  --input ./index.html \
  --figma-url "https://figma.com/design/FILE_KEY/Name" \
  --config ./html2figma.config.ts \
  --out .html2figma
```

Use `--no-server` for CI or diagnostics when you only want the bundle/report files.

```bash
html2figma serve --out .html2figma
```

Serves a previously generated bundle to the Figma plugin.

## Config

```ts
import type { Html2FigmaConfig } from "./src/types";

export default {
  input: "./index.html",
  figmaUrl: "https://figma.com/design/FILE_KEY/Name",
  viewport: { width: 1440, height: 900 },
  states: [
    { id: "home", url: "/" },
    { id: "login-modal", from: "home", click: "[data-testid=open-login]" },
  ],
  discovery: {
    include: ["button", "a", "[role=button]", "[data-figma-capture]"],
    exclude: ["[data-no-capture]", "a[target=_blank]"],
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
```

## Editable Output

- Text nodes become Figma `Text` layers.
- DOM containers become `Frame` layers with fills, borders, radius, opacity, and basic shadows.
- `<img>` and CSS background images become image fills.
- Inline SVG becomes editable vector nodes through `createNodeFromSvg`.
- Canvas/video/unsupported visual effects are captured as `RASTER_FALLBACK` and listed in `report.json`.

## Selection-dependent flows

The explorer treats visible checkbox, radio, option, ARIA selection controls, and card-like elements styled with `cursor: pointer` as interaction candidates. It captures the unselected state and one representative result for each equivalent selection group, then continues to discover actions that become available after selection. This prevents a table or card list with many equivalent rows from producing one nearly identical screen per row.

Use `data-figma-state-group="..."` on a control or an ancestor when the page needs an explicit equivalence group. Without it, the explorer groups selection controls by their type, `name`, and nearest form/list/table container. Use `data-no-capture` to exclude a control.

For a manually declared state that must be retained even if it has the same semantic page signature as another state, set `capture: "always"`:

```ts
{ id: "selected-example", from: "list", click: 'input[name="channel"]', capture: "always" }
```

## Current Limits

- The first implementation prioritizes desktop viewport capture.
- Figma import is intentionally two-step because external CLIs cannot directly call the Figma Plugin API inside a design file.
- Auto-layout metadata is captured, but the companion importer currently favors absolute positioning for visual accuracy.
- Pixel diff against imported Figma frames is left as a follow-up because it requires exporting Figma node screenshots after import.
