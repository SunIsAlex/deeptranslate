// _lib/translate-core.js
// 公共工具：CORS、调模型、缓存、清洗。被 translate.js / translate-zh.js 共用。
// EdgeOne KV 是全局变量 KV，不在 env 上。

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

export const OPTIONS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export const CACHE_VERSION = "v4";
export const CACHE_TTL_SEC = 60 * 60 * 24 * 30; // 30 天
export const SUPPORTED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
export const MODEL_MAX_OUTPUT_TOKENS = 8192;

export function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// 调 DeepSeek，封装 system prompt、eo 超时、thinking 关闭等公共配置
// systemContent 可定制（英译中和中译英的 system 略不同）
export function resolveModel(requested, env) {
  if (SUPPORTED_MODELS.includes(requested)) return requested;
  const configured = env?.DEEPSEEK_MODEL || globalThis.DEEPSEEK_MODEL;
  return SUPPORTED_MODELS.includes(configured) ? configured : "deepseek-v4-flash";
}

export async function callModel(userPrompt, env, systemContent, model) {
  const apiKey = env?.DEEPSEEK_API_KEY || globalThis.DEEPSEEK_API_KEY;
  const selectedModel = resolveModel(model, env);
  const apiUrl = env?.DEEPSEEK_API_URL
    || globalThis.DEEPSEEK_API_URL
    || "https://api.deepseek.com/chat/completions";

  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: MODEL_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });

  return upstream;
}

export function stripFences(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// 部分兼容 OpenAI 的上游会把 content 返回为文本片段数组。
export function modelMessageContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

// response_format 通常能保证纯 JSON，但个别模型仍可能加说明文字或代码块。
// 先解析完整内容，再扫描第一个配平的 JSON 对象；绝不猜测或补写 JSON。
export function parseModelObject(content) {
  const source = stripFences(content);
  try {
    const value = JSON.parse(source);
    return isPlainObject(value) ? value : null;
  } catch {
    // 继续尝试提取外围文字中的完整对象。
  }

  for (let start = source.indexOf("{"); start >= 0;) {
    const end = findBalancedObjectEnd(source, start);
    // 未配平时后续的 "{" 都属于这个残缺对象，不能把内部对象当成顶层结果。
    if (end < 0) return null;
    try {
      const value = JSON.parse(source.slice(start, end + 1));
      if (isPlainObject(value)) return value;
    } catch {
      // 可能是说明文字中的示例，继续扫描下一个对象。
    }
    start = source.indexOf("{", end + 1);
  }
  return null;
}

// 截断通常发生在 analysis 后半段；只在 translation 字符串已经完整闭合时降级。
export function extractCompletedStringProperty(content, key) {
  const source = stripFences(content);
  const needle = `"${key}"`;
  let offset = 0;
  while (offset < source.length) {
    const keyStart = source.indexOf(needle, offset);
    if (keyStart < 0) return null;
    let cursor = keyStart + needle.length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] !== ":") {
      offset = keyStart + needle.length;
      continue;
    }
    cursor += 1;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] !== '"') return null;

    let escaped = false;
    for (let end = cursor + 1; end < source.length; end += 1) {
      const char = source[end];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        try {
          const value = JSON.parse(source.slice(cursor, end + 1));
          return typeof value === "string" ? value : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  return null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findBalancedObjectEnd(source, start) {
  const stack = ["{"];
  let inString = false;
  let escaped = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return -1;
      if (!stack.length) return cursor;
    }
  }
  return -1;
}

export function cleanCJKSpaces(obj) {
  if (typeof obj === "string") {
    return obj.replace(/([\u4e00-\u9fa5，。！？；：、])\s+(?=[\u4e00-\u9fa5，。！？；：、])/g, "$1");
  }
  if (Array.isArray(obj)) return obj.map(cleanCJKSpaces);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj) out[k] = cleanCJKSpaces(obj[k]);
    return out;
  }
  return obj;
}

// 缓存键：方向进 key，避免英译中/中译英冲突
export function buildCacheKey(direction, route, text, variant = "default") {
  const normalized = route === "word" ? text.toLowerCase() : text;
  if (normalized.length > 80) return null; // 长文本不缓存（避开 crypto.subtle）
  const safe = normalized.replace(/[\s/\\'"]+/g, "_");
  const safeVariant = variant.replace(/[^a-z0-9:_-]+/gi, "_");
  return `tr:${CACHE_VERSION}:${direction}:${route}:${safeVariant}:${safe}`;
}

export async function readCache(key) {
  if (!key) return null;
  try {
    if (typeof KV === "undefined") return null;
    const raw = await KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error("KV read failed:", e);
    return null;
  }
}

export async function writeCache(key, value) {
  if (!key) return;
  if (typeof KV === "undefined") return;
  await KV.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SEC });
}
