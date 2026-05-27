# 英语翻译与语法分析

基于 DeepSeek 大模型的英语学习工具，部署在 EdgeOne Pages。输入单词返回构词分解、音标、例句；输入句子返回成分高亮和语法点分析。

## 特性

- 单词模式：词根词缀拆解、词性、音标、例句
- 句子模式：成分着色、句法结构、语法点提示
- 自动识别输入是单词还是句子
- KV 缓存，重复查询毫秒级返回
- 路径路由 `/w/:word` 和 `/s/:sentence`，可分享链接
- 无鉴权，纯静态前端 + Edge Function 后端

## 技术栈

- 前端：原生 HTML/CSS/JS，无框架
- 后端：EdgeOne Pages Edge Functions
- 缓存：EdgeOne KV
- 模型：DeepSeek（默认 `deepseek-chat`）

## 目录结构

```
.
├── index.html              # 主页
├── app.js                  # 前端逻辑
├── edgeone.json            # 路由配置
├── edge-functions/
│   └── api/
│       └── translate.js    # 翻译接口
```

## 本地开发

```bash
npm install
edgeone login
edgeone pages link           # 关联远程项目
edgeone pages dev            # 本地启动
```

访问 `http://localhost:8088`。

如果 link 后环境变量读不到，删掉本地 `.edgeone/` 目录重试。

## 环境变量

在 EdgeOne 控制台配置：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 必填 |
| `DEEPSEEK_MODEL` | 模型名 | `deepseek-chat` |
| `DEEPSEEK_API_URL` | API 地址 | `https://api.deepseek.com/chat/completions` |

注意 EdgeOne 把环境变量注入为**全局变量**，不在 `context.env` 上。代码里用 `typeof DEEPSEEK_API_KEY !== "undefined" ? DEEPSEEK_API_KEY : ""` 访问。

## KV 绑定

控制台创建 KV 命名空间，绑定时变量名填 `KV`（与代码里的 `KV.get/put` 对应）。

## 接口

`POST /api/translate`

请求：
```json
{
  "text": "unbelievable",
  "mode": "auto"
}
```

`mode` 可选值：`auto`（默认）、`word`、`sentence`。

单词响应：
```json
{
  "type": "word",
  "input": "unbelievable",
  "translation": "难以置信的",
  "analysis": {
    "pos": "adj.",
    "phonetic": "/ˌʌnbɪˈliːvəbl/",
    "morphology": [
      { "part": "un-", "kind": "prefix", "meaning": "不" },
      { "part": "believ", "kind": "root", "meaning": "相信" },
      { "part": "-able", "kind": "suffix", "meaning": "可…的" }
    ],
    "examples": ["..."]
  },
  "_cached": false
}
```

句子响应：
```json
{
  "type": "sentence",
  "input": "The old man the ship.",
  "translation": "老人们驾驶船只。",
  "analysis": {
    "structure": "主语 + 谓语 + 宾语",
    "components": [
      { "role": "主语", "text": "The old", "note": "..." },
      { "role": "谓语", "text": "man", "note": "..." },
      { "role": "宾语", "text": "the ship", "note": "..." }
    ],
    "grammar_points": ["..."]
  },
  "_cached": false
}
```

错误响应：
```json
{ "error": "english_required", "message": "请输入英文" }
```

## 生产构建

```bash
node build.js
```

压缩根目录 `*.html` `*.css` `*.js`，输出到 `dist/`，edge-functions 直接复制。

控制台部署时把构建命令设为 `node build.js`，输出目录设为 `dist`。

## 缓存预热

```bash
# 词表每行一个单词
API_URL=https://你的域名/api/translate node warmup.js wordlist.txt
```

## 路由

| 路径 | 行为 |
|---|---|
| `/` | 主页 |
| `/w/:word` | 加载主页并自动查询单词 |
| `/s/:sentence` | 加载主页并自动查询句子 |
| `/api/translate` | 翻译接口 |

## 已知问题

- DeepSeek 偶尔在词源字段编造历史细节，所以默认关闭了 etymology 字段输出
- EdgeOne CLI link 后本地环境变量可能失效，删 `.edgeone/` 目录可恢复
- 单一模型依赖，DeepSeek 服务不可用时整站失能

## License

MIT
