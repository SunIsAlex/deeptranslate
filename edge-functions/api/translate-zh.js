// edge-functions/api/translate-zh.js
// 中译英接口：输入中文，输出多个英文备选表达 + 用法区别

import {
  CORS, OPTIONS_HEADERS, json, callModel,
  stripFences, cleanCJKSpaces, buildCacheKey, readCache, writeCache,
} from "../_lib/translate-core.js";

const SYSTEM = "\u4f60\u662f\u82f1\u8bed\u5b66\u4e60\u52a9\u624b\u3002\u4e25\u683c\u53ea\u8f93\u51fa json\uff0c\u4e0d\u8981\u4efb\u4f55\u989d\u5916\u6587\u5b57\u3001markdown \u6216\u4ee3\u7801\u5757\u3002\u5728 example \u4f8b\u53e5\u4e2d\uff0c\u628a\u76ee\u6807\u82f1\u6587\u8868\u8fbe\u7528 [[ ]] \u62ec\u8d77\u6765\uff0c\u53ea\u62ec\u82f1\u6587\u90e8\u5206\u3002";

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (e) {
    console.error("unhandled:", e);
    return json({ error: "internal", detail: String(e) }, 500, CORS);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: OPTIONS_HEADERS });
}

async function handle({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, CORS);
  }

  const text = (body.text || "").trim();
  if (!text) return json({ error: "text_required" }, 400, CORS);
  if (text.length > 2000) return json({ error: "text_too_long" }, 400, CORS);
  // 中译英要求含中文
  if (!/[\u4e00-\u9fa5]/.test(text)) return json({ error: "chinese_required", message: "\u8bf7\u8f93\u5165\u4e2d\u6587" }, 400, CORS);

  // 中文无空格，无法用空格判词/句；用长度粗略分流（仅用于缓存键归类）
  const route = text.length <= 8 ? "word" : "sentence";

  const cacheKey = buildCacheKey("zh2en", route, text);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, input: text, _cached: true }, 200, CORS);
  }

  const upstream = await callModel(zhPrompt(text), env, SYSTEM);
  if (!upstream.ok) {
    const errText = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail: errText }, 502, CORS);
  }

  const data = await upstream.json();
  const content = data?.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    return json({ error: "model_output_not_json", raw: content }, 502, CORS);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json({ error: "model_output_not_object", raw: content }, 502, CORS);
  }

  parsed = cleanCJKSpaces(parsed);
  const result = { direction: "zh2en", input: text, ...parsed };

  writeCache(cacheKey, result).catch((e) => console.error("KV write failed:", e));

  return json(result, 200, CORS);
}

function zhPrompt(text) {
  return `把中文"${text}"翻译成英文。判断它是词/短语还是句子。只输出 json：
{
  "type": "word|phrase|sentence",
  "translations": [
    { "en": "英文表达", "note": "用法/语域区别，≤20字", "example": "英文例句 — 中文翻译" }
  ]
}
要求：
- 词或短语：给 2-4 个备选英文表达，按常用度排序；note 说明各表达的区别（正式/口语/语气/适用场景），若无明显区别可留空字符串
- 句子：只给 1 个最地道的译法，不要 example 字段（句子本身就是完整翻译，无需再举例）
- example 中目标英文表达用 [[ ]] 括起来
- 句子输入时给 1 个最地道的整句翻译即可
- 所有中文字符间不加空格`;
}