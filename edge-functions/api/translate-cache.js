// Node Function 的 KV 桥接层。KV 仅能在 Edge Functions 中使用。

import {
  CORS, OPTIONS_HEADERS, json, buildCacheKey, readCache, writeCache, resolveModel,
} from "../_lib/translate-core.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, CORS);
  }

  const text = (body.text || "").trim();
  const route = body.route;
  if (!text || !["word", "sentence", "auto"].includes(route)) {
    return json({ error: "invalid_cache_key" }, 400, CORS);
  }

  const model = resolveModel(body.model, env);
  const grammarAnalysis = body.grammarAnalysis !== false;
  const variant = `${model}:${grammarAnalysis ? "grammar" : "translation"}:sense-metadata-v2`;
  const key = buildCacheKey("en2zh", route, text, variant);
  if (body.action === "get") {
    const result = await readCache(key);
    return json({ hit: Boolean(result), result }, 200, CORS);
  }

  if (body.action === "put") {
    const apiKey = env?.DEEPSEEK_API_KEY || globalThis.DEEPSEEK_API_KEY;
    const token = request.headers.get("X-Cache-Token");
    if (!apiKey || token !== apiKey) {
      return json({ error: "unauthorized" }, 401, CORS);
    }
    if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
      return json({ error: "invalid_result" }, 400, CORS);
    }
    await writeCache(key, body.result);
    return json({ ok: true }, 200, CORS);
  }

  return json({ error: "invalid_action" }, 400, CORS);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: OPTIONS_HEADERS });
}
