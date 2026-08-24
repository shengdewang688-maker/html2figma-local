import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".xht": "application/xhtml+xml; charset=utf-8",
  ".shtml": "text/html; charset=utf-8",
  ".shtm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".apng": "image/apng",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".pdf": "application/pdf",
};

const htmlExtensions = new Set([".html", ".htm", ".xhtml", ".xht", ".shtml", ".shtm"]);

export type StaticServer = {
  url: string;
  close: () => Promise<void>;
};

export async function startStaticServer(
  inputFile: string,
  preferredPort = 4173,
  sourceRoot?: string,
  transformHtml?: (html: string) => string,
): Promise<StaticServer> {
  const root = path.resolve(sourceRoot ?? path.dirname(inputFile));
  const entryFile = path.resolve(inputFile);
  if (!isInside(root, entryFile)) {
    throw new Error(`Input file must be inside source root: ${inputFile}`);
  }
  const entryRelative = toServerPath(path.relative(root, entryFile));
  const server = http.createServer(async (request, response) => {
    try {
      const rawUrl = new URL(request.url || "/", `http://${request.headers.host}`);
      const pathname = decodeURIComponent(rawUrl.pathname);
      const relative = pathname === "/" ? entryRelative : toServerPath(pathname.replace(/^\/+/, ""));
      const target = path.resolve(root, relative);
      if (!isInside(root, target)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      const filePath = await resolveStaticPath(target, entryFile, request, pathname);
      await sendStaticFile(response, filePath, request.method, transformHtml);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  const port = await listen(server, preferredPort);
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
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
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryPort(preferredPort);
  });
}

async function findDirectoryIndex(directory: string): Promise<string> {
  for (const indexFile of ["index.html", "index.htm", "index.xhtml", "index.xht", "index.shtml", "index.shtm"]) {
    const target = path.join(directory, indexFile);
    try {
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        return target;
      }
    } catch {
      // Try the next conventional index filename.
    }
  }
  throw new Error(`No index.html found in ${directory}`);
}

async function resolveStaticPath(
  requested: string,
  entryFile: string,
  request: http.IncomingMessage,
  pathname: string,
): Promise<string> {
  try {
    const stat = await fs.stat(requested);
    return stat.isDirectory() ? findDirectoryIndex(requested) : requested;
  } catch (error) {
    if (shouldServeSpaEntry(request, pathname)) return entryFile;
    throw error;
  }
}

async function sendStaticFile(
  response: http.ServerResponse,
  filePath: string,
  method: string | undefined,
  transformHtml?: (html: string) => string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": contentTypeForPath(filePath),
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  if (transformHtml && isHtmlDocumentPath(filePath)) {
    response.end(transformHtml(await fs.readFile(filePath, "utf8")));
    return;
  }
  createReadStream(filePath).pipe(response);
}

function shouldServeSpaEntry(request: http.IncomingMessage, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (path.extname(pathname)) return false;
  const accept = request.headers.accept || "";
  return request.headers["sec-fetch-dest"] === "document" || accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

export function isHtmlDocumentPath(filePath: string): boolean {
  return htmlExtensions.has(path.extname(filePath).toLowerCase());
}

export function contentTypeForPath(filePath: string): string {
  return mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function toServerPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
