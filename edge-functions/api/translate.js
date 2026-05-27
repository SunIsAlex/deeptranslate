// POST /api/translate
// 依赖 EdgeOne Pages KV：变量名假设为 KV（在控制台绑定时填的名字）
// 注意：EdgeOne 的 KV 是全局变量，不在 env 上

export async function onRequestPost({ request, env }) {
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
  const type = resolveType(text, mode);

  // ===== KV 缓存查询 =====
  const cacheKey = await buildCacheKey(type, text);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, _cached: true }, 200, cors);
  }

  // ===== 缓存未命中，调用模型 =====
  const prompt = type === "word" ? wordPrompt(text) : sentencePrompt(text);

  const apiKey = env.DEEPSEEK_API_KEY;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const apiUrl = env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
  console.log("env:", JSON.stringify(env, null, 2));
  console.log("apiKey:", apiKey, "model:", model, "apiUrl:", apiUrl);
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
          { role: "system", content: "你是英语语言学助手，严格按用户要求只输出 JSON，不要任何额外文字、markdown 或代码块。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
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
  const result = { type, input: text, ...parsed };

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

const CACHE_VERSION = "v1";       // prompt 或输出结构变了就 bump 这个
const CACHE_TTL_SEC = 60 * 60 * 24 * 30;  // 30 天

async function buildCacheKey(type, text) {
  // 单词模式：转小写，提升命中率
  // 句子模式：保留原文（大小写有语义）
  const normalized = type === "word" ? text.toLowerCase() : text;

  // KV 键名长度有限，超过阈值用 hash；短文本直接用原文方便调试
  if (normalized.length <= 80) {
    // 替换 KV 不允许的字符（空格、斜杠、引号等）
    const safe = normalized.replace(/[\s/\\'"]+/g, "_");
    return `tr:${CACHE_VERSION}:${type}:${safe}`;
  }

  const hash = await sha256(normalized);
  return `tr:${CACHE_VERSION}:${type}:${hash}`;
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

// ============ 业务逻辑 ============

function resolveType(text, mode) {
  if (mode === "word" || mode === "sentence") return mode;
  const trimmed = text.replace(/[.,!?;:'"()]/g, "").trim();
  return !/\s/.test(trimmed) && trimmed.length <= 30 ? "word" : "sentence";
}

function wordPrompt(word) {
  return `分析英文单词："${word}"。只输出 JSON，结构如下：
{
  "translation": "中文释义（多个义项用 / 分隔）",
  "analysis": {
    "pos": "词性，如 n./v./adj.",
    "phonetic": "音标（英式或美式皆可，带 / /）",
    "morphology": [
      { "part": "构词成分", "kind": "prefix|root|suffix|combining_form", "meaning": "该成分的含义" }
    ],
    "etymology": "一句话词源",
    "examples": ["英文例句1 — 中文翻译", "英文例句2 — 中文翻译"]
  }
}
要求：
- morphology 必须按单词中出现的顺序列出
- 当词根接后缀时如有拼写变化（如去 e、双写、变 y 为 i），part 必须反映实际拼写形式，不是原形。例如 unbelievable 拆为 un- / believ / -able
- combining_form 用于希腊/拉丁源的实义构词成分（如 arthro-, -pod, bio-, -logy）
- etymology 只给确定的来源，不确定时简短描述构词关系即可，不要编造历史细节
- 中文字符之间不要插入空格
- 如果是单纯词无可拆分成分，morphology 返回空数组`;
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