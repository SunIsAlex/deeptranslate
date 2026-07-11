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
- **可选分析与模型**：可关闭英文句子的语法分析，并在 DeepSeek V4 Flash / Pro 之间切换
- **上下文追问**：基于当前翻译结果继续询问用法、语法和自然度，AI 以用户提问所用语言流式回答
- **英美音跟读**：词条、译文和例句可用浏览器原生语音合成播放美式或英式发音
- **练习模式**：基于当前翻译一键生成填空、中译英或选择题；题目历史按查询本地保存，避免重复，并在完成练习后逐级提高难度
- **本地生词本**：可把当前查询的单词/短语保存到浏览器本地，并联想添加近义词、反义词、词族和相关短语
- **Markdown 回答**：追问回答复用内置 marked.js 增量渲染，并通过 HTML 白名单过滤危险内容
- **句法成分着色**：句子按主谓宾定状补等成分上色，鼠标悬停显示说明
- **KV 缓存**：重复查询毫秒级返回
- **可分享链接**：`/w/单词`、`/p/词组`、`/s/句子`、`/zh/中文`，复制即分享
- 无鉴权，即开即用

## 技术栈

- 前端：原生 HTML / CSS / JS，无框架
- 后端：EdgeOne Pages Edge Functions + Node Functions
- 缓存：EdgeOne KV
- 模型：DeepSeek V4 Flash / Pro（默认 deepseek-v4-flash）

## 目录结构

```
.
├── index.html                 # 主页
├── app.js                     # 前端入口控制器（提交流程、加载日志、路由恢复、复制）
├── js/
│   ├── dom.js                 # DOM 元素引用与通用构建工具
│   ├── highlight.js           # 例句 [[ ]] 高亮、句法成分着色
│   ├── render.js              # 各类型结果渲染（word/phrase/sentence/zh）
│   ├── speech.js              # 浏览器原生英美音朗读
│   ├── vocabulary.js          # 本地生词本读写与去重
│   └── api.js                 # 翻译方向判断与后端请求
├── edgeone.json               # 路由 rewrite 配置
├── edge-functions/
    ├── _lib/
    │   └── translate-core.js  # 公共工具：CORS、调模型、缓存、清洗
    └── api/
        ├── translate.js       # 英译中接口
        ├── related-words.js   # 结构化联想词接口
        ├── practice.js        # 结构化练习题接口
        ├── translate-cache.js # Node Function 与 Edge KV 之间的缓存桥接
        └── translate-zh.js    # 中译英接口
└── node-functions/
    └── api/
        ├── translate-stream.js # 英译中 SSE 流式接口
        └── follow-up.js        # 基于翻译上下文的流式追问接口
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
| `DEEPSEEK_MODEL` | 未指定前端模型时的默认模型 | deepseek-v4-flash |
| `DEEPSEEK_API_URL` | API 地址 | https://api.deepseek.com/chat/completions |

注意：EdgeOne 把环境变量注入为**全局变量**，不在 `context.env` 上；KV 命名空间同理，绑定时变量名填 `KV`。

## 接口

### POST /api/translate（英译中）

```json
{
  "text": "unbelievable",
  "mode": "auto",
  "grammarAnalysis": true,
  "model": "deepseek-v4-flash"
}
```

`mode` 可选 `auto`（默认）/ `word` / `sentence`。`auto` 时后端按词数和标点分流：单词走 word，明显句子走 sentence，2-4 词的模糊输入交给模型判断（含识别词组）。

`grammarAnalysis` 默认为 `true`，仅影响英文句子；设为 `false` 时句子只返回译文。
`model` 仅接受 `deepseek-v4-flash` 或 `deepseek-v4-pro`，缺省或非法值回退到服务端默认模型。

返回 `type` 字段标明实际类型（word / phrase / sentence），前端据此渲染。单词和词组还返回结构化
`senses: [{ "zh": "中文义项", "pos": "该义项词性", "phonetic": "/该义项读音/", "definition": "English definition." }]`；原有 `translation`
字段继续保留，以兼容已有调用方。

### POST /api/translate-zh（中译英）

```json
{ "text": "再接再厉", "model": "deepseek-v4-flash" }
```

返回 `direction: "zh2en"` + `translations` 数组（短语多条，句子单条）。

### POST /api/translate-stream（英译中流式）

请求体与 `/api/translate` 相同，响应类型为 `text/event-stream`。依次发送 `meta`、
`translation`、可选的 `senses`、零到多个 `example`、`result` 和 `done` 事件。
单词和词组会先发送完整义项及英文解释，再逐条发送例句；`result` 携带与非流式接口兼容的完整 JSON。

流式接口运行在 Node Function 中。由于 EdgeOne KV 仅支持 Edge Functions，它通过
`/api/translate-cache` 读取和回写原有缓存；缓存写入要求服务端密钥，浏览器不能写入。

### POST /api/follow-up（上下文追问）

```json
{
  "question": "这里可以用 pay off 吗？",
  "context": { "input": "……", "translation": "……", "analysis": {} },
  "history": [],
  "model": "deepseek-v4-flash"
}
```

响应类型为 `text/event-stream`，依次发送 `meta`、多个 `delta`、`result` 和 `done`。
回答会参考当前完整翻译结果，并使用与当前问题相同的语言。前端开始新翻译时会清空追问记录。

### POST /api/related-words（生词本联想）

```json
{
  "input": "happy",
  "context": { "input": "happy", "translation": "快乐的" },
  "model": "deepseek-v4-flash"
}
```

返回结构化 `items` 数组，供前端一键加入本地生词本。`relation` 可能为
`synonym` / `antonym` / `word_family` / `phrase` / `related`。

### POST /api/practice（练习模式）

```json
{
  "kind": "cloze",
  "context": { "input": "happy", "translation": "快乐的" },
  "model": "deepseek-v4-flash"
}
```

`kind` 可选 `auto` / `cloze` / `translate` / `choice`。可选 `history` 传入最近练习题记录，`difficulty` 传入 1-4 的目标难度。接口基于当前完整翻译结果返回一题结构化练习，包含题干、可选项（仅选择题）、参考答案、可接受答案与中文解析。

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
| `/api/follow-up` | 基于当前翻译结果的流式追问接口 |
| `/api/related-words` | 生词本联想词接口 |
| `/api/practice` | 结构化练习题接口 |
| `/api/translate-zh` | 中译英接口 |

所有页面路由需在 `edgeone.json` 里 rewrite 到 `index.html`——EdgeOne 默认不会把不存在的路径回退到首页，缺少 rewrite 会导致直接访问 / 刷新分享链接时 404。

## 已知问题与踩坑记录


- **环境变量**：拼错变量名不会报错，会静默回退默认值——改动后务必确认实际生效的值。
- **CLI 状态**：`edgeone pages link` 后本地环境变量可能失效，删 `.edgeone/` 目录可恢复。
- **AI 可靠性**：词源类信息易被模型编造，已移除 etymology 字段；词形拆解、成分分析偶有小误，仅供学习参考。
- **倒装句高亮**：含助动词分隔（do...hail）等不连续成分的句子，成分着色会降级为纯文本显示，成分说明列表仍正常。

## License

MIT
