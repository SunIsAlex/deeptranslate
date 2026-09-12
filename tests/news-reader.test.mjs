import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "../edge-functions/api/news-reader.js";
import { parseNewsHighlights } from "../js/news.js";

test("news reader forces web search and normalizes sourced learning digests", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let modelRequest;
  const articles = [
    article({ sourceUrl: "javascript:alert(1)", title: "Unsafe" }),
    article({ sourceUrl: "https://example.com/news/one", title: "First report", itemCount: 8 }),
    article({ sourceUrl: "https://example.com/news/one", title: "Duplicate report" }),
    article({ sourceUrl: "https://news.example.org/two", title: "Second report" }),
    article({ sourceUrl: "https://third.example.net/story", title: "Third report" }),
    article({ sourceUrl: "https://fourth.example.net/story", title: "Fourth report" }),
  ];

  globalThis.fetch = async (url, init) => {
    requestUrl = url;
    modelRequest = JSON.parse(init.body);
    return responsesApiResult(JSON.stringify({ articles }));
  };

  try {
    const response = await onRequestPost({
      request: newsRequest("  artificial   intelligence  "),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://api.deepseek.com/responses");
    assert.deepEqual(modelRequest.tools, [{ type: "web_search" }]);
    assert.deepEqual(modelRequest.tool_choice, { type: "web_search" });
    assert.equal(modelRequest.text.format.type, "json_schema");
    assert.equal(modelRequest.text.format.strict, true);
    assert.doesNotMatch(JSON.stringify(modelRequest.text.format.schema), /minItems|maxItems/);
    assert.match(modelRequest.input, /artificial intelligence/);
    assert.match(modelRequest.input, /Today is \d{4}-\d{2}-\d{2}/);
    assert.equal(result.query, "artificial intelligence");
    assert.equal(result.articles.length, 3);
    assert.equal(result.articles[0].title, "First report");
    assert.equal(result.articles[0].paragraphs.length, 4);
    assert.equal(result.articles[0].keyPhrases.length, 6);
    assert.equal(result.articles[0].grammarPoints.length, 4);
    assert.match(result.articles[0].sourceUrl, /^https:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news reader validates input and reports upstream failures", async () => {
  const empty = await onRequestPost({
    request: newsRequest(""),
    env: { DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "query_required");

  const tooLong = await onRequestPost({
    request: newsRequest("x".repeat(121)),
    env: { DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error, "query_too_long");

  const missingKey = await onRequestPost({ request: newsRequest("technology"), env: {} });
  assert.equal(missingKey.status, 500);
  assert.equal((await missingKey.json()).error, "server_not_configured");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  try {
    const failed = await onRequestPost({
      request: newsRequest("technology"),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await failed.json();
    assert.equal(failed.status, 502);
    assert.equal(result.error, "upstream_error");
    assert.equal(result.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news reader scans every output message instead of trusting the first text", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Search completed." }] },
        { type: "web_search_call", id: "search-1", status: "completed", action: { type: "search", query: "AI" } },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify({
          articles: [article({ sourceUrl: "https://example.com/final", title: "Final report" })],
        }) }] },
      ],
    });
  };

  try {
    const response = await onRequestPost({
      request: newsRequest("AI"),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.articles[0].title, "Final report");
    assert.equal(calls, 1, "a parseable later message should not trigger repair");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news reader repairs malformed output using the existing web-search context", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    jsonResponse({
      status: "completed",
      output: [
        { type: "web_search_call", id: "search-1", status: "completed", action: { type: "search", query: "climate" } },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"articles":[' }] },
      ],
    }),
    responsesApiResult(JSON.stringify({
      articles: [article({ sourceUrl: "https://example.com/repaired", title: "Repaired report" })],
    })),
  ];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return responses.shift();
  };

  try {
    const response = await onRequestPost({
      request: newsRequest("climate"),
      env: { DEEPSEEK_API_KEY: "test-key" },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.articles[0].title, "Repaired report");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].tool_choice, "none");
    assert.equal(requests[1].tools, undefined);
    assert.ok(requests[1].input.some((item) => item.type === "web_search_call"));
    assert.match(requests[1].input.at(-1).content, /valid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news highlight parser separates phrases and grammar without producing HTML", () => {
  assert.deepEqual(
    parseNewsHighlights("Officials [[rolled out]] rules that {{are expected to reduce fraud}}."),
    [
      { type: "text", text: "Officials " },
      { type: "phrase", text: "rolled out" },
      { type: "text", text: " rules that " },
      { type: "grammar", text: "are expected to reduce fraud" },
      { type: "text", text: "." },
    ],
  );
  assert.deepEqual(parseNewsHighlights("<script>alert(1)</script>"), [
    { type: "text", text: "<script>alert(1)</script>" },
  ]);
});

function article({ sourceUrl, title, itemCount = 3 }) {
  return {
    title,
    sourceName: "Example News",
    sourceUrl,
    publishedAt: "2026-09-11",
    summaryZh: "这是一则新闻摘要。",
    paragraphs: Array.from({ length: itemCount }, (_, index) =>
      `The company [[rolled out]] update ${index + 1}, which {{is expected to improve safety}}.`,
    ),
    keyPhrases: Array.from({ length: itemCount }, (_, index) => ({
      phrase: `roll out ${index + 1}`,
      meaningZh: "推出",
      noteZh: "常用于产品或政策发布。",
    })),
    grammarPoints: Array.from({ length: itemCount }, (_, index) => ({
      pattern: `be expected to ${index + 1}`,
      explanationZh: "表示预期会发生。",
      example: "It is expected to improve safety.",
    })),
  };
}

function newsRequest(query) {
  return new Request("https://translate.sunisalex.org/api/news-reader", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, model: "deepseek-v4-flash" }),
  });
}

function responsesApiResult(text) {
  return jsonResponse({
    output: [{
      type: "message",
      content: [{ type: "output_text", text }],
    }],
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
