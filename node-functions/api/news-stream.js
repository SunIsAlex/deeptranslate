// 最新英文新闻：DeepSeek 联网搜索后以行式协议输出，服务端转换为可恢复的 SSE 事件。

const SUPPORTED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const MAX_QUERY_LENGTH = 120;
const MAX_ARTICLES = 3;
const MAX_PARAGRAPHS = 4;
const MAX_PHRASES = 6;
const MAX_GRAMMAR_POINTS = 4;

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

const INSTRUCTIONS = `You are an English-news editor and teacher for Chinese-speaking learners.
Use web search to find recent, reputable English-language news about the requested topic.
Create concise original learning digests; do not reproduce full articles or long verbatim passages.
Use only facts supported by searched sources. Never invent a URL or publication date.

Output only the following line-based protocol. Every directive and value must occupy one physical line. Do not output JSON, Markdown fences, headings, bullets, or commentary.

@@ARTICLE
@@TITLE article title
@@SOURCE publisher name
@@URL full http or https source URL
@@DATE publication date
@@SUMMARY_ZH concise Chinese summary
@@PARAGRAPH one English learning-digest paragraph
@@PHRASE English collocation ||| Chinese meaning ||| concise Chinese usage note
@@GRAMMAR grammar pattern ||| concise Chinese explanation ||| exact English example from a paragraph
@@END_ARTICLE
@@END_NEWS

Return up to 3 reports from different reputable publishers, with 2-4 paragraphs, 3-6 phrases, and 2-4 grammar points per report.
Inside paragraphs, mark important collocations with [[double square brackets]] and grammar examples with {{double braces}}.
Do not place the reserved strings @@ or ||| inside field values.`;

export async function onRequestPost(context) {
  const { request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const query = normalizeText(body.query);
  if (!query) return json({ error: "query_required" }, 400);
  if (query.length > MAX_QUERY_LENGTH) return json({ error: "query_too_long" }, 400);

  const apiKey = envValue(context, "DEEPSEEK_API_KEY");
  if (!apiKey) return json({ error: "server_not_configured" }, 500);
  const model = resolveModel(body.model, context);
  const searchedAt = new Date().toISOString();
  const abortController = new AbortController();
  request.signal?.addEventListener("abort", () => abortController.abort(), { once: true });

  let upstream;
  try {
    upstream = await fetch(
      envValue(context, "DEEPSEEK_RESPONSES_API_URL") || "https://api.deepseek.com/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: INSTRUCTIONS,
          input: [
            `Today is ${searchedAt.slice(0, 10)}.`,
            `Search topic chosen by the user: ${query}`,
            "Find the newest substantial English-language reports and output the line protocol now.",
          ].join("\n"),
          tools: [{ type: "web_search" }],
          tool_choice: { type: "web_search" },
          max_output_tokens: 12000,
          stream: true,
        }),
        signal: abortController.signal,
      },
    );
  } catch (error) {
    return json({ error: "upstream_unavailable", detail: String(error) }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail }, 502);
  }

  const responseStream = new TransformStream();
  const writer = responseStream.writable.getWriter();
  const task = pumpNewsStream({ upstream, writer, query, model, searchedAt });
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

async function pumpNewsStream({ upstream, writer, query, model, searchedAt }) {
  const encoder = new TextEncoder();
  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const protocol = createProtocolParser(async (index, article) => {
    await send("article", { index, article });
  });

  try {
    await send("meta", { query, model, searchedAt });
    await send("stage", { text: "正在联网搜索新闻来源…" });
    let generationStarted = false;

    await readResponsesStream(upstream.body, async (type, event) => {
      if (isWebSearchEvent(type, event)) {
        await send("stage", { text: "已找到来源，正在阅读和整理…" });
      }
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        if (!generationStarted) {
          generationStarted = true;
          await send("stage", { text: "正在生成英文学习摘要…" });
        }
        await protocol.push(event.delta);
      } else if (type === "response.incomplete") {
        protocol.markIncomplete();
      } else if (type === "response.failed") {
        throw new Error(event.response?.error?.message || event.error?.message || "upstream_response_failed");
      }
    });

    const articles = await protocol.finish();
    if (!articles.length) throw new Error("empty_model_output");
    await send("result", { query, searchedAt, articles, _streamed: true, _partial: protocol.incomplete });
    await send("done", {});
  } catch (error) {
    if (error?.name !== "AbortError") {
      try {
        await send("error", { error: "stream_failed", detail: String(error) });
      } catch {
        // 客户端可能已断开。
      }
    }
  } finally {
    try {
      await writer.close();
    } catch {
      // 流已取消。
    }
  }
}

async function readResponsesStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const dispatch = async () => {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      eventName = "message";
      return;
    }
    const type = data.type || data.event || eventName;
    eventName = "message";
    await onEvent(type, data);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) await dispatch();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (done) {
      if (buffer) dataLines.push(buffer);
      await dispatch();
      break;
    }
  }
}

function createProtocolParser(onArticle) {
  let lineBuffer = "";
  let current = null;
  let currentIndex = -1;
  const completed = [];
  let incomplete = false;

  const snapshot = async () => {
    if (!current?.title) return;
    await onArticle(currentIndex, cloneArticle(current));
  };

  const startArticle = async () => {
    await finalizeArticle();
    if (completed.length >= MAX_ARTICLES) {
      current = null;
      return;
    }
    currentIndex = completed.length;
    current = emptyArticle();
  };

  const finalizeArticle = async () => {
    if (!current) return;
    if (isUsableArticle(current)) {
      completed.push(cloneArticle(current));
      currentIndex = completed.length - 1;
      await onArticle(currentIndex, cloneArticle(current));
    }
    current = null;
  };

  const applyLine = async (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line === "@@ARTICLE") return startArticle();
    if (line === "@@END_ARTICLE") return finalizeArticle();
    if (line === "@@END_NEWS") return;
    if (!current) return;

    if (line.startsWith("@@TITLE ")) current.title = limitText(line.slice(8), 240);
    else if (line.startsWith("@@SOURCE ")) current.sourceName = limitText(line.slice(9), 100);
    else if (line.startsWith("@@URL ")) current.sourceUrl = safeHttpUrl(line.slice(6));
    else if (line.startsWith("@@DATE ")) current.publishedAt = limitText(line.slice(7), 40);
    else if (line.startsWith("@@SUMMARY_ZH ")) current.summaryZh = limitText(line.slice(13), 800);
    else if (line.startsWith("@@PARAGRAPH ") && current.paragraphs.length < MAX_PARAGRAPHS) {
      const paragraph = limitText(line.slice(12), 1600);
      if (paragraph) current.paragraphs.push(paragraph);
    } else if (line.startsWith("@@PHRASE ") && current.keyPhrases.length < MAX_PHRASES) {
      const [phrase, meaningZh, noteZh = ""] = splitFields(line.slice(9));
      if (phrase && meaningZh) current.keyPhrases.push({ phrase, meaningZh, noteZh });
    } else if (line.startsWith("@@GRAMMAR ") && current.grammarPoints.length < MAX_GRAMMAR_POINTS) {
      const [pattern, explanationZh, example = ""] = splitFields(line.slice(10));
      if (pattern && explanationZh) current.grammarPoints.push({ pattern, explanationZh, example });
    }
    await snapshot();
  };

  return {
    get incomplete() { return incomplete; },
    markIncomplete() { incomplete = true; },
    async push(delta) {
      lineBuffer += delta;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const line of lines) await applyLine(line.replace(/\r$/, ""));
    },
    async finish() {
      if (lineBuffer.trim()) await applyLine(lineBuffer);
      await finalizeArticle();
      return completed;
    },
  };
}

function isWebSearchEvent(type, event) {
  return type.includes("web_search") || event?.item?.type === "web_search_call";
}

function emptyArticle() {
  return {
    title: "",
    sourceName: "",
    sourceUrl: "",
    publishedAt: "",
    summaryZh: "",
    paragraphs: [],
    keyPhrases: [],
    grammarPoints: [],
  };
}

function cloneArticle(article) {
  return {
    ...article,
    paragraphs: [...article.paragraphs],
    keyPhrases: article.keyPhrases.map((item) => ({ ...item })),
    grammarPoints: article.grammarPoints.map((item) => ({ ...item })),
  };
}

function isUsableArticle(article) {
  return Boolean(article.title && article.sourceUrl && article.paragraphs.length);
}

function splitFields(value) {
  return value.split("|||").map((item) => normalizeText(item));
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function limitText(value, maxLength) {
  return normalizeText(value).slice(0, maxLength);
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
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}
