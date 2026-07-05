# DeepTranslate · 英语翻译与语法分析

基于 DeepSeek 大模型、部署在 EdgeOne Pages 的英语学习工具。不只是翻译——输入英文给词根词缀、音标、词形变化、句法成分着色；输入中文给多个地道英文表达及用法区别。

在线体验：https://deeptranslate.sunisalex.org

## 特性

- **英译中**：自动识别输入是单词 / 短语动词 / 句子，分别给出对应分析
  - 单词：逐义项中文释义与英文解释、词性、音标、词根词缀拆解、不规则词形变化、例句
  - 短语动词：逐义项中文释义与英文解释、用法与可分性、例句（如 pay off）
  - 句子：地道翻译、句法成分着色高亮、语法点提示
- **中译英**：短语给 2-4 个备选表达及语域区别，句子给单一最地道译法
- **例句高亮**：目标词在例句中以 `[[ ]]` 标记，前端渲染为高亮，自动处理词形变化（paid off / making）
- **渐进输出**：英译中优先显示完整句子译文，并按完整例句逐条追加，避免逐 token 输出造成抖动
- **句法成分着色**：句子按主谓宾定状补等成分上色，鼠标悬停显示说明
- **KV 缓存**：重复查询毫秒级返回
- **可分享链接**：`/w/单词`、`/p/词组`、`/s/句子`、`/zh/中文`，复制即分享
- 无鉴权，即开即用

## 技术栈

- 前端：原生 HTML / CSS / JS，无框架
- 后端：EdgeOne Pages Edge Functions
- 缓存：EdgeOne KV
- 模型：DeepSeek（默认 deepseek-chat，可配置 deepseek-v4-flash 等）

## 目录结构

```
.
├── index.html                 # 主页
├── app.js                     # 前端入口控制器（提交流程、加载日志、路由恢复、复制）
├── js/
│   ├── dom.js                 # DOM 元素引用与通用构建工具
│   ├── highlight.js           # 例句 [[ ]] 高亮、句法成分着色
│   ├── render.js              # 各类型结果渲染（word/phrase/sentence/zh）
│   └── api.js                 # 翻译方向判断与后端请求
├── edgeone.json               # 路由 rewrite 配置
├── edge-functions/
    ├── _lib/
    │   └── translate-core.js  # 公共工具：CORS、调模型、缓存、清洗
    └── api/
        ├── translate.js       # 英译中接口
        ├── translate-cache.js # Node Function 与 Edge KV 之间的缓存桥接
        └── translate-zh.js    # 中译英接口
└── node-functions/
    └── api/
        └── translate-stream.js # 英译中 SSE 流式接口
```

## 本地开发

```bash
npm i -g edgeone
edgeone login
edgeone pages init        # 第一次在仓库里初始化
edgeone pages dev         # 本地起调试服务
```

如果 link 后本地读不到环境变量，删掉 `.edgeone/` 目录重试（CLI 的本地状态缓存偶尔会失效）。

## 环境变量

在 EdgeOne 控制台配置：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 密钥 | 必填 |
| `DEEPSEEK_MODEL` | 模型名 | deepseek-chat |
| `DEEPSEEK_API_URL` | API 地址 | https://api.deepseek.com/chat/completions |

注意：EdgeOne 把环境变量注入为**全局变量**，不在 `context.env` 上；KV 命名空间同理，绑定时变量名填 `KV`。

## 接口

### POST /api/translate（英译中）

```json
{ "text": "unbelievable", "mode": "auto" }
```

`mode` 可选 `auto`（默认）/ `word` / `sentence`。`auto` 时后端按词数和标点分流：单词走 word，明显句子走 sentence，2-4 词的模糊输入交给模型判断（含识别词组）。

返回 `type` 字段标明实际类型（word / phrase / sentence），前端据此渲染。单词和词组还返回结构化
`senses: [{ "zh": "中文义项", "definition": "English definition." }]`；原有 `translation`
字段继续保留，以兼容已有调用方。

### POST /api/translate-zh（中译英）

```json
{ "text": "再接再厉" }
```

返回 `direction: "zh2en"` + `translations` 数组（短语多条，句子单条）。

### POST /api/translate-stream（英译中流式）

请求体与 `/api/translate` 相同，响应类型为 `text/event-stream`。依次发送 `meta`、
`translation`、零到多个 `example`、`result` 和 `done` 事件。`translation` 与每个
`example` 都在字符串完整生成后发送；`result` 携带与非流式接口兼容的完整 JSON。

流式接口运行在 Node Function 中。由于 EdgeOne KV 仅支持 Edge Functions，它通过
`/api/translate-cache` 读取和回写原有缓存；缓存写入要求服务端密钥，浏览器不能写入。

## 路由

| 路径 | 行为 |
|---|---|
| `/` | 主页 |
| `/w/:word` | 自动查询单词 |
| `/p/:phrase` | 自动查询词组 |
| `/s/:sentence` | 自动查询句子 |
| `/zh/:中文` | 中译英 |
| `/api/translate` | 英译中接口 |
| `/api/translate-stream` | 英译中 SSE 流式接口 |
| `/api/translate-zh` | 中译英接口 |

所有页面路由需在 `edgeone.json` 里 rewrite 到 `index.html`——EdgeOne 默认不会把不存在的路径回退到首页，缺少 rewrite 会导致直接访问 / 刷新分享链接时 404。

## 已知问题与踩坑记录


- **环境变量**：拼错变量名不会报错，会静默回退默认值——改动后务必确认实际生效的值。
- **CLI 状态**：`edgeone pages link` 后本地环境变量可能失效，删 `.edgeone/` 目录可恢复。
- **AI 可靠性**：词源类信息易被模型编造，已移除 etymology 字段；词形拆解、成分分析偶有小误，仅供学习参考。
- **倒装句高亮**：含助动词分隔（do...hail）等不连续成分的句子，成分着色会降级为纯文本显示，成分说明列表仍正常。

## License

MIT
