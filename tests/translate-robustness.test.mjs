import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCompletedStringProperty,
  modelMessageContent,
  parseModelObject,
} from "../edge-functions/_lib/translate-core.js";
import { onRequestPost as translateEn } from "../edge-functions/api/translate.js";
import { onRequestPost as translateZh } from "../edge-functions/api/translate-zh.js";

test("parseModelObject accepts fences and surrounding text", () => {
  const content = [
    "以下是结果：",
    "```json",
    '{"translation":"带 } 字符的译文","analysis":{"grammar_points":[]}}',
    "```",
    "请查收。",
  ].join("\n");

  assert.deepEqual(parseModelObject(content), {
    translation: "带 } 字符的译文",
    analysis: { grammar_points: [] },
  });
});

test("only extracts a completed translation from truncated JSON", () => {
  const truncated = '{"translation":"完整译文","analysis":{"structure":"未闭合';
  assert.equal(parseModelObject(truncated), null);
  assert.equal(extractCompletedStringProperty(truncated, "translation"), "完整译文");
  assert.equal(
    parseModelObject('{"translation":"完整译文","analysis":{"structure":"内部已闭合"}'),
    null,
    "must not mistake a nested object for the top-level result",
  );
  assert.equal(
    extractCompletedStringProperty('{"translation":"未闭合', "translation"),
    null,
  );
});

test("normalizes array-form model content", () => {
  const data = {
    choices: [{
      message: {
        content: [{ text: '{"translation":' }, { text: '"译文"}' }],
      },
    }],
  };
  assert.equal(modelMessageContent(data), '{"translation":"译文"}');
});

test("retries a truncated long-sentence response with a compact prompt", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    modelResponse('{"translation":"首次译文","analysis":{"structure":"截断', "length"),
    modelResponse('{"translation":"重试译文","analysis":{"structure":"主从复合句","components":[],"grammar_points":[]}}'),
  ];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return responses.shift();
  };

  try {
    const response = await translateEn({
      request: translationRequest("A long sentence that contains several clauses and needs analysis."),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.translation, "重试译文");
    assert.equal(result._recovered, true);
    assert.equal(result._degraded, undefined);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_tokens, 8192);
    assert.match(requests[1].messages[1].content, /components 最多 8 项/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a completed translation instead of 502 when both analyses are truncated", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    modelResponse('{"translation":"首次完整译文","analysis":{"structure":"截断', "length"),
    modelResponse('{"translation":"重试完整译文","analysis":{"structure":"仍截断', "length"),
  ];

  globalThis.fetch = async () => responses.shift();

  try {
    const response = await translateEn({
      request: translationRequest("Another sufficiently long sentence with multiple clauses."),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.translation, "重试完整译文");
    assert.equal(result.type, "sentence");
    assert.equal(result._recovered, true);
    assert.equal(result._degraded, true);
    assert.equal(result.analysis, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovers a truncated Chinese-to-English sentence response", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    modelResponse('{"type":"sentence","translations":[{"en":"The first complete translation.","note":"截断'),
    modelResponse('{"type":"sentence","translations":[{"en":"The recovered translation."}]}'),
  ];

  globalThis.fetch = async () => responses.shift();

  try {
    const response = await translateZh({
      request: new Request("https://translate.sunisalex.org/api/translate-zh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "这是一个包含多个从句、需要完整翻译而不能在中途截断的中文长句。",
          model: "deepseek-v4-flash",
        }),
      }),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.translations[0].en, "The recovered translation.");
    assert.equal(result._recovered, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function modelResponse(content, finishReason = "stop") {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: finishReason,
      message: { content },
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function translationRequest(text) {
  return new Request("https://translate.sunisalex.org/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      mode: "sentence",
      grammarAnalysis: true,
      model: "deepseek-v4-flash",
    }),
  });
}
