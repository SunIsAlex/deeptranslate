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
  return `\u628a\u4e2d\u6587"${text}"\u7ffb\u8bd1\u6210\u82f1\u6587\u3002\u5224\u65ad\u5b83\u662f\u8bcd/\u77ed\u8bed\u8fd8\u662f\u53e5\u5b50\u3002\u53ea\u8f93\u51fa json\uff1a
{
  "type": "word|phrase|sentence",
  "translations": [
    { "en": "\u82f1\u6587\u8868\u8fbe", "note": "\u7528\u6cd5/\u8bed\u57df\u533a\u522b\uff0c\u226420\u5b57", "example": "\u82f1\u6587\u4f8b\u53e5 \u2014 \u4e2d\u6587\u7ffb\u8bd1" }
  ]
}
\u8981\u6c42\uff1a
- \u7ed9 2-4 \u4e2a\u5907\u9009\u82f1\u6587\u8868\u8fbe\uff0c\u6309\u5e38\u7528\u5ea6\u6392\u5e8f
- note \u8bf4\u660e\u5404\u8868\u8fbe\u7684\u533a\u522b\uff08\u6b63\u5f0f/\u53e3\u8bed/\u8bed\u6c14/\u9002\u7528\u573a\u666f\uff09\uff0c\u82e5\u65e0\u660e\u663e\u533a\u522b\u53ef\u7559\u7a7a\u5b57\u7b26\u4e32
- example \u4e2d\u76ee\u6807\u82f1\u6587\u8868\u8fbe\u7528 [[ ]] \u62ec\u8d77
- \u53e5\u5b50\u8f93\u5165\u65f6\u7ed9 1-2 \u4e2a\u6700\u5730\u9053\u7684\u6574\u53e5\u7ffb\u8bd1\u5373\u53ef
- \u6240\u6709\u4e2d\u6587\u5b57\u7b26\u95f4\u4e0d\u52a0\u7a7a\u683c`;
}
