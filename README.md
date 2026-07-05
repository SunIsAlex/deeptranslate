# DeepTranslate 划词翻译（Chrome 插件 · MV3）

选中网页里的英文，按 **F2**，在选区旁弹出 tooltip，流式展示 DeepTranslate 返回的中英文释义 / 词根词缀 / 句法成分等分析。

## 安装（开发者模式加载）

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本 `extension/` 目录

## 使用

1. 左键拖选一段英文（单词 / 短语 / 句子均可）
2. 按 **F2**
3. tooltip 弹出，渲染：
   - **单词**：逐义项的中文释义与英文解释、词性、音标、词形变化、词根词缀、例句（目标词高亮）
   - **短语**：逐义项的中文释义与英文解释、用法、例句
   - **句子**：地道翻译、句法成分着色、语法点
4. 按 `Esc`、点击别处或滚动页面即可关闭

## 设置

点工具栏上的插件图标，可配置：

- **API 接口地址**：默认 `https://api.sunisalex.org/api/translate`。
  改成自建地址后，需在 `manifest.json` 的 `host_permissions` 里加上对应域名。
- **触发快捷键**：默认 `F2`，点输入框后按想用的键即可。

## 设计说明

- 请求放在 background service worker 里发起，绕开页面 CSP 与跨域限制（API 本身也带 `Access-Control-Allow-Origin: *`）。
- 扩展优先调用同目录下的 `/api/translate-stream`，通过 SSE 按译文、义项和例句逐步渲染；流接口不可用时自动回退 `/api/translate`。
- tooltip 用 Shadow DOM 隔离，不被页面样式污染。
- 渲染与高亮逻辑移植自网站的 `js/render.js` 和 `js/highlight.js`，输出风格与网页端一致。
- F2 在 content script 里直接监听 `keydown`（Chrome `commands` API 不允许无修饰键的单 F 键绑定）。
