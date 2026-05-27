// POST /translate
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
  const prompt = type === "word" ? wordPrompt(text) : sentencePrompt(text);

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
    parsed = cleanCJKSpaces(JSON.parse(stripFences(content)));
  } catch {
    return json({ error: "model_output_not_json", raw: content }, 502, cors);
  }
  return json({ type, input: text, ...parsed }, 200, cors);
}

// 处理预检
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

// 其他方法直接拒绝

function resolveType(text, mode) {
  if (mode === "word" || mode === "sentence") return mode;
  // auto：无空格且长度 <=30 视为单词/短语
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
      { "part": "构词成分", "kind": "prefix|root|suffix", "meaning": "该成分的含义" }
    ],
    "etymology": "一句话词源",
    "examples": ["英文例句1（含中文翻译，用 — 分隔）", "英文例句2 — 中文翻译"]
  }
}

要求：
1. morphology字段： 必须按单词中出现的顺序列出；如果是单纯词无可拆分成分，morphology 返回空数组。
特别注意：当词根接后缀时如有拼写变化（如去 e、双写、变 y 为 i），
morphology 中的 part 必须反映实际的拼写形式，不是原形。
例如 unbelievable 应拆为 un- / believ / -able，而非 un- / believe / -able。
2. etymology 字段：只给确定的来源（如"拉丁语 credere"、"希腊语 logos"），
不确定时简短描述构词关系即可，不要编造历史细节。
`;
}

function sentencePrompt(sentence) {
  return `分析英文句子："${sentence}"。只输出 JSON，结构如下：
{
  "translation": "地道的中文翻译",
  "analysis": {
    "structure": "高层句法结构，如 主语+谓语+宾语+状语",
    "components": [
      { "role": "主语|谓语|宾语|表语|定语|状语|补语", "text": "对应原文片段", "note": "简要说明，如时态、语态、词性" }
    ],
    "grammar_points": ["重要语法点1", "重要语法点2"]
  }
}
要求：components 按句子中出现顺序排列；grammar_points 聚焦于学习者易忽略的点，如从句、非谓语、虚拟语气、倒装等，没有则返回空数组。`;
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

function cleanCJKSpaces(obj) {
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