import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

export type SessionServer = {
  url: string;
  close: () => Promise<void>;
};

export type SessionServerOptions = {
  allowPortFallback?: boolean;
};

export async function startSessionServer(
  outDir: string,
  preferredPort = 4777,
  options: SessionServerOptions = {},
): Promise<SessionServer> {
  const server = http.createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    try {
      if (url.pathname === "/session/latest" || url.pathname === "/bundle.json") {
        await sendJson(response, path.join(outDir, "bundle.json"));
        return;
      }
      if (url.pathname === "/report.json") {
        await sendJson(response, path.join(outDir, "report.json"));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("html2figma session server. Use /session/latest.");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  const port = await listen(server, preferredPort, options.allowPortFallback === true);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function sendJson(response: http.ServerResponse, filePath: string): Promise<void> {
  const body = await fs.readFile(filePath, "utf8");
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function listen(server: http.Server, preferredPort: number, allowPortFallback: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && allowPortFallback) {
          tryPort(port + 1);
        } else if (error.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${preferredPort} is already in use. Close the old html2figma window or process, then start again. The Figma plugin can only access the configured localhost:${preferredPort} session URL.`,
            ),
          );
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
