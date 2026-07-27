// edge-functions/api/translate-zh.js
// 中译英接口：输入中文，输出多个英文备选表达 + 用法区别

import {
  CORS, OPTIONS_HEADERS, json, callModel,
  cleanCJKSpaces, buildCacheKey, readCache, writeCache, resolveModel,
  modelMessageContent, parseModelObject, extractCompletedStringProperty,
} from "../_lib/translate-core.js";

const SYSTEM = "你是英语学习助手。严格只输出 json，不要任何额外文字、markdown 或代码块。在 example 例句中，把目标英文表达用 [[ ]] 括起来，只括英文部分。";

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
  if (!/[一-龥]/.test(text)) return json({ error: "chinese_required", message: "请输入中文" }, 400, CORS);

  // 中文无空格，无法用空格判词/句；用长度粗略分流（仅用于缓存键归类）
  const route = text.length <= 8 ? "word" : "sentence";
  const model = resolveModel(body.model, env);

  const cacheKey = buildCacheKey("zh2en", route, text, model);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, input: text, _cached: true }, 200, CORS);
  }

  const upstream = await callModel(zhPrompt(text), env, SYSTEM, model);
  if (!upstream.ok) {
    const errText = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail: errText }, 502, CORS);
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return json({ error: "upstream_response_not_json" }, 502, CORS);
  }

  let content = modelMessageContent(data);
  let parsed = parseModelObject(content);
  if (!hasTranslations(parsed)) parsed = null;
  let recovered = false;
  let degraded = false;

  if (!parsed && route === "sentence") {
    console.warn("invalid zh2en model JSON; retrying compact sentence output", {
      finishReason: data?.choices?.[0]?.finish_reason,
      contentLength: content.length,
      inputLength: text.length,
    });
    const retry = await callModel(compactZhSentencePrompt(text), env, SYSTEM, model);
    if (retry.ok) {
      try {
        const retryData = await retry.json();
        const retryContent = modelMessageContent(retryData);
        parsed = parseModelObject(retryContent);
        if (!hasTranslations(parsed)) parsed = null;
        if (parsed) {
          content = retryContent;
          recovered = true;
        } else {
          const en = extractCompletedStringProperty(retryContent, "en")
            || extractCompletedStringProperty(content, "en");
          if (en) {
            parsed = { type: "sentence", translations: [{ en }] };
            content = retryContent;
            recovered = true;
            degraded = true;
          }
        }
      } catch {
        // 继续使用首次响应安全降级。
      }
    }

    if (!parsed) {
      const en = extractCompletedStringProperty(content, "en");
      if (en) {
        parsed = { type: "sentence", translations: [{ en }] };
        recovered = true;
        degraded = true;
      }
    }
  }

  if (!parsed) {
    return json({
      error: "model_output_not_json",
      finishReason: data?.choices?.[0]?.finish_reason || null,
      contentLength: content.length,
    }, 502, CORS);
  }

  parsed = cleanCJKSpaces(parsed);
  const result = {
    direction: "zh2en",
    input: text,
    ...parsed,
    model,
    ...(recovered ? { _recovered: true } : {}),
    ...(degraded ? { _degraded: true } : {}),
  };

  if (!degraded) {
    writeCache(cacheKey, result).catch((e) => console.error("KV write failed:", e));
  }

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

function compactZhSentencePrompt(text) {
  return `把下面中文完整翻译成一个自然、准确的英文句子。只输出可被 JSON.parse 解析的 JSON，不要 Markdown、解释或备选译法。
中文：${JSON.stringify(text)}
格式：{"type":"sentence","translations":[{"en":"完整英文译文"}]}`;
}

function hasTranslations(value) {
  return Array.isArray(value?.translations)
    && value.translations.some((item) => typeof item?.en === "string" && item.en.trim());
}
