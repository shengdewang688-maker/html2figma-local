# HTML 转可编辑 Figma 工具迁移说明

这个压缩包只包含在新电脑运行工具所需的源码、Figma 插件、启动脚本、配置示例和说明文档。

不包含这些临时内容：

- `node_modules/`
- `.html2figma*/`
- `outputs/`
- `dist/`
- `.git/`

## 新电脑使用步骤

1. 安装 Node.js 20 或更新版本。
2. 解压本压缩包。
3. macOS 双击 `scripts/start-html2figma-mac.command`。
4. Windows 双击 `scripts/start-html2figma-windows.bat`。

启动脚本第一次运行时会自动执行：

```bash
npm install
npx playwright install chromium
```

启动成功后打开：

```text
http://127.0.0.1:4888
```

把 HTML/CSS 项目文件夹拖进去生成 bundle，然后在 Figma 里加载：

```text
plugin/manifest.json
```

运行 `HTML2Figma Local Companion` 插件，它会读取：

```text
http://localhost:4777/session/latest
```

## 验证命令

如果想检查工具是否正常：

```bash
npm run check
npm run fixture
npm run verify:plugin
```

`npm run verify:plugin` 会用当前 `.html2figma/bundle.json` 模拟 Figma 插件导入，确认 bundle 能被插件创建成 frame。
