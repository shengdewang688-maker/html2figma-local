figma.showUI(__html__, { width: 360, height: 220 });

const fontLoadCache = new Map();

figma.ui.onmessage = async (message) => {
  if (message.type !== "import-bundle") return;
  try {
    const result = await importBundle(message.bundle);
    figma.ui.postMessage({
      type: "done",
      message: `Imported ${result.stateCount} state(s), ${result.nodeCount} node(s) into "${result.pageName}".`,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error && error.message ? error.message : String(error),
    });
  }
};

async function importBundle(bundle) {
  if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.states)) {
    throw new Error("Invalid html2figma bundle.");
  }

  const pageName = uniquePageName(bundle.output?.pageName || "HTML Import");
  const page = figma.createPage();
  page.name = pageName;
  await figma.setCurrentPageAsync(page);

  const assetMap = new Map();
  let nodeCount = 0;
  let x = 0;

  for (const state of bundle.states) {
    try {
      for (const asset of state.assets || []) {
        assetMap.set(asset.id, asset);
      }

      const frame = await createSceneNode(state.root, page, assetMap, { x: 0, y: 0 });
      const device = state.viewport?.width <= 768 ? "mobile" : "desktop";
      const origin = state.origin === "recorded" ? "补录" : state.origin === "auto" ? "自动" : "初始";
      frame.name = `${device} / ${origin} / ${state.displayName || state.id}`;
      frame.x = x;
      frame.y = 0;
      frame.setSharedPluginData("html2figma", "stateId", state.id);
      frame.setSharedPluginData("html2figma", "route", state.route || "");
      frame.setSharedPluginData("html2figma", "domHash", state.domHash || "");
      frame.setSharedPluginData("html2figma", "capturedAt", state.capturedAt || "");
      frame.setSharedPluginData("html2figma", "origin", state.origin || "explicit");
      frame.setSharedPluginData("html2figma", "pageHash", state.pageHash || "");
      frame.setSharedPluginData("html2figma", "paths", JSON.stringify(state.paths || []));
      nodeCount += countSceneNodes(state.root);
      x += state.root.rect.width + 120;
    } catch (error) {
      const frame = figma.createFrame();
      page.appendChild(frame);
      frame.name = `desktop / ${state.id} import error`;
      frame.x = x;
      frame.y = 0;
      frame.resize(state.root?.rect?.width || 1440, 160);
      frame.fills = [{ type: "SOLID", color: { r: 1, g: 0.95, b: 0.95 } }];
      const text = figma.createText();
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      text.fontName = { family: "Inter", style: "Regular" };
      text.characters = error && error.message ? error.message : String(error);
      text.fontSize = 16;
      text.x = 24;
      text.y = 24;
      text.resize(Math.max(320, frame.width - 48), 80);
      frame.appendChild(text);
      x += frame.width + 120;
    }
  }

  figma.viewport.scrollAndZoomIntoView(page.children);
  return { pageName, stateCount: bundle.states.length, nodeCount };
}

async function createSceneNode(scene, parent, assetMap, parentRect) {
  if (scene.kind === "TEXT") {
    return createTextNode(scene, parent, parentRect);
  }
  if (scene.kind === "VECTOR" && scene.svg) {
    return createVectorNode(scene, parent, parentRect);
  }
  if (scene.kind === "IMAGE" || scene.kind === "RASTER_FALLBACK") {
    return createImageNode(scene, parent, assetMap, parentRect);
  }
  return createFrameNode(scene, parent, assetMap, parentRect);
}

async function createFrameNode(scene, parent, assetMap, parentRect) {
  const node = figma.createFrame();
  parent.appendChild(node);
  setCommonGeometry(node, scene, parentRect);
  node.name = scene.name || scene.kind;
  node.clipsContent = shouldClip(scene);
  node.fills = await fillsForScene(scene, assetMap);
  applyBorder(node, scene);
  applyRadius(node, scene);
  applyShadow(node, scene);

  const ownRect = scene.rect || { x: 0, y: 0 };
  for (const child of scene.children || []) {
    try {
      await createSceneNode(child, node, assetMap, ownRect);
    } catch (error) {
      await createErrorNode(child, node, ownRect, error);
    }
  }
  return node;
}

async function createErrorNode(scene, parent, parentRect, error) {
  const node = figma.createFrame();
  parent.appendChild(node);
  setCommonGeometry(node, scene, parentRect);
  node.name = `${scene.name || scene.kind} import error`;
  node.fills = [{ type: "SOLID", color: { r: 1, g: 0.94, b: 0.94 } }];
  const text = figma.createText();
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  text.fontName = { family: "Inter", style: "Regular" };
  text.characters = error && error.message ? error.message : String(error);
  text.fontSize = 10;
  text.x = 4;
  text.y = 4;
  text.resize(Math.max(1, node.width - 8), Math.max(1, node.height - 8));
  node.appendChild(text);
  return node;
}

async function createTextNode(scene, parent, parentRect) {
  const node = figma.createText();
  parent.appendChild(node);
  node.name = scene.name || "Text";
  const fontName = await loadBestFont(scene.style || {});
  node.fontName = fontName;
  const noWrap = isNoWrapText(scene);
  if (noWrap) {
    setNoWrapTextGeometry(node, scene, parentRect);
  } else {
    setCommonGeometry(node, scene, parentRect);
    node.textAutoResize = "NONE";
    node.resize(Math.max(1, scene.rect.width), Math.max(1, scene.rect.height));
  }

  if (scene.style?.fontSize) {
    node.fontSize = fittedFontSize(scene);
  }
  const lineHeight = fittedLineHeight(scene);
  if (lineHeight) node.lineHeight = { unit: "PIXELS", value: lineHeight };
  if (typeof scene.style?.letterSpacing === "number") {
    node.letterSpacing = { unit: "PIXELS", value: scene.style.letterSpacing };
  }
  node.textAlignHorizontal = scene.style?.textAlign || "LEFT";
  node.fills = solidFill(scene.style?.color || "#111111", scene.style?.colorOpacity);
  node.characters = scene.text || "";
  if (noWrap) {
    setNoWrapTextGeometry(node, scene, parentRect);
  } else {
    node.resize(Math.max(1, scene.rect.width), Math.max(1, scene.rect.height));
  }
  return node;
}

async function createVectorNode(scene, parent, parentRect) {
  const node = figma.createNodeFromSvg(scene.svg);
  parent.appendChild(node);
  setCommonGeometry(node, scene, parentRect);
  node.name = scene.name || "SVG";
  try {
    node.resize(Math.max(1, scene.rect.width), Math.max(1, scene.rect.height));
  } catch {
    // Some SVG imports contain nested vectors that cannot be resized uniformly.
  }
  return node;
}

async function createImageNode(scene, parent, assetMap, parentRect) {
  const node = figma.createRectangle();
  parent.appendChild(node);
  setCommonGeometry(node, scene, parentRect);
  node.name = scene.name || scene.kind;
  node.fills = await fillsForScene(scene, assetMap);
  applyBorder(node, scene);
  applyRadius(node, scene);
  return node;
}

function setCommonGeometry(node, scene, parentRect) {
  const rect = scene.rect || { x: 0, y: 0, width: 1, height: 1 };
  node.x = Math.round((rect.x - (parentRect?.x || 0)) * 100) / 100;
  node.y = Math.round((rect.y - (parentRect?.y || 0)) * 100) / 100;
  if ("resize" in node) {
    node.resize(Math.max(1, rect.width || 1), Math.max(1, rect.height || 1));
  }
  if (typeof scene.style?.opacity === "number") {
    node.opacity = Math.max(0, Math.min(1, scene.style.opacity));
  }
}

function setNoWrapTextGeometry(node, scene, parentRect) {
  const rect = scene.rect || { x: 0, y: 0, width: 1, height: 1 };
  const originalWidth = Math.max(1, rect.width || 1);
  const width = noWrapTextWidth(scene);
  const extraWidth = Math.max(0, width - originalWidth);
  const align = scene.style?.textAlign || "LEFT";
  let x = rect.x - (parentRect?.x || 0);
  if (align === "RIGHT") {
    x -= extraWidth;
  } else if (align === "CENTER") {
    x -= extraWidth / 2;
  }
  node.x = Math.round(x * 100) / 100;
  node.y = Math.round((rect.y - (parentRect?.y || 0)) * 100) / 100;
  node.textAutoResize = "NONE";
  node.resize(width, Math.max(1, rect.height || 1));
  if (typeof scene.style?.opacity === "number") {
    node.opacity = Math.max(0, Math.min(1, scene.style.opacity));
  }
}

async function fillsForScene(scene, assetMap) {
  const asset = scene.assetId ? assetMap.get(scene.assetId) : null;
  if (asset?.dataUrl) {
    const bytes = dataUrlToBytes(asset.dataUrl);
    const image = figma.createImage(bytes);
    return [
      {
        type: "IMAGE",
        scaleMode: scene.style?.objectFit === "FIT" ? "FIT" : "FILL",
        imageHash: image.hash,
      },
    ];
  }
  return solidFill(scene.style?.background, scene.style?.backgroundOpacity);
}

function solidFill(hex, opacity) {
  if (!hex) return [];
  const paint = { type: "SOLID", color: hexToRgb(hex) };
  if (typeof opacity === "number") {
    paint.opacity = Math.max(0, Math.min(1, opacity));
  }
  return [paint];
}

function applyBorder(node, scene) {
  const width = scene.style?.borderWidth || 0;
  const color = scene.style?.borderColor;
  if (width > 0 && color) {
    node.strokes = solidFill(color, scene.style?.borderOpacity);
    node.strokeWeight = width;
    node.strokeAlign = "INSIDE";
  }
}

function applyRadius(node, scene) {
  const radius = scene.style?.borderRadius || 0;
  if ("cornerRadius" in node && radius > 0) {
    node.cornerRadius = radius;
  }
}

function applyShadow(node, scene) {
  const value = scene.style?.boxShadow;
  if (!value || value === "none") return;
  const match = /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px.*rgba?\(([^)]+)\)/.exec(value);
  if (!match) return;
  const [, x, y, blur, colorValue] = match;
  const colorParts = colorValue.split(",").map((part) => Number.parseFloat(part.trim()));
  const [r, g, b, a = 0.25] = colorParts;
  node.effects = [
    {
      type: "DROP_SHADOW",
      visible: true,
      color: { r: r / 255, g: g / 255, b: b / 255, a },
      offset: { x: Number(x), y: Number(y) },
      radius: Number(blur),
      spread: 0,
      blendMode: "NORMAL",
    },
  ];
}

async function loadBestFont(style) {
  const family = style.fontFamily || "Inter";
  const weight = Number(style.fontWeight || 400);
  const preferred = weight >= 700 ? "Bold" : weight >= 600 ? "Semi Bold" : weight >= 500 ? "Medium" : "Regular";
  const cacheKey = `${family}/${preferred}`;
  if (fontLoadCache.has(cacheKey)) {
    return fontLoadCache.get(cacheKey);
  }
  const candidates = [
    { family, style: preferred },
    { family, style: "Regular" },
    { family: "Inter", style: preferred },
    { family: "Inter", style: "Regular" },
  ];
  for (const candidate of candidates) {
    const candidateKey = `${candidate.family}/${candidate.style}`;
    try {
      if (!fontLoadCache.has(candidateKey)) {
        await figma.loadFontAsync(candidate);
        fontLoadCache.set(candidateKey, candidate);
      }
      fontLoadCache.set(cacheKey, fontLoadCache.get(candidateKey));
      return candidate;
    } catch {
      // Try the next available font.
    }
  }
  throw new Error(`Unable to load font for ${family}.`);
}

function shouldClip(scene) {
  if (scene.id === "viewport") return true;
  if (scene.style?.clipsContent) return true;
  const overflowX = scene.style?.overflowX;
  const overflowY = scene.style?.overflowY;
  return [overflowX, overflowY].some((value) => ["hidden", "clip", "auto", "scroll"].includes(value));
}

function fittedFontSize(scene) {
  const requested = Number(scene.style?.fontSize || 12);
  const height = Number(scene.rect?.height || 0);
  if (!height || !Number.isFinite(height)) return requested;
  const max = Math.max(1, height * 0.95);
  return Math.min(requested, max);
}

function fittedLineHeight(scene) {
  const fontSize = fittedFontSize(scene);
  const requested = Number(scene.style?.lineHeight || 0);
  const height = Number(scene.rect?.height || 0);
  if (requested > 0) {
    return height > 0 ? Math.min(requested, Math.max(fontSize, height * 1.1)) : requested;
  }
  return Math.max(fontSize, Math.round(fontSize * 1.2 * 100) / 100);
}

function noWrapTextWidth(scene) {
  const rectWidth = Math.max(1, Number(scene.rect?.width || 1));
  const fontSize = Math.max(1, Number(scene.style?.fontSize || 12));
  const text = scene.text || "";
  let estimated = 0;
  for (const char of Array.from(text)) {
    if (/\s/.test(char)) {
      estimated += fontSize * 0.35;
    } else if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) {
      estimated += fontSize;
    } else if (/[A-Z0-9]/.test(char)) {
      estimated += fontSize * 0.68;
    } else {
      estimated += fontSize * 0.58;
    }
  }
  const tolerance = Math.min(28, Math.max(8, fontSize * 1.5));
  return Math.ceil(Math.max(rectWidth, estimated) + tolerance);
}

function isNoWrapText(scene) {
  const style = scene.style || {};
  if (style.whiteSpace && style.whiteSpace !== "normal" && style.whiteSpace !== "pre-wrap") {
    return true;
  }
  if (style.textOverflow === "ellipsis") {
    return true;
  }
  const text = (scene.text || "").trim();
  const rectHeight = Number(scene.rect?.height || 0);
  const lineHeight = Number(style.lineHeight || 0) || Math.max(Number(style.fontSize || 12) * 1.2, 1);
  const hasExplicitLineBreak = /[\r\n]/.test(scene.text || "");
  if (text && !hasExplicitLineBreak && rectHeight > 0 && rectHeight <= lineHeight * 1.45) {
    return true;
  }
  return false;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => part + part)
          .join("")
      : normalized;
  const value = Number.parseInt(full.slice(0, 6), 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function countSceneNodes(scene) {
  return 1 + (scene.children || []).reduce((sum, child) => sum + countSceneNodes(child), 0);
}

function uniquePageName(base) {
  const existing = new Set(figma.root.children.map((page) => page.name));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}
