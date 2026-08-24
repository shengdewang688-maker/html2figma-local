import assert from "node:assert/strict";
import { filterUploadFiles, isHtmlEntryFile, orderHtmlFiles } from "../dist/src/app/uploadFilter.js";

const files = [
  "claim-audit-mobile.html",
  "node_modules/playwright-core/lib/vite/htmlReport/index.html",
  ".git/index.html",
  "assets/icon.svg",
  "pages/other.html",
  "dist/index.xhtml",
  "dist/assets/app.mjs",
  ".output/public/index.shtm",
  ".vercel/output/static/index.xht",
];

assert.deepEqual(filterUploadFiles(files), [
  "claim-audit-mobile.html",
  "assets/icon.svg",
  "pages/other.html",
  "dist/index.xhtml",
  "dist/assets/app.mjs",
  ".output/public/index.shtm",
  ".vercel/output/static/index.xht",
]);
assert.deepEqual(orderHtmlFiles("pages/other.html", filterUploadFiles(files)), [
  "pages/other.html",
  "claim-audit-mobile.html",
  "dist/index.xhtml",
  ".output/public/index.shtm",
  ".vercel/output/static/index.xht",
]);
assert.equal(isHtmlEntryFile("dist/index.xhtml"), true);
assert.equal(isHtmlEntryFile("src/App.vue"), false);
assert.equal(orderHtmlFiles(undefined, filterUploadFiles(files))[0], "dist/index.xhtml");
assert.equal(orderHtmlFiles(undefined, ["src/index.html", ".output/public/index.shtm"])[0], ".output/public/index.shtm");
assert.equal(orderHtmlFiles(undefined, ["src/index.html", ".vercel/output/static/index.xht"])[0], ".vercel/output/static/index.xht");
console.log("upload filter verified");
