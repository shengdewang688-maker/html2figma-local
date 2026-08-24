#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const bundlePath = path.resolve(process.argv[2] || ".html2figma/bundle.json");
const codePath = path.resolve("plugin/code.js");
const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
const code = fs.readFileSync(codePath, "utf8");

class MockNode {
  constructor(type) {
    this.type = type;
    this.children = [];
    this.name = type;
    this.x = 0;
    this.y = 0;
    this.width = 1;
    this.height = 1;
    this.fills = [];
    this.strokes = [];
    this.effects = [];
    this.sharedPluginData = new Map();
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setSharedPluginData(namespace, key, value) {
    this.sharedPluginData.set(`${namespace}:${key}`, value);
  }
}

const loadedFonts = new Set();

class MockTextNode extends MockNode {
  constructor() {
    super("TEXT");
    this.characters = "";
    this.fontSize = 12;
    this._textAutoResize = "NONE";
    this._fontName = { family: "Inter", style: "Regular" };
  }

  set textAutoResize(value) {
    const fontKey = `${this._fontName.family}/${this._fontName.style}`;
    if (!loadedFonts.has(fontKey)) {
      throw new Error(
        `In setTextAutoResize: Cannot write to node with unloaded font "${this._fontName.family} ${this._fontName.style}".`,
      );
    }
    this._textAutoResize = value;
  }

  set fontName(value) {
    const fontKey = `${value.family}/${value.style}`;
    if (!loadedFonts.has(fontKey)) {
      throw new Error(`Cannot use unloaded font "${value.family} ${value.style}".`);
    }
    this._fontName = value;
  }
}

class MockPage extends MockNode {
  constructor() {
    super("PAGE");
  }
}

const uiMessages = [];
const figma = {
  root: { children: [] },
  currentPage: undefined,
  ui: {
    onmessage: undefined,
    postMessage(message) {
      uiMessages.push(message);
    },
  },
  viewport: {
    scrollAndZoomIntoView() {},
  },
  showUI() {},
  createPage() {
    const page = new MockPage();
    this.root.children.push(page);
    return page;
  },
  async setCurrentPageAsync(page) {
    this.currentPage = page;
  },
  createFrame() {
    return new MockNode("FRAME");
  },
  createText() {
    return new MockTextNode();
  },
  createRectangle() {
    return new MockNode("RECTANGLE");
  },
  createNodeFromSvg() {
    return new MockNode("SVG");
  },
  createImage() {
    return { hash: `image-${Math.random().toString(16).slice(2)}` };
  },
  async loadFontAsync(font) {
    loadedFonts.add(`${font.family}/${font.style}`);
  },
};

const context = vm.createContext({
  figma,
  __html__: "",
  Map,
  Set,
  Uint8Array,
  Array,
  Number,
  Math,
  String,
  RegExp,
  atob: (value) => Buffer.from(value, "base64").toString("binary"),
  console,
});

vm.runInContext(code, context, { filename: codePath });
if (typeof figma.ui.onmessage !== "function") {
  throw new Error("plugin/code.js did not register figma.ui.onmessage");
}

await figma.ui.onmessage({ type: "import-bundle", bundle });

const done = uiMessages.find((message) => message.type === "done");
const error = uiMessages.find((message) => message.type === "error");
if (error) {
  throw new Error(error.message);
}
if (!done) {
  throw new Error("Plugin import did not report completion.");
}

const page = figma.currentPage;
if (!page) {
  throw new Error("Plugin did not create or select a page.");
}

const expected = bundle.states.length;
const topLevelFrames = page.children.filter((node) => node.type === "FRAME");
const importErrorFrames = topLevelFrames.filter((node) => /import error/i.test(node.name));
const nestedImportErrors = collectNodes(page).filter((node) => /import error/i.test(node.name));
const stateIds = new Set(
  topLevelFrames
    .map((node) => node.sharedPluginData.get("html2figma:stateId"))
    .filter(Boolean),
);

const failures = [];
if (topLevelFrames.length !== expected) {
  failures.push(`expected ${expected} top-level frame(s), got ${topLevelFrames.length}`);
}
if (stateIds.size !== expected) {
  failures.push(`expected ${expected} state id(s), got ${stateIds.size}`);
}
if (importErrorFrames.length) {
  failures.push(`${importErrorFrames.length} frame(s) imported as error placeholders`);
}
if (nestedImportErrors.length) {
  failures.push(
    `${nestedImportErrors.length} node(s) imported as nested error placeholders: ${nestedImportErrors
      .map((node) => node.name)
      .join(", ")}`,
  );
}

if (failures.length) {
  throw new Error(failures.join("; "));
}

console.log(
  JSON.stringify(
    {
      ok: true,
      pageName: page.name,
      stateCount: expected,
      topLevelFrames: topLevelFrames.length,
      message: done.message,
    },
    null,
    2,
  ),
);

function collectNodes(root) {
  return [root, ...(root.children || []).flatMap(collectNodes)];
}
