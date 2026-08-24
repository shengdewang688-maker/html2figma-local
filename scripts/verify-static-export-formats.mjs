import assert from "node:assert/strict";
import { chromium } from "playwright";
import path from "node:path";
import { startStaticServer, contentTypeForPath } from "../dist/src/companion/staticServer.js";

const root = path.resolve("examples/static-export-format");
const server = await startStaticServer(path.join(root, "index.xhtml"), 45283, root);
const browser = await chromium.launch();
const page = await browser.newPage();

try {
  const types = new Map();
  page.on("response", (response) => types.set(new URL(response.url()).pathname, response.headers()["content-type"]));
  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#loaded");
  await page.evaluate(async () => {
    await Promise.all([fetch("/site.webmanifest"), fetch("/assets/module.wasm")]);
  });

  assert.equal(await page.locator("#loaded").textContent(), "ES module 已加载");
  assert.match(types.get("/assets/app.mjs") || "", /^text\/javascript/);
  assert.match(types.get("/site.webmanifest") || "", /^application\/manifest\+json/);
  assert.match(types.get("/assets/module.wasm") || "", /^application\/wasm/);
  assert.equal(contentTypeForPath("font.woff2"), "font/woff2");
  assert.equal(contentTypeForPath("font.otf"), "font/otf");
  assert.equal(contentTypeForPath("poster.avif"), "image/avif");

  const deepLink = await page.goto(`${server.url}claims/123`, { waitUntil: "domcontentloaded" });
  assert.equal(deepLink?.status(), 200);
  assert.equal(await page.locator("h1").textContent(), "静态导出首页");
  console.log("static export formats verified");
} finally {
  await browser.close();
  await server.close();
}
