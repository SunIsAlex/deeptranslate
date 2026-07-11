// 英译中流式接口：完整译文/例句按项推送，最终发送完整 JSON。

const SYSTEM = "你是英语语言学助手。严格只输出 json，不要任何额外文字、markdown 或代码块。在 examples 例句中，把目标单词/词组实际出现的形态用 [[ ]] 括起来，只括英文部分，中文翻译里不要加。";
const SUPPORTED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

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
  const grammarAnalysis = body.grammarAnalysis !== false;
  const model = resolveModel(body.model, context);
  const apiKey = envValue(context, "DEEPSEEK_API_KEY");
  if (!apiKey) return json({ error: "server_not_configured" }, 500);

  const cached = await readEdgeCache(
    request.url,
    text,
    route,
    model,
    grammarAnalysis,
  );
  if (cached) {
    return createCachedStream(cached, text, route, model, grammarAnalysis);
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
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: promptFor(route, text, grammarAnalysis) },
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
    model,
    grammarAnalysis,
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

async function pumpModelStream({
  upstream,
  writer,
  text,
  route,
  model,
  grammarAnalysis,
  apiKey,
  requestUrl,
}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let lineBuffer = "";
  let content = "";
  let sentTranslation = false;
  let sentSenses = false;
  let sentExamples = 0;
  let pendingExamples = [];

  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  try {
    await send("meta", { route, model, grammarAnalysis, cached: false });

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

        if (!sentSenses) {
          const senses = extractJsonProperty(content, "senses");
          if (Array.isArray(senses)) {
            sentSenses = true;
            await send("senses", { items: cleanCJKSpaces(senses) });
          }
        }

        pendingExamples = extractStringArray(content, "examples");
        const streamedType = route === "auto"
          ? extractStringProperty(content, "type")
          : route;
        const maySendExamples = streamedType === "sentence"
          || ((streamedType === "word" || streamedType === "phrase") && sentSenses);
        while (maySendExamples && sentExamples < pendingExamples.length) {
          await send("example", {
            index: sentExamples,
            text: cleanCJKSpaces(pendingExamples[sentExamples]),
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
      model,
      grammarAnalysis,
      _cached: false,
      _streamed: true,
    };

    // 兜底：若模型字段顺序异常，最终解析后仍补发未发送的内容。
    if (!sentTranslation && result.translation) {
      await send("translation", { text: result.translation });
    }
    if (!sentSenses && Array.isArray(result.senses)) {
      sentSenses = true;
      await send("senses", { items: result.senses });
    }
    const finalExamples = result.analysis?.examples || [];
    while (sentExamples < finalExamples.length) {
      await send("example", { index: sentExamples, text: finalExamples[sentExamples] });
      sentExamples += 1;
    }

    await send("result", result);
    // 保持连接打开直到缓存落盘，避免响应结束后运行时提前回收。
    await writeEdgeCache(
      requestUrl,
      text,
      route,
      model,
      grammarAnalysis,
      result,
      apiKey,
    );
    await send("done", {});
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
  }
}

function createCachedStream(cached, text, route, model, grammarAnalysis) {
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
        model,
        grammarAnalysis,
        _cached: true,
        _streamed: true,
      };
      send("meta", { route, model, grammarAnalysis, cached: true });
      if (result.translation) send("translation", { text: result.translation });
      if (Array.isArray(result.senses)) send("senses", { items: result.senses });
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

async function readEdgeCache(requestUrl, text, route, model, grammarAnalysis) {
  try {
    const response = await fetch(new URL("/api/translate-cache", requestUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get",
        text,
        route,
        model,
        grammarAnalysis,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.hit ? data.result : null;
  } catch {
    return null;
  }
}

async function writeEdgeCache(
  requestUrl,
  text,
  route,
  model,
  grammarAnalysis,
  result,
  apiKey,
) {
  try {
    const response = await fetch(new URL("/api/translate-cache", requestUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cache-Token": apiKey,
      },
      body: JSON.stringify({
        action: "put",
        text,
        route,
        model,
        grammarAnalysis,
        result,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`stream cache write failed: ${response.status} ${detail}`);
    }
  } catch (error) {
    console.error("stream cache write failed:", error);
  }
}

function envValue(context, name) {
  return context.env?.[name] || process.env?.[name] || globalThis[name];
}

function resolveModel(requested, context) {
  if (SUPPORTED_MODELS.includes(requested)) return requested;
  const configured = envValue(context, "DEEPSEEK_MODEL");
  return SUPPORTED_MODELS.includes(configured) ? configured : "deepseek-v4-flash";
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

function extractJsonProperty(source, key) {
  const valueStart = findPropertyValue(source, key);
  if (valueStart < 0) return null;
  const opening = source[valueStart];
  if (opening !== "[" && opening !== "{") return null;

  const stack = [opening];
  let inString = false;
  let escaped = false;
  for (let cursor = valueStart + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      stack.push(char);
    } else if (char === "]" || char === "}") {
      const expected = char === "]" ? "[" : "{";
      if (stack.pop() !== expected) return null;
      if (!stack.length) {
        try {
          return JSON.parse(source.slice(valueStart, cursor + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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

function promptFor(route, text, grammarAnalysis) {
  if (route === "word") return wordPrompt(text);
  if (route === "sentence") return sentencePrompt(text, grammarAnalysis);
  return autoPrompt(text, grammarAnalysis);
}

function wordPrompt(word) {
  return `分析英文单词："${word}"。只输出可被 JSON.parse 直接解析的合法 JSON，不要输出 Markdown、注释或其他文字：
{
  "translation": "主要中文释义；不同含义用 / 分隔，去重后最多3项",
  "senses": [
    {
      "zh": "该词性或义项最准确、简洁的中文释义",
      "pos": "该义项的词性，如 n./v./adj./abbr.",
      "phonetics": { "uk": ["/标准英式IPA/"], "us": ["/标准美式IPA/"] },
      "definition": "A concise learner-friendly English definition."
    }
  ],
  "analysis": {
    "fullForm": "仅当输入是首字母缩略词时给出完整展开；其他情况返回空字符串",
    "inflections": [ { "form": "变形", "label": "类型，如过去式/过去分词/复数/比较级" } ],
    "morphology": [ { "part": "构词成分", "kind": "prefix|root|suffix|combining_form|abbr", "meaning": "含义，不超过6个汉字" } ],
    "examples": ["英文例句1 — 中文翻译", "英文例句2 — 中文翻译"]
  }
}
要求：
- senses 表示单词的常用词性和语义用法，按常用度排列，最多3项。
- 同一个英文单词的不同词性可以具有相同的中文释义。例如 research 的名词和动词都可以写成“研究”。
- 不得为了让不同 sense 的 zh 看起来不同，而使用较不准确的近义词、扩大词义或虚构义项。
- pos 用于区分英文单词的词性；zh 不需要为了区分词性而刻意不同。
- translation 按 senses 顺序提取 zh，对完全相同的中文释义去重，保留首次出现顺序，再用 " / " 连接。
- translation 不要求等于所有 zh 的机械连接。例如两个 sense 的 zh 都是“研究”时，translation 应为“研究”，不能写成“研究 / 研究”，也不能为了避免重复把其中一项改成“调查”。
- 一个 sense 只表示一个核心含义。若某词性下有两个接近但常见的中文对应，可在 zh 中用“；”连接，但不得超过两个。
- phonetics 必须使用规范 IPA，并分别提供英式和美式读音：
  1. uk 只填写标准英式发音，非卷舌音中不得错误加入 /r/，例如英式 research 可写 /rɪˈsɜːtʃ/，不能写 /rɪˈsɜːrtʃ/。
  2. us 只填写标准美式发音，正确表示卷舌元音，例如 research 可写 /rɪˈsɝːtʃ/。
  3. 必须标出主重音；有次重音时也应标出。
  4. 每个音标必须带一对斜杠，如 "/rɪˈsɜːtʃ/"。
  5. 每个地区最多列出2个可靠、常见的读音变体，按常用度排列。
  6. 仅列词典中公认的读音变体，不得自行根据拼写或“名词前重音、动词后重音”等概括规则推断音标。
  7. 某个词性只有一个可靠读音时只列一个，不得为了填满数组制造变体。
  8. 不同词性读音相同时可以填写相同音标。
  9. 不同词性确有重音或音素差异时，分别填写对应读音。
  10. 不得混用英式和美式音标体系。
- definition 必须准确解释当前 sense，使用自然、易懂的 CEFR B1-B2 学习型词典英语，每项不超过20个英文单词。
- definition 不得只提供一个同义词，不得使用该单词自身或直接词形变化进行循环定义。
- 动词定义优先使用直接的动词表达，不要只是把对应名词定义改写成 "to conduct..."；名词和动词含义接近时，定义可以相似，但必须符合各自语法。
- inflections 只列不规则或值得注意的曲折变化，例如 say→said、child→children、good→better/best。
- 规则变化，如直接加 -s、-ed、-ing，或没有曲折变化的词，inflections 返回 []。
- morphology 按构词成分在单词中的顺序排列。
- 接后缀产生拼写变化时，part 使用单词中实际出现的形式，例如 unbelievable 写为 un-/believ/-able。
- combining_form 用于希腊语或拉丁语来源的实义构词成分，例如 arthro-、-pod、bio-。
- 仅当输入是由字母名称逐个代表单词的首字母缩略词或首字母词，如 NATO、FBI、UNESCO 时：
  1. fullForm 给出完整英文展开式；
  2. morphology 中每个字母单独一项；
  3. kind 使用 "abbr"；
  4. meaning 填该字母代表的完整英文单词，例如 N 对应 "North"。
- 截断类缩写，如 Dr.、etc.、approx.，以及普通单词，fullForm 返回空字符串。
- 单纯词、无法可靠拆分的词，morphology 返回 []，不得强行拆词。
- examples 优先覆盖最常用的两个 sense，且必须自然体现对应词义和词性。
- 所有中文简洁，中文字符之间不添加多余空格。
- 不得输出额外字段、尾随逗号、undefined 或 NaN。`;
}

function sentencePrompt(sentence, grammarAnalysis) {
  if (!grammarAnalysis) {
    return `把英文句子翻译成地道中文："${sentence}"。只输出 json：
{ "translation": "地道的中文翻译" }
要求：不要返回语法分析或其他字段；中文字符之间不要插入空格。`;
  }
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

function autoPrompt(text, grammarAnalysis) {
  const sentenceSchema = grammarAnalysis
    ? `{ "type":"sentence", "translation":"地道翻译", "analysis":{ "structure":"句法结构概括", "components":[{"role":"主语|谓语|宾语|表语|定语|状语|补语|同位语|插入语","text":"片段","note":"说明≤15字"}], "grammar_points":["语法点,最多2条≤20字"] } }`
    : `{ "type":"sentence", "translation":"地道翻译" }`;
  return `判断并分析:"${text}"。它可能是 word 单词、phrase 词组或 sentence 句子。只输出 json。

word:
{ "type":"word", "translation":"释义,/分隔最多3个", "senses":[{"zh":"中文义项","pos":"该义项词性","phonetics":{"uk":["/英式IPA/"],"us":["/美式IPA/"]},"definition":"Concise English definition."}], "analysis":{ "inflections":[{"form":"变形","label":"类型"}], "morphology":[{"part":"成分","kind":"prefix|root|suffix|combining_form","meaning":"含义≤6字"}], "examples":["例句 — 翻译"] } }

phrase:
{ "type":"phrase", "translation":"整体含义,/分隔最多3个", "senses":[{"zh":"中文义项","pos":"该义项词性,如 短语动词/名词短语","definition":"Concise English definition."}], "analysis":{ "usage":"用法/可分性,≤30字", "examples":["例句 — 翻译","例句 — 翻译"] } }

sentence:
${sentenceSchema}

要求:
- type 必须准确,pay off 类短语动词是 phrase
- word 和 phrase 的 senses 按常用度最多3项,definition 是对应义项的简洁英文解释且不超过25词；每项 pos 必须是对应义项的词性，word 的每项 phonetics 必须分别提供规范的 uk/us IPA 数组
- sentence 不返回 senses,且${grammarAnalysis ? "必须返回 analysis 语法分析" : "只返回 type 和 translation,不要返回 analysis"}
- word 的规则词形变化返回 []
- 所有中文字符间不加空格`;
}
