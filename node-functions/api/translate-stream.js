// 英译中流式接口：完整译文/例句按项推送，最终发送完整 JSON。

const SYSTEM = "你是英语语言学助手。严格只输出 json，不要任何额外文字、markdown 或代码块。在 examples 例句中，把目标单词/词组实际出现的形态用 [[ ]] 括起来，只括英文部分，中文翻译里不要加。";

const JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

const SSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const text = (body.text || "").trim();
  if (!text) return json({ error: "text_required" }, 400);
  if (text.length > 2000) return json({ error: "text_too_long" }, 400);

  const mode = body.mode || "auto";
  const route = resolveRoute(text, mode);
  const apiKey = envValue(context, "DEEPSEEK_API_KEY");
  if (!apiKey) return json({ error: "server_not_configured" }, 500);

  const cached = await readEdgeCache(request.url, text, route);
  if (cached) {
    return createCachedStream(cached, text, route);
  }

  const abortController = new AbortController();
  request.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  const upstream = await fetch(
    envValue(context, "DEEPSEEK_API_URL") || "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: envValue(context, "DEEPSEEK_MODEL") || "deepseek-chat",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: promptFor(route, text) },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        stream: true,
      }),
      signal: abortController.signal,
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail }, 502);
  }

  const responseStream = new TransformStream();
  const writer = responseStream.writable.getWriter();
  const task = pumpModelStream({
    upstream,
    writer,
    text,
    route,
    apiKey,
    requestUrl: request.url,
  });
  context.waitUntil?.(task);

  return new Response(responseStream.readable, { headers: SSE_HEADERS });
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

async function pumpModelStream({ upstream, writer, text, route, apiKey, requestUrl }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let lineBuffer = "";
  let content = "";
  let sentTranslation = false;
  let sentExamples = 0;
  let cacheWrite;

  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  try {
    await send("meta", { route, cached: false });

    while (true) {
      const { done, value } = await reader.read();
      lineBuffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = lineBuffer.split("\n");
      lineBuffer = done ? "" : lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (!delta) continue;
        content += delta;

        if (!sentTranslation) {
          const translation = extractStringProperty(content, "translation");
          if (translation !== null) {
            sentTranslation = true;
            await send("translation", { text: cleanCJKSpaces(translation) });
          }
        }

        const examples = extractStringArray(content, "examples");
        while (sentExamples < examples.length) {
          await send("example", {
            index: sentExamples,
            text: cleanCJKSpaces(examples[sentExamples]),
          });
          sentExamples += 1;
        }
      }

      if (done) break;
    }

    let parsed = JSON.parse(stripFences(content));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("model_output_not_object");
    }
    parsed = cleanCJKSpaces(parsed);
    const finalType = route === "auto" ? (parsed.type || "sentence") : route;
    const result = {
      direction: "en2zh",
      input: text,
      ...parsed,
      type: finalType,
      _cached: false,
      _streamed: true,
    };

    // 兜底：若模型字段顺序异常，最终解析后仍补发未发送的内容。
    if (!sentTranslation && result.translation) {
      await send("translation", { text: result.translation });
    }
    const finalExamples = result.analysis?.examples || [];
    while (sentExamples < finalExamples.length) {
      await send("example", { index: sentExamples, text: finalExamples[sentExamples] });
      sentExamples += 1;
    }

    await send("result", result);
    await send("done", {});
    cacheWrite = writeEdgeCache(requestUrl, text, route, result, apiKey);
  } catch (error) {
    if (error?.name !== "AbortError") {
      try {
        await send("error", { error: "stream_failed", detail: String(error) });
      } catch {
        // 客户端可能已经断开。
      }
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // 流已被取消。
    }
    if (cacheWrite) await cacheWrite;
  }
}

function createCachedStream(cached, text, route) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const result = {
        ...cached,
        input: text,
        _cached: true,
        _streamed: true,
      };
      send("meta", { route, cached: true });
      if (result.translation) send("translation", { text: result.translation });
      (result.analysis?.examples || []).forEach((example, index) => {
        send("example", { index, text: example });
      });
      send("result", result);
      send("done", {});
      controller.close();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

async function readEdgeCache(requestUrl, text, route) {
  try {
    const response = await fetch(new URL("/api/translate-cache", requestUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", text, route }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.hit ? data.result : null;
  } catch {
    return null;
  }
}

async function writeEdgeCache(requestUrl, text, route, result, apiKey) {
  try {
    await fetch(new URL("/api/translate-cache", requestUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cache-Token": apiKey,
      },
      body: JSON.stringify({ action: "put", text, route, result }),
    });
  } catch (error) {
    console.error("stream cache write failed:", error);
  }
}

function envValue(context, name) {
  return context.env?.[name] || process.env?.[name] || globalThis[name];
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function stripFences(value) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function cleanCJKSpaces(value) {
  if (typeof value === "string") {
    return value.replace(/([\u4e00-\u9fa5，。！？；：、])\s+(?=[\u4e00-\u9fa5，。！？；：、])/g, "$1");
  }
  if (Array.isArray(value)) return value.map(cleanCJKSpaces);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanCJKSpaces(item)]),
    );
  }
  return value;
}

function extractStringProperty(source, key) {
  const valueStart = findPropertyValue(source, key);
  if (valueStart < 0 || source[valueStart] !== '"') return null;
  return parseCompletedJsonString(source, valueStart)?.value ?? null;
}

function extractStringArray(source, key) {
  const valueStart = findPropertyValue(source, key);
  if (valueStart < 0 || source[valueStart] !== "[") return [];

  const values = [];
  let cursor = valueStart + 1;
  while (cursor < source.length) {
    while (/[\s,]/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] === "]") return values;
    if (source[cursor] !== '"') return values;
    const parsed = parseCompletedJsonString(source, cursor);
    if (!parsed) return values;
    values.push(parsed.value);
    cursor = parsed.end;
  }
  return values;
}

function findPropertyValue(source, key) {
  const needle = `"${key}"`;
  let start = 0;
  while (start < source.length) {
    const keyIndex = source.indexOf(needle, start);
    if (keyIndex < 0) return -1;
    let cursor = keyIndex + needle.length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] === ":") {
      cursor += 1;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
      return cursor;
    }
    start = keyIndex + needle.length;
  }
  return -1;
}

function parseCompletedJsonString(source, start) {
  let escaped = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      try {
        return {
          value: JSON.parse(source.slice(start, cursor + 1)),
          end: cursor + 1,
        };
      } catch {
        return null;
      }
    }
  }
  return null;
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

function promptFor(route, text) {
  if (route === "word") return wordPrompt(text);
  if (route === "sentence") return sentencePrompt(text);
  return autoPrompt(text);
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
    "fullForm": "仅当输入是首字母缩略词时给出完整展开,其他词返回空字符串",
    "inflections": [ { "form": "变形", "label": "类型" } ],
    "morphology": [ { "part": "构词成分", "kind": "prefix|root|suffix|combining_form|abbr", "meaning": "含义,不超过6字" } ],
    "examples": ["英文例句1 — 中文翻译", "英文例句2 — 中文翻译"]
  }
}
要求:
- senses 按常用度列出最多 3 个义项；translation 等于所有 zh 用 " / " 连接
- definition 是对应义项的简洁自然英文解释,不能只是同义词,每项不超过25个英文单词
- inflections 只列不规则或值得注意的变化;规则变化返回 []
- morphology 按词中顺序排列;单纯词返回 []
- 首字母缩略词的 fullForm 给完整展开,morphology 每个字母一条且 kind 用 abbr
- 所有中文简洁,字符间不加空格`;
}

function sentencePrompt(sentence) {
  return `分析英文句子："${sentence}"。只输出 json：
{
  "translation": "地道的中文翻译",
  "analysis": {
    "structure": "高层句法结构",
    "components": [ { "role": "主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语", "text": "对应原文片段", "note": "简要说明" } ],
    "grammar_points": ["重要语法点"]
  }
}
要求:
- role 必须从给定枚举值中选取,components 按原文顺序排列
- grammar_points 聚焦学习者易忽略的点,没有则返回空数组
- 中文字符之间不要插入空格`;
}

function autoPrompt(text) {
  return `判断并分析:"${text}"。它可能是 word 单词、phrase 词组或 sentence 句子。只输出 json。

word:
{ "type":"word", "translation":"释义,/分隔最多3个", "senses":[{"zh":"中文义项","definition":"Concise English definition."}], "analysis":{ "pos":"词性", "phonetic":"音标带//", "inflections":[{"form":"变形","label":"类型"}], "morphology":[{"part":"成分","kind":"prefix|root|suffix|combining_form","meaning":"含义≤6字"}], "examples":["例句 — 翻译"] } }

phrase:
{ "type":"phrase", "translation":"整体含义,/分隔最多3个", "senses":[{"zh":"中文义项","definition":"Concise English definition."}], "analysis":{ "pos":"如 短语动词/固定搭配", "usage":"用法/可分性,≤30字", "examples":["例句 — 翻译","例句 — 翻译"] } }

sentence:
{ "type":"sentence", "translation":"地道翻译", "analysis":{ "structure":"句法结构概括", "components":[{"role":"主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语","text":"片段","note":"说明≤15字"}], "grammar_points":["语法点,最多2条≤20字"] } }

要求:
- type 必须准确,pay off 类短语动词是 phrase
- word 和 phrase 的 senses 按常用度最多3项,definition 是对应义项的简洁英文解释且不超过25词
- sentence 不返回 senses;word 的规则词形变化返回 []
- 所有中文字符间不加空格`;
}
