// 入口控制器：提交流程、加载日志、路由恢复、复制、事件绑定
import {
  inputEl, modeEl, grammarAnalysisEl, modelEl,
  submitBtn, statusEl, outputEl, copyBtn,
} from "./js/dom.js";
import { detectDirection, translate } from "./js/api.js";
import { render, renderStreaming } from "./js/render.js";

// ── 加载日志与状态 ──────────────────────────────
function setStage(line) {
  let pre = outputEl.querySelector(".loading-stage");
  if (!pre) {
    outputEl.innerHTML = '<pre class="loading-stage"></pre>';
    pre = outputEl.querySelector(".loading-stage");
  }
  pre.textContent += line + "\n";
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ── 小工具 ─────────────────────────────────────
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}


// ── 提交流程 ───────────────────────────────────
async function handleSubmit() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus("请输入内容");
    return;
  }

  outputEl.innerHTML = "";
  submitBtn.disabled = true;
  copyBtn.hidden = true;
  setStatus("");

  const direction = detectDirection(text);
  const settings = {
    grammarAnalysis: grammarAnalysisEl.checked,
    model: modelEl.value,
  };
  setStage(`> input: "${truncate(text, 50)}"`);
  setStage(`> direction: ${direction}  |  length: ${text.length} chars`);
  setStage(`> model: ${settings.model}  |  grammar: ${settings.grammarAnalysis ? "ON" : "OFF"}`);

  try {
    const partial = { input: text, translation: "", examples: [] };
    const onStreamEvent = (event, data) => {
      if (event === "translation") {
        partial.translation = data.text || "";
        renderStreaming(partial);
        setStatus("生成中…");
      } else if (event === "example" && data.text) {
        partial.examples[data.index ?? partial.examples.length] = data.text;
        renderStreaming(partial);
      }
    };
    const { res, data, total } = await translate(
      text,
      modeEl.value,
      setStage,
      onStreamEvent,
      settings,
    );

    if (!res.ok) {
      setStatus(data.message || data.error || `请求失败 ${res.status}`);
      return;
    }

    const typeLabel = data.direction === "zh2en" ? "zh2en" : data.type;
    setStage(`> type: ${typeLabel}  |  cached: ${data._cached ? "HIT" : "MISS"}  |  ${total}ms`);
    setStage(`> rendering…`);



    setStatus(data._cached ? "缓存" : "");
    copyBtn.hidden = false;
    render(data);
    updateUrl(data, text);
  } catch (err) {
    setStage(`> ERROR: ${err.message}`);
    setStatus(`网络错误：${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

// 把当前查询写入地址栏，便于复制分享
function updateUrl(data, text) {
  if (data.direction === "zh2en") {
    history.pushState(null, "", `/zh/${encodeURIComponent(text)}`);
  } else {
    const prefixMap = { word: "w", phrase: "p", sentence: "s" };
    const prefix = prefixMap[data.type] || "s";
    history.pushState(null, "", `/${prefix}/${encodeURIComponent(text)}`);
  }
}

// ── 事件绑定 ───────────────────────────────────
submitBtn.addEventListener("click", handleSubmit);

inputEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`https://deeptranslate.sunisalex.org${location.pathname}`);
    copyBtn.textContent = "✓";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "🔗";
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch {
    setStatus("复制失败");
  }
});

// ── 页面加载时读取 URL 路径，恢复查询 ───────────
(function restoreFromUrl() {
  // /zh/中文 → 中译英
  const zhMatch = location.pathname.match(/^\/zh\/(.+)$/);
  if (zhMatch) {
    inputEl.value = decodeURIComponent(zhMatch[1]);
    handleSubmit(); // 内部按含中文自动判断走 zh2en
    return;
  }

  // /w/ /p/ /s/ → 英译中
  const m = location.pathname.match(/^\/(w|p|s)\/(.+)$/);
  if (!m) return;
  const [, prefix, encoded] = m;
  const text = decodeURIComponent(encoded);
  inputEl.value = text;
  // phrase 从 /p/ 进来设 auto，让模型重新判断
  modeEl.value = prefix === "w" ? "word" : prefix === "s" ? "sentence" : "auto";
  handleSubmit();
})();
