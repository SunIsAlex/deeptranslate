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

export const CACHE_VERSION = "v3";
export const CACHE_TTL_SEC = 60 * 60 * 24 * 30; // 30 天

export function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

// 调 DeepSeek，封装 system prompt、eo 超时、thinking 关闭等公共配置
// systemContent 可定制（英译中和中译英的 system 略不同）
export async function callModel(userPrompt, env, systemContent) {
  const apiKey = env.DEEPSEEK_API_KEY;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const apiUrl = env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";

  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    }),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });

  return upstream;
}

export function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
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
export function buildCacheKey(direction, route, text) {
  const normalized = route === "word" ? text.toLowerCase() : text;
  if (normalized.length > 80) return null; // 长文本不缓存（避开 crypto.subtle）
  const safe = normalized.replace(/[\s/\\'"]+/g, "_");
  return `tr:${CACHE_VERSION}:${direction}:${route}:${safe}`;
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
