import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Asset } from "../types.js";

const imageMimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export async function resolveAsset(asset: Asset, pageUrl: string): Promise<Asset> {
  if (asset.dataUrl || asset.kind === "svg") {
    return asset;
  }
  try {
    const url = new URL(asset.source, pageUrl);
    if (url.protocol === "data:") {
      return { ...asset, dataUrl: url.href };
    }
    const bytes = url.protocol === "file:" ? await fs.readFile(fileURLToPath(url)) : await fetchBytes(url.href);
    const mimeType = asset.mimeType || inferMimeType(url.pathname);
    return {
      ...asset,
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
    };
  } catch (error) {
    return {
      ...asset,
      warnings: [...asset.warnings, `Failed to load asset ${asset.source}: ${formatError(error)}`],
    };
  }
}

export function dataUrlFromBytes(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function inferMimeType(sourcePath: string): string {
  return imageMimeByExtension[path.extname(sourcePath).toLowerCase()] ?? "image/png";
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
