// edge-functions/api/translate.js
// 英译中接口：单词/词组/句子，词根词缀 + 语法分析

import {
  CORS, OPTIONS_HEADERS, json, callModel,
  stripFences, cleanCJKSpaces, buildCacheKey, readCache, writeCache,
} from "../_lib/translate-core.js";

const SYSTEM = "\u4f60\u662f\u82f1\u8bed\u8bed\u8a00\u5b66\u52a9\u624b\u3002\u4e25\u683c\u53ea\u8f93\u51fa json\uff0c\u4e0d\u8981\u4efb\u4f55\u989d\u5916\u6587\u5b57\u3001markdown \u6216\u4ee3\u7801\u5757\u3002\u5728 examples \u4f8b\u53e5\u4e2d\uff0c\u628a\u76ee\u6807\u5355\u8bcd/\u8bcd\u7ec4\u5b9e\u9645\u51fa\u73b0\u7684\u5f62\u6001\u7528 [[ ]] \u62ec\u8d77\u6765\uff08\u5982 He finally [[paid off]] his debts.\uff09\uff0c\u53ea\u62ec\u82f1\u6587\u90e8\u5206\uff0c\u4e2d\u6587\u7ffb\u8bd1\u91cc\u4e0d\u8981\u52a0\u3002";

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

  const mode = body.mode || "auto";
  const route = resolveRoute(text, mode);

  const cacheKey = buildCacheKey("en2zh", route, text);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, input: text, _cached: true }, 200, CORS);
  }

  let prompt;
  if (route === "word") prompt = wordPrompt(text);
  else if (route === "sentence") prompt = sentencePrompt(text);
  else prompt = autoPrompt(text);

  const upstream = await callModel(prompt, env, SYSTEM);
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
  const finalType = route === "auto" ? (parsed.type || "sentence") : route;
  const result = { direction: "en2zh", input: text, ...parsed, type: finalType };

  writeCache(cacheKey, result).catch((e) => console.error("KV write failed:", e));

  return json(result, 200, CORS);
}

function resolveRoute(text, mode) {
  if (mode === "word" || mode === "sentence") return mode;
  const trimmed = text.replace(/[.,!?;:'"()]/g, "").trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const hasSentenceEnd = /[.!?]$/.test(text.trim());
  if (wordCount === 1) return "word";
  if (hasSentenceEnd || wordCount >= 5) return "sentence";
  return "auto";
}

function wordPrompt(word) {
  return `\u5206\u6790\u82f1\u6587\u5355\u8bcd\uff1a"${word}"\u3002\u53ea\u8f93\u51fa json\uff1a
{
  "translation": "\u4e2d\u6587\u91ca\u4e49,\u591a\u4e49\u7528 / \u5206\u9694,\u6700\u591a 3 \u4e2a\u4e49\u9879",
  "analysis": {
    "pos": "\u8bcd\u6027,\u5982 n./v./adj.",
    "phonetic": "\u97f3\u6807,\u5e26 / /",
    "inflections": [ { "form": "\u53d8\u5f62", "label": "\u7c7b\u578b,\u5982 \u8fc7\u53bb\u5f0f/\u8fc7\u53bb\u5206\u8bcd/\u590d\u6570/\u6bd4\u8f83\u7ea7" } ],
    "morphology": [ { "part": "\u6784\u8bcd\u6210\u5206", "kind": "prefix|root|suffix|combining_form", "meaning": "\u542b\u4e49,\u4e0d\u8d85\u8fc76\u5b57" } ],
    "examples": ["\u82f1\u6587\u4f8b\u53e51 \u2014 \u4e2d\u6587\u7ffb\u8bd1", "\u82f1\u6587\u4f8b\u53e52 \u2014 \u4e2d\u6587\u7ffb\u8bd1"]
  }
}
\u8981\u6c42:
- inflections \u53ea\u5217\u4e0d\u89c4\u5219\u6216\u503c\u5f97\u6ce8\u610f\u7684\u66f2\u6298\u53d8\u5316(\u5982 say\u2192said\u3001child\u2192children\u3001good\u2192better/best);\u89c4\u5219\u53d8\u5316(\u76f4\u63a5\u52a0 -s/-ed/-ing)\u6216\u65e0\u53d8\u5316\u7684\u8bcd\u8fd4\u56de []
- morphology \u6309\u8bcd\u4e2d\u987a\u5e8f\u6392\u5217;\u63a5\u540e\u7f00\u6709\u62fc\u5199\u53d8\u5316\u65f6 part \u7528\u5b9e\u9645\u5f62\u5f0f(\u5982 unbelievable \u2192 un-/believ/-able);combining_form \u7528\u4e8e\u5e0c\u814a/\u62c9\u4e01\u5b9e\u4e49\u6210\u5206(arthro-/-pod/bio-)
- \u5355\u7eaf\u8bcd morphology \u8fd4\u56de []
- \u6240\u6709\u4e2d\u6587\u7b80\u6d01,\u5b57\u7b26\u95f4\u4e0d\u52a0\u7a7a\u683c`;
}

function sentencePrompt(sentence) {
  return `\u5206\u6790\u82f1\u6587\u53e5\u5b50\uff1a"${sentence}"\u3002\u53ea\u8f93\u51fa json\uff0c\u7ed3\u6784\u5982\u4e0b\uff1a
{
  "translation": "\u5730\u9053\u7684\u4e2d\u6587\u7ffb\u8bd1",
  "analysis": {
    "structure": "\u9ad8\u5c42\u53e5\u6cd5\u7ed3\u6784",
    "components": [ { "role": "\u4e3b\u8bed|\u8c13\u8bed|\u5bbe\u8bed|\u8868\u8bed|\u5b9a\u8bed|\u72b6\u8bed|\u8865\u8bed|\u540c\u4f4d\u8bed|\u63d2\u5165\u8bed", "text": "\u5bf9\u5e94\u539f\u6587\u7247\u6bb5", "note": "\u7b80\u8981\u8bf4\u660e" } ],
    "grammar_points": ["\u91cd\u8981\u8bed\u6cd5\u70b9"]
  }
}
\u8981\u6c42\uff1a
- role \u5fc5\u987b\u4ece\u7ed9\u5b9a\u679a\u4e3e\u503c\u4e2d\u9009\u53d6
- components \u6309\u53e5\u5b50\u4e2d\u51fa\u73b0\u987a\u5e8f\u6392\u5217
- grammar_points \u805a\u7126\u4e8e\u5b66\u4e60\u8005\u6613\u5ffd\u7565\u7684\u70b9\uff08\u4ece\u53e5\u3001\u975e\u8c13\u8bed\u3001\u865a\u62df\u8bed\u6c14\u3001\u5012\u88c5\u7b49\uff09\uff0c\u6ca1\u6709\u5219\u8fd4\u56de\u7a7a\u6570\u7ec4
- \u4e2d\u6587\u5b57\u7b26\u4e4b\u95f4\u4e0d\u8981\u63d2\u5165\u7a7a\u683c`;
}

function autoPrompt(text) {
  return `\u5224\u65ad\u5e76\u5206\u6790:"${text}"\u3002\u5b83\u53ef\u80fd\u662f:
- word:\u5355\u8bcd
- phrase:\u8bcd\u7ec4/\u77ed\u8bed\u52a8\u8bcd/\u56fa\u5b9a\u642d\u914d(\u5982 pay off\u3001give up\u3001look forward to)
- sentence:\u53e5\u5b50

\u53ea\u8f93\u51fa json\u3002

word:
{ "type":"word", "translation":"\u91ca\u4e49,/\u5206\u9694\u6700\u591a3\u4e2a", "analysis":{ "pos":"\u8bcd\u6027", "phonetic":"\u97f3\u6807\u5e26//", "inflections":[{"form":"\u53d8\u5f62","label":"\u7c7b\u578b"}], "morphology":[{"part":"\u6210\u5206","kind":"prefix|root|suffix|combining_form","meaning":"\u542b\u4e49\u22646\u5b57"}], "examples":["\u4f8b\u53e5 \u2014 \u7ffb\u8bd1"] } }

phrase:
{ "type":"phrase", "translation":"\u6574\u4f53\u542b\u4e49,/\u5206\u9694", "analysis":{ "pos":"\u5982 \u77ed\u8bed\u52a8\u8bcd/\u56fa\u5b9a\u642d\u914d", "usage":"\u7528\u6cd5/\u53ef\u5206\u6027,\u226430\u5b57", "examples":["\u4f8b\u53e5 \u2014 \u7ffb\u8bd1","\u4f8b\u53e5 \u2014 \u7ffb\u8bd1"] } }

sentence:
{ "type":"sentence", "translation":"\u5730\u9053\u7ffb\u8bd1", "analysis":{ "structure":"\u53e5\u6cd5\u7ed3\u6784\u6982\u62ec", "components":[{"role":"\u4e3b\u8bed|\u8c13\u8bed|\u5bbe\u8bed|\u8868\u8bed|\u5b9a\u8bed|\u72b6\u8bed|\u8865\u8bed|\u540c\u4f4d\u8bed|\u63d2\u5165\u8bed","text":"\u7247\u6bb5","note":"\u8bf4\u660e\u226415\u5b57"}], "grammar_points":["\u8bed\u6cd5\u70b9,\u6700\u591a2\u6761\u226420\u5b57"] } }

\u8981\u6c42:type \u5fc5\u987b\u51c6\u786e,pay off \u7c7b\u77ed\u8bed\u52a8\u8bcd\u662f phrase \u4e0d\u662f sentence;word \u7684 inflections \u53ea\u5217\u4e0d\u89c4\u5219\u53d8\u5316,\u89c4\u5219\u7684\u8fd4\u56de [];\u6240\u6709\u4e2d\u6587\u5b57\u7b26\u95f4\u4e0d\u52a0\u7a7a\u683c\u3002`;
}
