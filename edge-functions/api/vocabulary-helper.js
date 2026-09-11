import {
  CORS,
  OPTIONS_HEADERS,
  callModel,
  cleanCJKSpaces,
  json,
  modelMessageContent,
  parseModelObject,
} from "../_lib/translate-core.js";

const MAX_TOPIC_LENGTH = 80;
const MAX_CATEGORIES = 4;
const MAX_ITEMS_PER_CATEGORY = 5;
const DEFAULT_DIFFICULTY = "advanced";
const DIFFICULTY_INSTRUCTIONS = {
  beginner: "CEFR A1-A2. Use high-frequency everyday vocabulary and simple, direct example sentences.",
  intermediate: "CEFR B1-B2. Use practical vocabulary, common collocations, and moderately varied examples.",
  advanced: "CEFR B2-C1. Prefer precise, idiomatic, and context-specific vocabulary; avoid elementary words unless essential to the topic.",
  expert: "CEFR C1-C2. Use nuanced, sophisticated, domain-specific, and idiomatic vocabulary with natural advanced examples.",
};

const SYSTEM = `You are a vocabulary curriculum designer for Chinese-speaking English learners.
Given a topic in English or Chinese, create a practical bilingual vocabulary set for real communication.
Return strict JSON only with this shape:
{
  "topicTranslation": "Chinese translation or concise Chinese topic label",
  "categories": [
    {
      "nameEn": "Short English category name",
      "nameZh": "简短中文分类名",
      "items": [
        {
          "term": "English word or short phrase",
          "partOfSpeech": "standard short label such as n., v., adj., or phr. v.",
          "translation": "简短准确的中文释义",
          "example": "Natural English example sentence containing the term",
          "exampleTranslation": "自然准确的中文例句翻译"
        }
      ]
    }
  ]
}
Rules:
- Create exactly 4 categories that naturally fit the topic; do not use generic part-of-speech or difficulty categories.
- Create exactly 5 distinct, useful items per category (20 items total).
- Include a balanced mix of words, collocations, and short phrases where appropriate.
- Follow the requested CEFR level closely in both vocabulary choice and examples.
- Do not repeat a term across categories.
- English terms must use lowercase unless they contain a proper noun.
- Return JSON only, with no markdown or commentary.`;

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, CORS);
  }

  const topic = normalizeText(body.topic);
  if (!topic) return json({ error: "topic_required" }, 400, CORS);
  if (topic.length > MAX_TOPIC_LENGTH) {
    return json({ error: "topic_too_long" }, 400, CORS);
  }
  const difficulty = body.difficulty === undefined || body.difficulty === ""
    ? DEFAULT_DIFFICULTY
    : String(body.difficulty);
  if (!Object.hasOwn(DIFFICULTY_INSTRUCTIONS, difficulty)) {
    return json({ error: "invalid_difficulty" }, 400, CORS);
  }
  if (!envValue(env, "DEEPSEEK_API_KEY")) {
    return json({ error: "server_not_configured" }, 500, CORS);
  }

  let upstream;
  try {
    const prompt = [
      `Topic: ${topic}`,
      `Target difficulty: ${DIFFICULTY_INSTRUCTIONS[difficulty]}`,
    ].join("\n");
    upstream = await callModel(prompt, env, SYSTEM, body.model);
  } catch (error) {
    return json({ error: "upstream_unavailable", detail: String(error) }, 502, CORS);
  }
  if (!upstream.ok) {
    const detail = await upstream.text();
    return json({ error: "upstream_error", status: upstream.status, detail }, 502, CORS);
  }

  let data;
  try {
    const raw = await upstream.json();
    data = parseModelObject(modelMessageContent(raw));
  } catch (error) {
    return json({ error: "bad_model_json", detail: String(error) }, 502, CORS);
  }
  if (!data) return json({ error: "bad_model_json" }, 502, CORS);

  const categories = normalizeCategories(data.categories);
  if (!categories.length) return json({ error: "empty_model_result" }, 502, CORS);

  return json(cleanCJKSpaces({
    topic,
    topicTranslation: limitText(data.topicTranslation, 80),
    difficulty,
    categories,
  }), 200, CORS);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: OPTIONS_HEADERS });
}

function normalizeCategories(value) {
  if (!Array.isArray(value)) return [];
  const seenTerms = new Set();
  const categories = [];

  for (const category of value) {
    const nameEn = limitText(category?.nameEn, 60);
    const nameZh = limitText(category?.nameZh, 60);
    if (!nameEn && !nameZh) continue;

    const items = [];
    for (const item of Array.isArray(category?.items) ? category.items : []) {
      const term = limitText(item?.term, MAX_TOPIC_LENGTH);
      const key = term.toLowerCase();
      if (!term || seenTerms.has(key)) continue;

      const translation = limitText(item?.translation, 100);
      const example = limitText(item?.example, 300);
      if (!translation || !example) continue;

      seenTerms.add(key);
      items.push({
        term,
        partOfSpeech: limitText(item?.partOfSpeech, 30),
        translation,
        example,
        exampleTranslation: limitText(item?.exampleTranslation, 300),
      });
      if (items.length >= MAX_ITEMS_PER_CATEGORY) break;
    }

    if (!items.length) continue;
    categories.push({ nameEn, nameZh, items });
    if (categories.length >= MAX_CATEGORIES) break;
  }

  return categories;
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
