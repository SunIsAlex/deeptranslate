// 后台 service worker：替 content script 发起跨域请求。
// 在后台 fetch 不受页面 CSP / 同源策略限制（配合 host_permissions），
// 比在 content script 里直接 fetch 更稳。

const DEFAULT_ENDPOINT = "https://api.sunisalex.org/api/translate";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "translate") return false;

  (async () => {
    try {
      const { endpoint } = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT });
      const res = await fetch(endpoint || DEFAULT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg.text, mode: "auto" }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        sendResponse({ ok: false, error: data?.error || `HTTP ${res.status}`, data });
        return;
      }
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // 异步 sendResponse
});
