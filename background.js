// 后台 service worker：负责跨域请求，并通过 Port 把 SSE 事件转发给 content script。

const DEFAULT_ENDPOINT = "https://api.sunisalex.org/api/translate";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate-stream") return;

  const controller = new AbortController();
  let started = false;

  port.onMessage.addListener((msg) => {
    if (started || msg?.type !== "translate") return;
    started = true;
    translate(msg.text, controller.signal, port).catch((error) => {
      if (error?.name !== "AbortError") {
        post(port, { event: "error", data: { error: readableError(error) } });
      }
    });
  });

  port.onDisconnect.addListener(() => controller.abort());
});

async function translate(text, signal, port) {
  const input = String(text || "").trim();
  if (!input) throw new Error("请选择需要翻译的英文");

  const { endpoint } = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
  const jsonEndpoint = endpoint || DEFAULT_ENDPOINT;
  const payload = {
    text: input,
    mode: "auto",
    grammarAnalysis: true,
  };

  try {
    await translateStream(streamEndpointFor(jsonEndpoint), payload, signal, port);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    post(port, {
      event: "fallback",
      data: { reason: readableError(error) },
    });
    const data = await translateJson(jsonEndpoint, payload, signal);
    post(port, { event: "result", data });
  }

  post(port, { event: "done", data: {} });
}

async function translateStream(endpoint, payload, signal, port) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  });

  const contentType = res.headers.get("Content-Type") || "";
  if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
    throw new Error(`流接口返回 HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines = [];
  let receivedResult = false;

  const dispatch = () => {
    if (!dataLines.length) {
      currentEvent = "message";
      return;
    }

    const raw = dataLines.join("\n");
    const event = currentEvent;
    currentEvent = "message";
    dataLines = [];

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("流接口返回了无效数据");
    }

    if (event === "error") {
      throw new Error(data?.detail || data?.error || "流式翻译失败");
    }
    if (event === "result") receivedResult = true;
    if (event !== "done") post(port, { event, data });
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
      if (buffer) {
        const line = buffer.replace(/\r$/, "");
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      dispatch();
      break;
    }
  }

  if (!receivedResult) throw new Error("流已结束，但没有收到完整结果");
}

async function translateJson(endpoint, payload, signal) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    error.data = data;
    throw error;
  }
  if (!data || typeof data !== "object") throw new Error("接口未返回有效 JSON");
  return data;
}

function streamEndpointFor(endpoint) {
  const url = new URL(endpoint);
  if (/\/translate(?:-stream)?\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/translate(?:-stream)?\/?$/, "/translate-stream");
  } else {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}-stream`;
  }
  return url.toString();
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // 页面或 tooltip 已关闭。
  }
}

function readableError(error) {
  return String(error?.message || error || "请求失败");
}
