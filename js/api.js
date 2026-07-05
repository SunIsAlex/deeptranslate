// 翻译方向判断与后端请求

// 根据输入是否含中文判断翻译方向
export function detectDirection(text) {
  return /[一-龥]/.test(text) ? "zh2en" : "en2zh";
}

/**
 * 发起翻译请求。
 * @param {string} text 输入文本
 * @param {string} mode 分析模式（仅 en2zh 使用）
 * @param {(line: string) => void} onStage 各阶段加载日志回调
 * @param {(event: string, data: any) => void} [onEvent] 流式事件回调
 * @param {{grammarAnalysis?: boolean, model?: string}} [settings] 翻译选项
 * @returns {Promise<{res: Response, data: any, direction: string, total: number}>}
 */
export async function translate(text, mode, onStage, onEvent, settings = {}) {
  const direction = detectDirection(text);
  if (direction === "en2zh" && typeof ReadableStream !== "undefined") {
    try {
      return await translateStream(text, mode, settings, onStage, onEvent);
    } catch (error) {
      onStage(`> stream unavailable: ${error.message}`);
      onStage("> falling back to JSON API…");
    }
  }

  return translateJson(text, mode, direction, settings, onStage);
}

async function translateJson(text, mode, direction, settings, onStage) {
  const apiUrl = direction === "zh2en" ? "/api/translate-zh" : "/api/translate";
  // zh2en 不需要 mode；en2zh 带上 mode
  const payload = direction === "zh2en"
    ? JSON.stringify({ text, model: settings.model })
    : JSON.stringify({
      text,
      mode,
      grammarAnalysis: settings.grammarAnalysis !== false,
      model: settings.model,
    });

  const t0 = performance.now();
  onStage(`> POST ${apiUrl}  (${payload.length} bytes)`);

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const elapsed = Math.round(performance.now() - t0);
  onStage(`> response: ${res.status} ${res.statusText}  (${elapsed}ms)`);

  onStage(`> parsing JSON…`);
  const data = await res.json();
  const total = Math.round(performance.now() - t0);

  return { res, data, direction, total };
}

async function translateStream(text, mode, settings, onStage, onEvent) {
  const apiUrl = "/api/translate-stream";
  const payload = JSON.stringify({
    text,
    mode,
    grammarAnalysis: settings.grammarAnalysis !== false,
    model: settings.model,
  });
  const t0 = performance.now();
  onStage(`> POST ${apiUrl}  (${payload.length} bytes)`);

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: payload,
  });
  const elapsed = Math.round(performance.now() - t0);
  onStage(`> response: ${res.status} ${res.statusText}  (${elapsed}ms)`);

  const contentType = res.headers.get("Content-Type") || "";
  if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
    throw new Error(`SSE endpoint returned ${res.status}`);
  }

  onStage("> streaming SSE…");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines = [];
  let finalData = null;
  let streamError = null;

  const dispatch = () => {
    if (!dataLines.length) {
      currentEvent = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      currentEvent = "message";
      return;
    }
    const event = currentEvent;
    currentEvent = "message";
    if (event === "result") finalData = data;
    if (event === "error") streamError = new Error(data.detail || data.error || "stream_failed");
    onEvent?.(event, data);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) {
        dispatch();
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (done) {
      if (buffer) dataLines.push(buffer);
      dispatch();
      break;
    }
  }

  if (streamError) throw streamError;
  if (!finalData) throw new Error("stream ended without a result");

  return {
    res,
    data: finalData,
    direction: "en2zh",
    total: Math.round(performance.now() - t0),
  };
}
