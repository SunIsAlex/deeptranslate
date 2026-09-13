import test from "node:test";
import assert from "node:assert/strict";

import { fetchLatestNews } from "../js/api.js";

test("browser news API consumes progressive SSE events", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  const resultData = { query: "AI", searchedAt: "2026-09-13T00:00:00Z", articles: [] };
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/news-stream");
    return sseResponse([
      ["meta", { query: "AI", searchedAt: resultData.searchedAt }],
      ["stage", { text: "正在搜索" }],
      ["article", { index: 0, article: { title: "Partial" } }],
      ["result", resultData],
      ["done", {}],
    ]);
  };

  try {
    const result = await fetchLatestNews({
      query: "AI",
      model: "deepseek-v4-flash",
      onEvent(event, data) { seen.push([event, data]); },
    });
    assert.deepEqual(result, resultData);
    assert.deepEqual(seen.map(([event]) => event), ["meta", "stage", "article", "result", "done"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser news API falls back to JSON when streaming is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const events = [];
  const resultData = { query: "AI", searchedAt: "2026-09-13T00:00:00Z", articles: [] };
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === "/api/news-stream") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(resultData), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await fetchLatestNews({
      query: "AI",
      model: "deepseek-v4-flash",
      onEvent(event, data) { events.push([event, data]); },
    });
    assert.deepEqual(result, resultData);
    assert.deepEqual(calls, ["/api/news-stream", "/api/news-reader"]);
    assert.equal(events[0][0], "fallback");
    assert.match(events[0][1].detail, /not_found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function sseResponse(events) {
  const text = events.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  ).join("");
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
