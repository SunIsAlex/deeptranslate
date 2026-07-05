// edge-functions/api/translate.js
// 英译中接口：单词/词组/句子，词根词缀 + 语法分析

import {
  CORS, OPTIONS_HEADERS, json, callModel,
  stripFences, cleanCJKSpaces, buildCacheKey, readCache, writeCache, resolveModel,
} from "../_lib/translate-core.js";

const SYSTEM = "你是英语语言学助手。严格只输出 json，不要任何额外文字、markdown 或代码块。在 examples 例句中，把目标单词/词组实际出现的形态用 [[ ]] 括起来（如 He finally [[paid off]] his debts.），只括英文部分，中文翻译里不要加。";

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
  const grammarAnalysis = body.grammarAnalysis !== false;
  const model = resolveModel(body.model, env);

  const variant = `${model}:${grammarAnalysis ? "grammar" : "translation"}`;
  const cacheKey = buildCacheKey("en2zh", route, text, variant);
  const cached = await readCache(cacheKey);
  if (cached) {
    return json({ ...cached, input: text, _cached: true }, 200, CORS);
  }

  let prompt;
  if (route === "word") prompt = wordPrompt(text);
  else if (route === "sentence") prompt = sentencePrompt(text, grammarAnalysis);
  else prompt = autoPrompt(text, grammarAnalysis);

  const upstream = await callModel(prompt, env, SYSTEM, model);
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
  const result = {
    direction: "en2zh",
    input: text,
    ...parsed,
    type: finalType,
    model,
    grammarAnalysis,
  };

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
  return `分析英文单词："${word}"。只输出 json：
{
  "translation": "中文释义,多义用 / 分隔,最多 3 个义项",
  "senses": [
    { "zh": "该义项的简洁中文释义", "definition": "A concise English definition of this sense." }
  ],
  "analysis": {
    "pos": "词性,如 n./v./adj./abbr.",
    "phonetic": "音标,带 / /",
    "fullForm": "仅当输入是首字母缩略词(如 NATO/FBI/UNESCO)时给出完整展开,如 North Atlantic Treaty Organization；其他词返回空字符串",
    "inflections": [ { "form": "变形", "label": "类型,如 过去式/过去分词/复数/比较级" } ],
    "morphology": [ { "part": "构词成分", "kind": "prefix|root|suffix|combining_form|abbr", "meaning": "含义,不超过6字" } ],
    "examples": ["英文例句1 — 中文翻译", "英文例句2 — 中文翻译"]
  }
}
要求:
- senses 按常用度列出最多 3 个义项；每个 zh 与 translation 中对应义项一致，translation 等于所有 zh 用 " / " 连接
- definition 必须使用简洁自然的英文解释对应义项，不能只是英文同义词或中文释义的重复，且每项不超过 25 个英文单词
- inflections 只列不规则或值得注意的曲折变化(如 say→said、child→children、good→better/best);规则变化(直接加 -s/-ed/-ing)或无变化的词返回 []
- morphology 按词中顺序排列;接后缀有拼写变化时 part 用实际形式(如 unbelievable → un-/believ/-able);combining_form 用于希腊/拉丁实义成分(arthro-/-pod/bio-)
- 若输入是首字母缩略词(initialism,如 NATO/FBI):fullForm 给完整展开式,morphology 每个字母一条、kind 用 abbr、meaning 是该字母对应的英文单词(如 N→North)
- 截断类缩写(Dr./etc./approx.)或普通词:fullForm 返回空字符串,morphology 按原规则处理
- 单纯词 morphology 返回 []
- 所有中文简洁,字符间不加空格`;
}

function sentencePrompt(sentence, grammarAnalysis) {
  if (!grammarAnalysis) {
    return `把英文句子翻译成地道中文："${sentence}"。只输出 json：
{ "translation": "地道的中文翻译" }
要求：不要返回语法分析或其他字段；中文字符之间不要插入空格。`;
  }
  return `分析英文句子："${sentence}"。只输出 json，结构如下：
{
  "translation": "地道的中文翻译",
  "analysis": {
    "structure": "高层句法结构",
    "components": [ { "role": "主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语", "text": "对应原文片段", "note": "简要说明" } ],
    "grammar_points": ["重要语法点"]
  }
}
要求：
- role 必须从给定枚举值中选取
- components 按句子中出现顺序排列
- grammar_points 聚焦于学习者易忽略的点（从句、非谓语、虚拟语气、倒装等），没有则返回空数组
- 中文字符之间不要插入空格`;
}

function autoPrompt(text, grammarAnalysis) {
  const sentenceSchema = grammarAnalysis
    ? `{ "type":"sentence", "translation":"地道翻译", "analysis":{ "structure":"句法结构概括", "components":[{"role":"主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语","text":"片段","note":"说明≤15字"}], "grammar_points":["语法点,最多2条≤20字"] } }`
    : `{ "type":"sentence", "translation":"地道翻译" }`;
  return `判断并分析:"${text}"。它可能是:
- word:单词
- phrase:词组/短语动词/固定搭配(如 pay off、give up、look forward to)
- sentence:句子

只输出 json。

word:
{ "type":"word", "translation":"释义,/分隔最多3个", "senses":[{"zh":"中文义项","definition":"Concise English definition of this sense."}], "analysis":{ "pos":"词性", "phonetic":"音标带//", "inflections":[{"form":"变形","label":"类型"}], "morphology":[{"part":"成分","kind":"prefix|root|suffix|combining_form","meaning":"含义≤6字"}], "examples":["例句 — 翻译"] } }

phrase:
{ "type":"phrase", "translation":"整体含义,/分隔最多3个", "senses":[{"zh":"中文义项","definition":"Concise English definition of this sense."}], "analysis":{ "pos":"如 短语动词/固定搭配", "usage":"用法/可分性,≤30字", "examples":["例句 — 翻译","例句 — 翻译"] } }

sentence:
${sentenceSchema}

要求:
- type 必须准确,pay off 类短语动词是 phrase 不是 sentence
- word 和 phrase 的 senses 按常用度列出最多 3 个义项；每个 zh 与 translation 中对应义项一致，translation 等于所有 zh 用 " / " 连接
- definition 必须是对应义项的简洁自然英文解释，不能只是英文同义词或中文释义的重复，每项不超过 25 个英文单词
- sentence 不要返回 senses
- sentence ${grammarAnalysis ? "必须返回 analysis 语法分析" : "只返回 type 和 translation，不要返回 analysis"}
- word 的 inflections 只列不规则变化,规则的返回 []
- 所有中文字符间不加空格。`;
}
