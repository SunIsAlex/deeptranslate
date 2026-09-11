import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "../edge-functions/api/vocabulary-helper.js";
import {
  loadVocabulary,
  upsertVocabularyEntries,
  upsertVocabularyEntry,
} from "../js/vocabulary.js";

test("vocabulary helper accepts a Chinese topic and normalizes model output", async () => {
  const originalFetch = globalThis.fetch;
  let modelRequest;
  const categories = Array.from({ length: 5 }, (_, categoryIndex) => ({
    nameEn: ` Category ${categoryIndex + 1} `,
    nameZh: ` 分类 ${categoryIndex + 1} `,
    items: Array.from({ length: 6 }, (_, itemIndex) => ({
      term: categoryIndex === 1 && itemIndex === 0 ? "term 1-1" : ` term ${categoryIndex + 1}-${itemIndex + 1} `,
      partOfSpeech: " n. ",
      translation: ` 释义 ${itemIndex + 1} `,
      example: ` Use term ${categoryIndex + 1}-${itemIndex + 1} safely. `,
      exampleTranslation: ` 安全地使用词条 ${categoryIndex + 1}-${itemIndex + 1}。 `,
    })),
  }));

  globalThis.fetch = async (_url, init) => {
    modelRequest = JSON.parse(init.body);
    return modelResponse(`\n\`\`\`json\n${JSON.stringify({
      topicTranslation: " 网络安全 ",
      categories,
    })}\n\`\`\``);
  };

  try {
    const response = await onRequestPost({
      request: helperRequest("  网络   安全  "),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.topic, "网络安全");
    assert.equal(result.topicTranslation, "网络安全");
    assert.equal(result.difficulty, "advanced");
    assert.equal(result.categories.length, 4);
    assert.equal(result.categories[0].items.length, 5);
    assert.equal(result.categories[1].items.length, 5);
    assert.equal(result.categories[0].items[0].term, "term 1-1");
    assert.equal(result.categories[0].items[0].translation, "释义 1");
    assert.equal(modelRequest.model, "deepseek-v4-flash");
    assert.match(modelRequest.messages[0].content, /exactly 4 categories/);
    assert.match(modelRequest.messages[1].content, /CEFR B2-C1/);
    assert.match(modelRequest.messages[1].content, /avoid elementary words/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vocabulary helper validates requests and empty model results", async () => {
  const missingResponse = await onRequestPost({
    request: helperRequest(""),
    env: { DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(missingResponse.status, 400);
  assert.equal((await missingResponse.json()).error, "topic_required");

  const longResponse = await onRequestPost({
    request: helperRequest("x".repeat(81)),
    env: { DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(longResponse.status, 400);
  assert.equal((await longResponse.json()).error, "topic_too_long");

  const invalidDifficultyResponse = await onRequestPost({
    request: helperRequest("fitness", "impossible"),
    env: { DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(invalidDifficultyResponse.status, 400);
  assert.equal((await invalidDifficultyResponse.json()).error, "invalid_difficulty");

  const unconfiguredResponse = await onRequestPost({
    request: helperRequest("fitness"),
    env: {},
  });
  assert.equal(unconfiguredResponse.status, 500);
  assert.equal((await unconfiguredResponse.json()).error, "server_not_configured");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => modelResponse('{"categories":[]}');
  try {
    const emptyResponse = await onRequestPost({
      request: helperRequest("fitness"),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    assert.equal(emptyResponse.status, 502);
    assert.equal((await emptyResponse.json()).error, "empty_model_result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vocabulary helper maps upstream failures to a 502 response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    const response = await onRequestPost({
      request: helperRequest("fitness"),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.equal(result.error, "upstream_error");
    assert.equal(result.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("batch vocabulary writes preserve topic details, dedupe, and old entries", () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  storage.setItem("deeptranslate:vocabulary:v1", JSON.stringify([{
    term: "legacy",
    translation: "旧词条",
    source: "search",
  }]));

  upsertVocabularyEntries([
    {
      term: "work out",
      translation: "锻炼",
      topic: "fitness",
      category: "训练 / Training",
      partOfSpeech: "phr. v.",
      example: "I work out three times a week.",
      exampleTranslation: "我每周锻炼三次。",
      source: "topic",
    },
    { term: "WORK OUT", translation: "健身", source: "topic" },
    { term: "cardio", translation: "有氧运动", source: "topic" },
  ]);
  upsertVocabularyEntry({ term: "legacy", note: "仍然兼容" });

  const items = loadVocabulary();
  assert.equal(items.length, 3);
  const workout = items.find((item) => item.term.toLowerCase() === "work out");
  assert.equal(workout.translation, "锻炼");
  assert.equal(workout.topic, "fitness");
  assert.equal(workout.exampleTranslation, "我每周锻炼三次。");
  assert.equal(items.find((item) => item.term === "legacy").note, "仍然兼容");
});

test("batch vocabulary writes enforce the 500-item limit", () => {
  globalThis.localStorage = memoryStorage();
  upsertVocabularyEntries(Array.from({ length: 510 }, (_, index) => ({
    term: `term-${index}`,
    translation: `释义-${index}`,
  })));
  const items = loadVocabulary();
  assert.equal(items.length, 500);
  assert.equal(items[0].term, "term-0");
  assert.equal(items[499].term, "term-499");
});

function helperRequest(topic, difficulty = "advanced") {
  return new Request("https://translate.sunisalex.org/api/vocabulary-helper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, difficulty, model: "deepseek-v4-flash" }),
  });
}

function modelResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
