const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".html2figma",
  "node_modules",
  "coverage",
]);

const htmlEntryPattern = /\.(?:html?|xhtml|xht|shtml?|shtm)$/i;
const sourceOnlyFrontendPattern = /\.(?:vue|svelte|astro|jsx|tsx|mdx|pug|jade|hbs|handlebars)$/i;
const staticExportRootPattern =
  /(^|\/)(?:(?:dist|build|out|public|wwwroot)|\.output\/public|\.vercel\/output\/static)\/index\.(?:html?|xhtml|xht|shtml?|shtm)$/i;

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function isIgnoredProjectPath(filePath: string): boolean {
  const parts = normalize(filePath).split("/");
  return parts.some((part, index) => {
    if (isStaticDeploymentDirectory(parts, index)) return false;
    return part.startsWith(".") || ignoredDirectories.has(part);
  });
}

export function filterUploadFiles(files: string[]): string[] {
  return files.filter((file) => !isIgnoredProjectPath(file));
}

export function orderHtmlFiles(entryPath: string | undefined, files: string[]): string[] {
  const htmlFiles = filterUploadFiles(files).filter(isHtmlEntryFile);
  if (!htmlFiles.length) {
    const sourceFiles = filterUploadFiles(files).filter((file) => sourceOnlyFrontendPattern.test(file));
    if (sourceFiles.length) {
      throw new Error(
        "没有可直接运行的 HTML 入口。检测到 Vue/React/Svelte/Astro 等源码文件，请先构建项目，再上传静态导出目录（如 dist、build、out、public、wwwroot、.output/public 或 .vercel/output/static）。",
      );
    }
    throw new Error("没有找到可运行的 HTML 入口。支持 .html、.htm、.xhtml、.xht、.shtml 和 .shtm。");
  }
  const preferred =
    entryPath && htmlFiles.includes(entryPath)
      ? entryPath
      : htmlFiles.find((file) => staticExportRootPattern.test(file)) ??
        htmlFiles.find((file) => /(^|\/)index\.(?:html?|xhtml|xht|shtml?|shtm)$/i.test(file)) ??
        htmlFiles[0];
  return [preferred, ...htmlFiles.filter((file) => file !== preferred)];
}

export function isHtmlEntryFile(filePath: string): boolean {
  return htmlEntryPattern.test(normalize(filePath));
}

function isStaticDeploymentDirectory(parts: string[], index: number): boolean {
  return (
    (parts[index] === ".output" && parts[index + 1] === "public") ||
    (parts[index] === ".vercel" && parts[index + 1] === "output" && parts[index + 2] === "static")
  );
}
