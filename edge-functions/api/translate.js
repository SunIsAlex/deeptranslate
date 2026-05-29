// POST /api/translate
// 依赖 EdgeOne Pages KV：变量名假设为 KV（在控制台绑定时填的名字）
// 注意：EdgeOne 的 KV 是全局变量，不在 env 上
export async function onRequestPost(context) {
  try {
    return await handleRequest(context);
  } catch (e) {
    console.error("unhandled:", e);
    return new Response(
      JSON.stringify({ error: "internal", detail: String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
async function handleRequest({ request, env }) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }

  const text = (body.text || "").trim();
  if (!text) return json({ error: "text_required" }, 400, cors);
  if (text.length > 2000) return json({ error: "text_too_long" }, 400, cors);

  const mode = body.mode || "auto";
  const route = resolveRoute(text, mode);

  // ===== KV 缓存查询 =====
  const cacheKey = await buildCacheKey(route, text);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, input: text, _cached: true }, 200, cors);
  }

  // ===== 缓存未命中，调用模型 =====
  let prompt;
  if (route === "word") prompt = wordPrompt(text);
  else if (route === "sentence") prompt = sentencePrompt(text);
  else prompt = autoPrompt(text); // 档3：模糊（2-4词无句末标点），模型自己分类

  const apiKey = env.DEEPSEEK_API_KEY;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const apiUrl = env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
  let upstream;
  try {
    upstream = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是英语语言学助手。严格只输出 JSON,不要任何额外文字、markdown 或代码块。在 examples 例句中,把目标单词/词组实际出现的形态用 [[ ]] 括起来(如 He finally [[paid off]] his debts.),只括英文部分,中文翻译里不要加。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        thinking: {type:"disabled"}
      }),
      eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } }
    });
  } catch (e) {
    return json({ error: "upstream_unreachable", detail: String(e) }, 502, cors);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail: errText }, 502, cors);
  }

  const data = await upstream.json();
  const content = data?.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    return json({ error: "model_output_not_json", raw: content }, 502, cors);
  }

  parsed = cleanCJKSpaces(parsed);

  // auto 路由：type 由模型返回；word/sentence 路由：type 即 route
  const finalType = route === "auto" ? (parsed.type || "sentence") : route;
  const result = { input: text, ...parsed, type: finalType };

  // ===== 写入缓存（失败不影响主流程）=====
  writeCache(cacheKey, result).catch((e) => {
    console.error("KV write failed:", e);
  });

  return json(result, 200, cors);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ============ KV 缓存逻辑 ============

const CACHE_VERSION = "v2";       // 结构变更（新增 phrase / auto 路由）→ 已 bump
const CACHE_TTL_SEC = 60 * 60 * 24 * 30;  // 30 天

async function buildCacheKey(route, text) {
  // word 路由转小写提升命中率；其余保留原文
  const normalized = route === "word" ? text.toLowerCase() : text;

  // KV 键名长度有限，超过阈值用 hash；短文本直接用原文方便调试
  if (normalized.length <= 80) {
    const safe = normalized.replace(/[\s/\\'"]+/g, "_");
    return `tr:${CACHE_VERSION}:${route}:${safe}`;
  }

  const hash = await sha256(normalized);
  return `tr:${CACHE_VERSION}:${route}:${hash}`;
}

async function sha256(s) {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readCache(key) {
  try {
    // EdgeOne KV：全局变量 KV 直接用，不在 env 上
    if (typeof KV === "undefined") return null;
    const raw = await KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error("KV read failed:", e);
    return null;
  }
}

async function writeCache(key, value) {
  if (typeof KV === "undefined") return;
  await KV.put(key, JSON.stringify(value), {
    expirationTtl: CACHE_TTL_SEC,
  });
}

// ============ 路由判断 ============
// 档1：单 token → word；档2：明显句子 → sentence；档3：2-4词模糊 → auto（模型判断）

function resolveRoute(text, mode) {
  if (mode === "word" || mode === "sentence") return mode;
  const trimmed = text.replace(/[.,!?;:'"()]/g, "").trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const hasSentenceEnd = /[.!?]$/.test(text.trim());
  if (wordCount === 1) return "word";
  if (hasSentenceEnd || wordCount >= 5) return "sentence";
  return "auto";
}

// ============ Prompts ============

function wordPrompt(word) {
  return `分析英文单词："${word}"。只输出 JSON：
{
  "translation": "中文释义,多义用 / 分隔,最多 3 个义项",
  "analysis": {
    "pos": "词性,如 n./v./adj.",
    "phonetic": "音标,带 / /",
    "inflections": [
      { "form": "变形", "label": "类型,如 过去式/过去分词/复数/比较级" }
    ],
    "morphology": [
      { "part": "构词成分", "kind": "prefix|root|suffix|combining_form", "meaning": "含义,不超过6字" }
    ],
    "examples": ["英文例句1 — 中文翻译", "英文例句2 — 中文翻译"]
  }
}
要求:
- inflections 只列不规则或值得注意的曲折变化(如 say→said、child→children、good→better/best);规则变化(直接加 -s/-ed/-ing)或无变化的词返回 []
- morphology 按词中顺序排列;接后缀有拼写变化时 part 用实际形式(如 unbelievable → un-/believ/-able);combining_form 用于希腊/拉丁实义成分(arthro-/-pod/bio-)
- 单纯词 morphology 返回 []
- 所有中文简洁,字符间不加空格`;
}

function sentencePrompt(sentence) {
  return `分析英文句子："${sentence}"。只输出 JSON，结构如下：
{
  "translation": "地道的中文翻译",
  "analysis": {
    "structure": "高层句法结构",
    "components": [
      { "role": "主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语", "text": "对应原文片段", "note": "简要说明" }
    ],
    "grammar_points": ["重要语法点"]
  }
}
要求：
- role 必须从给定枚举值中选取
- components 按句子中出现顺序排列
- grammar_points 聚焦于学习者易忽略的点（从句、非谓语、虚拟语气、倒装等），没有则返回空数组
- 中文字符之间不要插入空格`;
}

function autoPrompt(text) {
  return `判断并分析:"${text}"。它可能是:
- word:单词
- phrase:词组/短语动词/固定搭配(如 pay off、give up、look forward to)
- sentence:句子

只输出 JSON。

word:
{ "type":"word", "translation":"释义,/分隔最多3个", "analysis":{ "pos":"词性", "phonetic":"音标带//", "inflections":[{"form":"变形","label":"类型"}], "morphology":[{"part":"成分","kind":"prefix|root|suffix|combining_form","meaning":"含义≤6字"}], "examples":["例句 — 翻译"] } }

phrase:
{ "type":"phrase", "translation":"整体含义,/分隔", "analysis":{ "pos":"如 短语动词/固定搭配", "usage":"用法/可分性,≤30字", "examples":["例句 — 翻译","例句 — 翻译"] } }

sentence:
{ "type":"sentence", "translation":"地道翻译", "analysis":{ "structure":"句法结构概括", "components":[{"role":"主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语","text":"片段","note":"说明≤15字"}], "grammar_points":["语法点,最多2条≤20字"] } }

要求:type 必须准确,pay off 类短语动词是 phrase 不是 sentence;word 的 inflections 只列不规则变化,规则的返回 [];所有中文字符间不加空格。`;
}

// ============ 工具函数 ============

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function cleanCJKSpaces(obj) {
  if (typeof obj === "string") {
    return obj.replace(
      /([\u4e00-\u9fa5，。！？；：、])\s+(?=[\u4e00-\u9fa5，。！？；：、])/g,
      "$1"
    );
  }
  if (Array.isArray(obj)) return obj.map(cleanCJKSpaces);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj) out[k] = cleanCJKSpaces(obj[k]);
    return out;
  }
  return obj;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}
