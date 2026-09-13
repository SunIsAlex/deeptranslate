import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "../node-functions/api/news-stream.js";

test("news stream converts fragmented line protocol into progressive SSE articles", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  globalThis.fetch = async (_url, init) => {
    upstreamRequest = JSON.parse(init.body);
    return responsesStream([
      upstreamEvent("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "web_search_call" },
      }),
      outputDelta("@@ARTICLE\n@@TITLE AI safety rules take effect\n@@SOURCE Example News\n@@URL https://example.com/ai"),
      outputDelta("-safety\n@@DATE 2026-09-12\n@@SUMMARY_ZH 新的人工智能安全规定开始生效。\n"),
      outputDelta("@@PARAGRAPH Regulators [[rolled out]] rules that {{are expected to improve safety}}.\n"),
      outputDelta("@@PHRASE roll out ||| 推出 ||| 常用于政策或产品发布。\n"),
      outputDelta("@@GRAMMAR be expected to ||| 表示预期发生。 ||| are expected to improve safety\n@@END_ARTICLE\n@@END_NEWS\n"),
      upstreamEvent("response.completed", { type: "response.completed", response: { status: "completed" } }),
    ]);
  };

  try {
    const response = await onRequestPost(contextFor("AI safety"));
    const events = parseSse(await response.text());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
    assert.equal(upstreamRequest.stream, true);
    assert.deepEqual(upstreamRequest.tools, [{ type: "web_search" }]);
    assert.equal(upstreamRequest.text, undefined, "the model should emit line protocol rather than JSON");
    assert.ok(events.some((item) => item.event === "stage" && /来源/.test(item.data.text)));

    const articleEvents = events.filter((item) => item.event === "article");
    assert.ok(articleEvents.length >= 3, "article snapshots should arrive progressively");
    const result = events.find((item) => item.event === "result").data;
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, "AI safety rules take effect");
    assert.equal(result.articles[0].sourceUrl, "https://example.com/ai-safety");
    assert.match(result.articles[0].paragraphs[0], /\[\[rolled out\]\]/);
    assert.equal(result.articles[0].keyPhrases[0].meaningZh, "推出");
    assert.equal(result.articles[0].grammarPoints[0].pattern, "be expected to");
    assert.equal(result._partial, false);
    assert.equal(events.at(-1).event, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news stream preserves a usable partial article when the model is incomplete", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responsesStream([
    outputDelta([
      "@@ARTICLE",
      "@@TITLE Climate report",
      "@@SOURCE Example",
      "@@URL https://example.com/climate",
      "@@DATE 2026-09-12",
      "@@SUMMARY_ZH 气候报告摘要。",
      "@@PARAGRAPH Scientists [[called for]] faster action.",
    ].join("\n")),
    upstreamEvent("response.incomplete", { type: "response.incomplete", response: { status: "incomplete" } }),
  ]);

  try {
    const response = await onRequestPost(contextFor("climate"));
    const events = parseSse(await response.text());
    const result = events.find((item) => item.event === "result").data;
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0].title, "Climate report");
    assert.equal(result._partial, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news stream validates requests before contacting the model", async () => {
  const empty = await onRequestPost(contextFor(""));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "query_required");

  const tooLong = await onRequestPost(contextFor("x".repeat(121)));
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error, "query_too_long");

  const missingKey = await onRequestPost(contextFor("technology", {}));
  assert.equal(missingKey.status, 500);
  assert.equal((await missingKey.json()).error, "server_not_configured");
});

function contextFor(query, env = { DEEPSEEK_API_KEY: "test-key" }) {
  return {
    request: new Request("https://translate.sunisalex.org/api/news-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, model: "deepseek-v4-flash" }),
    }),
    env,
    waitUntil() {},
  };
}

function responsesStream(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      events.forEach((event) => controller.enqueue(encoder.encode(event)));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function outputDelta(delta) {
  return upstreamEvent("response.output_text.delta", {
    type: "response.output_text.delta",
    delta,
  });
}

function upstreamEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSse(text) {
  return text.trim().split("\n\n").map((block) => {
    let event = "message";
    const data = [];
    block.split("\n").forEach((line) => {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    });
    return { event, data: JSON.parse(data.join("\n")) };
  });
}
