import { Asset, SceneNode, Viewport } from "../types.js";
import { shortHash } from "../utils/hash.js";

export type ExtractedDom = {
  root: SceneNode;
  assets: Asset[];
  domSignature: string;
  warnings: string[];
  rasterIds: string[];
};

export function buildDomSignature(root: SceneNode): string {
  const compact = JSON.stringify(pruneNode(root));
  return shortHash(compact);
}

export function buildPageSignature(root: SceneNode): string {
  const compact = JSON.stringify(prunePageNode(root));
  return shortHash(compact);
}

function pruneNode(node: SceneNode): unknown {
  return {
    k: node.kind,
    n: node.name,
    t: node.text,
    r: [
      Math.round(node.rect.x),
      Math.round(node.rect.y),
      Math.round(node.rect.width),
      Math.round(node.rect.height),
    ],
    a: node.assetId,
    c: node.children.map(pruneNode),
  };
}

function prunePageNode(node: SceneNode): unknown {
  return {
    k: node.kind,
    tag: node.tag,
    n: normalizePageText(node.name),
    t: normalizePageText(node.text),
    r: [
      Math.round(node.rect.x / 8) * 8,
      Math.round(node.rect.y / 8) * 8,
      Math.round(node.rect.width / 8) * 8,
      Math.round(node.rect.height / 8) * 8,
    ],
    c: node.children.map(prunePageNode),
  };
}

function normalizePageText(value?: string): string | undefined {
  if (!value) return value;
  const normalized = value
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, "<date>")
    .replace(/\d{2,4}[-/]\d{1,2}[-/]\d{1,2}/g, "<date>")
    .replace(/[A-Z]{1,8}\d{2,}/g, "<code>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 80);
}

export function browserExtractor(viewport: Viewport): ExtractedDom {
  const assets: Asset[] = [];
  const warnings: string[] = [];
  const rasterIds: string[] = [];
  let idCounter = 0;
  let sourceOrderCounter = 0;

  const bodyBackground = parseColor(getComputedStyle(document.body).backgroundColor);
  const documentWidth = Math.max(viewport.width, document.documentElement.scrollWidth, document.body.scrollWidth);
  const documentHeight = Math.max(viewport.height, document.documentElement.scrollHeight, document.body.scrollHeight);
  const rootRect = { x: 0, y: 0, width: documentWidth, height: documentHeight };
  const root: SceneNode = {
    id: "viewport",
    kind: "FRAME",
    name: `desktop / ${documentWidth}x${documentHeight}`,
    tag: "viewport",
    rect: rootRect,
    style: {
      background: bodyBackground?.hex || "#ffffff",
      backgroundOpacity: bodyBackground?.opacity ?? 1,
      layoutMode: "NONE",
      overflowX: "hidden",
      overflowY: "hidden",
      clipsContent: true,
    },
    children: [],
    editable: true,
    warnings: [],
  };

  assignCaptureIds(document.documentElement);

  const bodyChildren = Array.from(document.body.childNodes)
    .map((child) => nodeToScene(child, null))
    .filter(Boolean) as SceneNode[];
  root.children.push(...sortByPaintOrder(bodyChildren));

  const domSignature = root.children
    .map((child) => `${child.kind}:${child.name}:${child.text ?? ""}:${roundRect(child.rect)}`)
    .join("|");

  return { root, assets, warnings, rasterIds, domSignature };

  function assignCaptureIds(rootElement: Element) {
    const all = rootElement.querySelectorAll("*");
    all.forEach((element) => {
      if (!element.getAttribute("data-html2figma-id")) {
        element.setAttribute("data-html2figma-id", nextId(element.tagName.toLowerCase()));
      }
    });
  }

  function nodeToScene(node: Node, inheritedStyle: CSSStyleDeclaration | null): SceneNode | null {
    if (node.nodeType === Node.TEXT_NODE) {
      return textNodeToScene(node as Text, inheritedStyle);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }
    return elementToScene(node as HTMLElement);
  }

  function textNodeToScene(textNode: Text, inheritedStyle: CSSStyleDeclaration | null): SceneNode | null {
    const text = textNode.textContent?.replace(/\s+/g, " ").trim();
    if (!text || !inheritedStyle) {
      return null;
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    range.detach();
    if (!isUsableRect(rect)) {
      return null;
    }
    return {
      id: nextId("text"),
      kind: "TEXT",
      name: text.slice(0, 48),
      rect: normalizeRect(rect),
      text,
      style: {
        ...extractTextStyle(inheritedStyle),
        overflowX: "hidden",
        overflowY: "hidden",
        clipsContent: true,
      },
      children: [],
      editable: true,
      warnings: [],
      sourceOrder: nextSourceOrder(),
    };
  }

  function elementToScene(element: HTMLElement): SceneNode | null {
    const tag = element.tagName.toLowerCase();
    if (["script", "style", "template", "link", "meta", "noscript"].includes(tag)) {
      return null;
    }

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!isVisible(element, style, rect)) {
      return null;
    }

    const captureId = element.getAttribute("data-html2figma-id") || nextId(tag);
    const base = createBaseNode(element, style, rect, captureId);

    if (tag === "svg") {
      if (svgContainsForeignObject(element)) {
        rasterIds.push(captureId);
        return {
          ...base,
          kind: "RASTER_FALLBACK",
          name: nameForElement(element, "svg foreignObject fallback"),
          assetId: captureId,
          editable: false,
          warnings: ["SVG with foreignObject is captured as raster fallback because Figma cannot import its HTML labels."],
          children: [],
        };
      }
      return {
        ...base,
        kind: "VECTOR",
        name: nameForElement(element, "svg"),
        svg: new XMLSerializer().serializeToString(element),
        children: [],
      };
    }

    if (tag === "img") {
      const image = element as HTMLImageElement;
      const source = image.currentSrc || image.src;
      if (source) {
        assets.push({
          id: captureId,
          kind: "image",
          source,
          mimeType: "",
          warnings: [],
        });
      }
      return {
        ...base,
        kind: "IMAGE",
        name: nameForElement(element, "image"),
        assetId: captureId,
        style: {
          ...base.style,
          objectFit: objectFit(style.objectFit),
        },
        children: [],
      };
    }

    if (tag === "canvas" || tag === "video") {
      rasterIds.push(captureId);
      return {
        ...base,
        kind: "RASTER_FALLBACK",
        name: nameForElement(element, `${tag} fallback`),
        assetId: captureId,
        editable: false,
        warnings: [`${tag} is captured as raster fallback.`],
        children: [],
      };
    }

    const backgroundAssetId = captureBackgroundImage(style, captureId);
    const children = Array.from(element.childNodes)
      .map((child) => nodeToScene(child, style))
      .filter(Boolean) as SceneNode[];

    return {
      ...base,
      kind: "FRAME",
      name: nameForElement(element, tag),
      assetId: backgroundAssetId,
      children: sortByPaintOrder(children),
    };
  }

  function createBaseNode(
    element: HTMLElement,
    style: CSSStyleDeclaration,
    rect: DOMRect,
    id: string,
  ): SceneNode {
    return {
      id,
      kind: "FRAME",
      name: nameForElement(element, element.tagName.toLowerCase()),
      tag: element.tagName.toLowerCase(),
      rect: normalizeRect(rect),
      zIndex: Number.isFinite(Number(style.zIndex)) ? Number(style.zIndex) : undefined,
      sourceOrder: nextSourceOrder(),
      style: extractFrameStyle(style),
      children: [],
      editable: true,
      warnings: complexStyleWarnings(style),
    };
  }

  function captureBackgroundImage(style: CSSStyleDeclaration, id: string): string | undefined {
    const match = /url\(["']?(.+?)["']?\)/.exec(style.backgroundImage);
    if (!match) {
      return undefined;
    }
    assets.push({
      id,
      kind: "image",
      source: match[1],
      mimeType: "",
      warnings: [],
    });
    return id;
  }

  function extractFrameStyle(style: CSSStyleDeclaration) {
    const display = style.display;
    const flexDirection = style.flexDirection;
    const layoutMode: "HORIZONTAL" | "VERTICAL" | "NONE" =
      display === "flex" || display === "inline-flex"
        ? flexDirection.startsWith("row")
          ? "HORIZONTAL"
          : "VERTICAL"
        : "NONE";
    const background = parseColor(style.backgroundColor);
    const border = parseColor(style.borderColor);
    return {
      display,
      layoutMode,
      gap: px(style.gap || style.columnGap || "0"),
      padding: {
        top: px(style.paddingTop),
        right: px(style.paddingRight),
        bottom: px(style.paddingBottom),
        left: px(style.paddingLeft),
      },
      background: background?.hex,
      backgroundOpacity: background?.opacity,
      opacity: Number(style.opacity || 1),
      borderColor: border?.hex,
      borderOpacity: border?.opacity,
      borderWidth: px(style.borderTopWidth),
      borderRadius: px(style.borderTopLeftRadius),
      boxShadow: style.boxShadow !== "none" ? style.boxShadow : undefined,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      clipsContent: clipsContent(style),
    };
  }

  function extractTextStyle(style: CSSStyleDeclaration) {
    const color = parseColor(style.color);
    return {
      color: color?.hex || "#000000",
      colorOpacity: color?.opacity ?? 1,
      fontFamily: firstFontFamily(style.fontFamily),
      fontSize: px(style.fontSize),
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight === "normal" ? undefined : px(style.lineHeight),
      letterSpacing: style.letterSpacing === "normal" ? 0 : px(style.letterSpacing),
      textAlign: textAlign(style.textAlign),
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      overflowWrap: style.overflowWrap,
      textOverflow: style.textOverflow,
    };
  }

  function clipsContent(style: CSSStyleDeclaration): boolean {
    const values = [style.overflowX, style.overflowY, style.overflow];
    return values.some((value) => ["hidden", "clip", "auto", "scroll"].includes(value));
  }

  function objectFit(value: string): "FILL" | "FIT" | "CROP" {
    if (value === "contain" || value === "scale-down") return "FIT";
    if (value === "cover") return "FILL";
    return "FILL";
  }

  function svgContainsForeignObject(element: Element): boolean {
    return Array.from(element.querySelectorAll("*")).some(
      (child) => child.localName.toLowerCase() === "foreignobject",
    );
  }

  function sortByPaintOrder(nodes: SceneNode[]): SceneNode[] {
    return [...nodes].sort((a, b) => {
      const az = a.zIndex ?? 0;
      const bz = b.zIndex ?? 0;
      if (az !== bz) return az - bz;
      return (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0);
    });
  }

  function complexStyleWarnings(style: CSSStyleDeclaration): string[] {
    const result: string[] = [];
    if (style.filter && style.filter !== "none") result.push(`CSS filter not fully editable: ${style.filter}`);
    if (style.backdropFilter && style.backdropFilter !== "none") {
      result.push(`CSS backdrop-filter not fully editable: ${style.backdropFilter}`);
    }
    if (style.mixBlendMode && style.mixBlendMode !== "normal") {
      result.push(`CSS blend mode may differ in Figma: ${style.mixBlendMode}`);
    }
    return result;
  }

  function isVisible(element: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (!isUsableRect(rect)) return false;
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    // `aria-hidden` describes the accessibility tree, not visual rendering.  A
    // number of UI kits leave it at "true" while revealing a sheet/modal only
    // through a CSS class (for example `.sheet.show`).  The exporter must follow
    // the rendered page so those visible overlays are not silently discarded.
    return true;
  }

  function isUsableRect(rect: DOMRect): boolean {
    return rect.width >= 1 && rect.height >= 1 && rect.bottom >= 0 && rect.right >= 0;
  }

  function normalizeRect(rect: DOMRect) {
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }

  function roundRect(rect: { x: number; y: number; width: number; height: number }): string {
    return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
  }

  function parseColor(value: string): { hex: string; opacity: number } | undefined {
    const rgba = /rgba?\(([^)]+)\)/.exec(value);
    if (!rgba) return undefined;
    const raw = rgba[1].trim();
    const parts = raw.includes(",")
      ? raw.split(",").map((part) => part.trim())
      : raw.split(/\s+/).filter((part) => part !== "/");
    const slashIndex = parts.indexOf("/");
    const alphaPart = slashIndex >= 0 ? parts[slashIndex + 1] : parts[3];
    const alpha = alphaPart === undefined ? 1 : parseAlpha(alphaPart);
    if (alpha === 0) return undefined;
    const [r, g, b] = parts.slice(0, 3).map((part) => parseChannel(part));
    if ([r, g, b].some((part) => Number.isNaN(part))) return undefined;
    return {
      hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
      opacity: Math.max(0, Math.min(1, alpha)),
    };
  }

  function parseChannel(value: string): number {
    if (value.endsWith("%")) {
      return Math.round((Number.parseFloat(value) / 100) * 255);
    }
    return Math.round(Number.parseFloat(value));
  }

  function parseAlpha(value: string): number {
    if (value.endsWith("%")) {
      return Number.parseFloat(value) / 100;
    }
    return Number.parseFloat(value);
  }

  function toHex(value: number): string {
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  }

  function px(value: string): number {
    const parsed = Number.parseFloat(value || "0");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function firstFontFamily(value: string): string {
    return value.split(",")[0]?.replace(/^["']|["']$/g, "").trim() || "Inter";
  }

  function textAlign(value: string): "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" {
    if (value === "center") return "CENTER";
    if (value === "right" || value === "end") return "RIGHT";
    if (value === "justify") return "JUSTIFIED";
    return "LEFT";
  }

  function nameForElement(element: Element, fallback: string): string {
    const explicit =
      element.getAttribute("data-figma-name") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.id ||
      element.getAttribute("role");
    return (explicit || fallback).slice(0, 80);
  }

  function nextId(prefix: string): string {
    idCounter += 1;
    return `h2f-${prefix}-${idCounter}`;
  }

  function nextSourceOrder(): number {
    sourceOrderCounter += 1;
    return sourceOrderCounter;
  }
}
