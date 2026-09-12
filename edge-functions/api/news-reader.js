import {
  CORS,
  OPTIONS_HEADERS,
  cleanCJKSpaces,
  json,
  parseModelObject,
  resolveModel,
} from "../_lib/translate-core.js";

const MAX_QUERY_LENGTH = 120;
const MAX_ARTICLES = 3;
const MAX_PARAGRAPHS = 4;
const MAX_PHRASES = 6;
const MAX_GRAMMAR_POINTS = 4;

const INSTRUCTIONS = `You are an English-news editor and teacher for Chinese-speaking learners.
Use web search to find recent, reputable English-language news about the requested topic.
Create concise original learning digests; do not reproduce full articles or long verbatim passages.
Use only facts supported by the searched sources, and never invent a source URL or publication date.
In each English paragraph, mark important collocations with [[double square brackets]] and grammar examples with {{double braces}}.
Every marked collocation must appear in keyPhrases, and every marked grammar example must be explained in grammarPoints.
Return the requested JSON schema only.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          sourceName: { type: "string" },
          sourceUrl: { type: "string" },
          publishedAt: { type: "string" },
          summaryZh: { type: "string" },
          paragraphs: {
            type: "array",
            items: { type: "string" },
          },
          keyPhrases: {
            type: "array",
            items: {
              type: "object",
              properties: {
                phrase: { type: "string" },
                meaningZh: { type: "string" },
                noteZh: { type: "string" },
              },
              required: ["phrase", "meaningZh", "noteZh"],
              additionalProperties: false,
            },
          },
          grammarPoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                pattern: { type: "string" },
                explanationZh: { type: "string" },
                example: { type: "string" },
              },
              required: ["pattern", "explanationZh", "example"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "title", "sourceName", "sourceUrl", "publishedAt", "summaryZh",
          "paragraphs", "keyPhrases", "grammarPoints",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["articles"],
  additionalProperties: false,
};

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, CORS);
  }

  const query = normalizeText(body.query);
  if (!query) return json({ error: "query_required" }, 400, CORS);
  if (query.length > MAX_QUERY_LENGTH) {
    return json({ error: "query_too_long" }, 400, CORS);
  }

  const apiKey = envValue(env, "DEEPSEEK_API_KEY");
  if (!apiKey) return json({ error: "server_not_configured" }, 500, CORS);

  const searchedAt = new Date().toISOString();
  const prompt = [
    `Today is ${searchedAt.slice(0, 10)}.`,
    `Search topic chosen by the user: ${query}`,
    `Return up to ${MAX_ARTICLES} of the newest substantial reports from different reputable publishers.`,
    "Write 2-4 short English learning-digest paragraphs per report, plus Chinese summary, key collocations, and grammar explanations.",
  ].join("\n");

  let upstream;
  try {
    upstream = await requestResponses(env, apiKey, {
      model: resolveModel(body.model, env),
      instructions: INSTRUCTIONS,
      input: prompt,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: 12000,
      text: responseTextFormat(),
    });
  } catch (error) {
    return json({ error: "upstream_unavailable", detail: String(error) }, 502, CORS);
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail }, 502, CORS);
  }

  let raw;
  try {
    raw = await upstream.json();
  } catch (error) {
    return json({ error: "bad_model_json", detail: String(error) }, 502, CORS);
  }

  let modelResult = parseResponseObject(raw);
  if (!modelResult) {
    const repaired = await repairSearchResponse({
      env,
      apiKey,
      model: resolveModel(body.model, env),
      prompt,
      searchResponse: raw,
    });
    if (repaired.errorResponse) return repaired.errorResponse;
    modelResult = parseResponseObject(repaired.raw);
    if (!modelResult) {
      return json({
        error: "bad_model_json",
        upstreamStatus: repaired.raw?.status || raw?.status || "unknown",
        outputTypes: responseOutputTypes(repaired.raw || raw),
      }, 502, CORS);
    }
  }

  const articles = normalizeArticles(modelResult.articles);
  if (!articles.length) return json({ error: "empty_search_result" }, 502, CORS);

  return json(cleanCJKSpaces({ query, searchedAt, articles }), 200, CORS);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: OPTIONS_HEADERS });
}

function parseResponseObject(data) {
  const directObjects = [];
  const textCandidates = [];
  if (typeof data?.output_text === "string") textCandidates.push(data.output_text);

  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== "message") continue;
    const messageParts = [];
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.json && typeof part.json === "object" && !Array.isArray(part.json)) {
        directObjects.push(part.json);
      }
      if (typeof part?.text === "string") {
        textCandidates.push(part.text);
        messageParts.push(part.text);
      }
    }
    if (messageParts.length > 1) textCandidates.push(messageParts.join(""));
  }

  for (const candidate of directObjects.reverse()) {
    if (candidate && typeof candidate === "object") return candidate;
  }
  for (const candidate of textCandidates.reverse()) {
    const parsed = parseModelObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

async function repairSearchResponse({ env, apiKey, model, prompt, searchResponse }) {
  const contextItems = (Array.isArray(searchResponse?.output) ? searchResponse.output : [])
    .filter((item) => item?.type === "message" || item?.type === "web_search_call");
  const input = [
    { role: "user", content: prompt },
    ...contextItems,
    {
      role: "user",
      content: "Using the web-search results above, return the complete news digest again as valid JSON matching the required schema. Do not search again and do not add markdown fences.",
    },
  ];

  let upstream;
  try {
    upstream = await requestResponses(env, apiKey, {
      model,
      instructions: INSTRUCTIONS,
      input,
      tool_choice: "none",
      max_output_tokens: 12000,
      text: responseTextFormat(),
    });
  } catch (error) {
    return {
      errorResponse: json({ error: "upstream_unavailable", detail: String(error) }, 502, CORS),
    };
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return {
      errorResponse: json({
        error: "upstream_error",
        phase: "repair",
        status: upstream.status,
        detail,
      }, 502, CORS),
    };
  }

  try {
    return { raw: await upstream.json() };
  } catch (error) {
    return {
      errorResponse: json({ error: "bad_model_json", phase: "repair", detail: String(error) }, 502, CORS),
    };
  }
}

function requestResponses(env, apiKey, payload) {
  return fetch(responsesApiUrl(env), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    eo: { timeoutSetting: { connectTimeout: 5000, readTimeout: 120000, writeTimeout: 5000 } },
  });
}

function responseTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "english_news_digest",
      strict: true,
      schema: RESPONSE_SCHEMA,
    },
  };
}

function responseOutputTypes(data) {
  return [...new Set((Array.isArray(data?.output) ? data.output : [])
    .map((item) => String(item?.type || "unknown")))]
    .slice(0, 10);
}

function normalizeArticles(value) {
  if (!Array.isArray(value)) return [];
  const articles = [];
  const seenUrls = new Set();

  for (const item of value) {
    const sourceUrl = safeHttpUrl(item?.sourceUrl);
    if (!sourceUrl || seenUrls.has(sourceUrl)) continue;
    const title = limitText(item?.title, 240);
    const paragraphs = normalizeStrings(item?.paragraphs, MAX_PARAGRAPHS, 1600);
    if (!title || !paragraphs.length) continue;

    seenUrls.add(sourceUrl);
    articles.push({
      title,
      sourceName: limitText(item?.sourceName, 100),
      sourceUrl,
      publishedAt: limitText(item?.publishedAt, 40),
      summaryZh: limitText(item?.summaryZh, 800),
      paragraphs,
      keyPhrases: normalizeObjects(item?.keyPhrases, MAX_PHRASES, (phrase) => ({
        phrase: limitText(phrase?.phrase, 120),
        meaningZh: limitText(phrase?.meaningZh, 200),
        noteZh: limitText(phrase?.noteZh, 400),
      }), ["phrase", "meaningZh"]),
      grammarPoints: normalizeObjects(item?.grammarPoints, MAX_GRAMMAR_POINTS, (point) => ({
        pattern: limitText(point?.pattern, 160),
        explanationZh: limitText(point?.explanationZh, 500),
        example: limitText(point?.example, 500),
      }), ["pattern", "explanationZh"]),
    });
    if (articles.length >= MAX_ARTICLES) break;
  }

  return articles;
}

function normalizeObjects(value, maxItems, mapper, requiredKeys) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value) {
    const item = mapper(raw);
    if (requiredKeys.some((key) => !item[key])) continue;
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeStrings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => limitText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function responsesApiUrl(env) {
  return envValue(env, "DEEPSEEK_RESPONSES_API_URL") || "https://api.deepseek.com/responses";
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function limitText(value, maxLength) {
  return normalizeText(value).slice(0, maxLength);
}

function envValue(env, name) {
  return env?.[name] || globalThis[name];
}
