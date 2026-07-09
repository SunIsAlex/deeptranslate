import {
  CORS,
  OPTIONS_HEADERS,
  callModel,
  cleanCJKSpaces,
  json,
  stripFences,
} from "../_lib/translate-core.js";

const MAX_INPUT_LENGTH = 80;
const MAX_CONTEXT_LENGTH = 12000;
const MAX_ITEMS = 12;

const SYSTEM = `You are an English vocabulary assistant for Chinese-speaking learners.
Given an English word or short phrase and optional translation context, return related vocabulary that is useful for memorization.
Include a balanced mix of synonyms, antonyms, word-family forms, and closely related collocations when appropriate.
Return strict JSON only with this shape:
{
  "items": [
    {
      "term": "English word or short phrase",
      "relation": "synonym | antonym | word_family | phrase | related",
      "translation": "简短中文释义",
      "note": "简短中文说明"
    }
  ]
}
Rules:
- Do not include the original input as an item.
- Use lowercase for ordinary English words unless the term is a proper noun.
- Keep terms concise and practical.
- Return at most 12 items.
- If the input is not suitable for vocabulary expansion, return {"items":[]}.`;

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, CORS);
  }

  const input = String(body.input || "").replace(/\s+/g, " ").trim();
  if (!input) return json({ error: "input_required" }, 400, CORS);
  if (input.length > MAX_INPUT_LENGTH) {
    return json({ error: "input_too_long" }, 400, CORS);
  }
  if (!envValue(env, "DEEPSEEK_API_KEY")) {
    return json({ error: "server_not_configured" }, 500, CORS);
  }

  const contextJson = body.context && typeof body.context === "object"
    ? JSON.stringify(body.context).slice(0, MAX_CONTEXT_LENGTH)
    : "";
  const prompt = [
    `Input: ${input}`,
    contextJson ? `Translation context JSON:\n${contextJson}` : "",
  ].filter(Boolean).join("\n\n");

  const upstream = await callModel(prompt, env, SYSTEM, body.model);
  if (!upstream.ok) {
    const detail = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail }, 502, CORS);
  }

  let data;
  try {
    const raw = await upstream.json();
    const content = raw?.choices?.[0]?.message?.content || "{}";
    data = JSON.parse(stripFences(content));
  } catch (error) {
    return json({ error: "bad_model_json", detail: String(error) }, 502, CORS);
  }

  return json(cleanCJKSpaces({ items: normalizeItems(data.items, input) }), 200, CORS);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: OPTIONS_HEADERS });
}

function normalizeItems(value, input) {
  if (!Array.isArray(value)) return [];
  const original = input.toLowerCase();
  const seen = new Set([original]);
  const allowedRelations = new Set(["synonym", "antonym", "word_family", "phrase", "related"]);
  const items = [];

  for (const item of value) {
    const term = String(item?.term || "").replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key) || term.length > MAX_INPUT_LENGTH) continue;
    seen.add(key);
    items.push({
      term,
      relation: allowedRelations.has(item?.relation) ? item.relation : "related",
      translation: String(item?.translation || "").trim().slice(0, 80),
      note: String(item?.note || "").trim().slice(0, 120),
    });
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

function envValue(env, name) {
  return env?.[name] || globalThis[name];
}
