import path from "node:path";

export function resolveFromCwd(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function toFileUrl(filePath: string): string {
  const absolute = resolveFromCwd(filePath);
  return new URL(`file://${absolute}`).href;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "state";
}
