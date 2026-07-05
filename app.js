// 入口控制器：提交流程、加载日志、路由恢复、复制、事件绑定
import {
  inputEl, modeEl, grammarAnalysisEl, modelEl,
  submitBtn, statusEl, outputEl, copyBtn,
  followUpEl, followUpThreadEl, followUpInputEl, followUpBtn,
} from "./js/dom.js";
import { askFollowUp, detectDirection, translate } from "./js/api.js";
import { render, renderStreaming } from "./js/render.js";

let currentTranslation = null;
let followUpHistory = [];
let followUpController = null;

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

function resetFollowUp() {
  followUpController?.abort();
  followUpController = null;
  currentTranslation = null;
  followUpHistory = [];
  followUpThreadEl.innerHTML = "";
  followUpInputEl.value = "";
  followUpEl.hidden = true;
  followUpBtn.disabled = false;
  followUpInputEl.disabled = false;
}

function followUpContext(data) {
  const {
    direction, input, type, translation,
    senses, analysis, translations,
  } = data;
  return {
    direction,
    input,
    type,
    translation,
    senses,
    analysis,
    translations,
  };
}

function appendFollowUpMessage(role, text = "") {
  const message = document.createElement("div");
  message.className = `follow-up-message follow-up-${role}`;
  message.textContent = text;
  followUpThreadEl.appendChild(message);
  return message;
}

// ── 提交流程 ───────────────────────────────────
async function handleSubmit() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus("请输入内容");
    return;
  }

  outputEl.innerHTML = "";
  resetFollowUp();
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
    const partial = { input: text, translation: "", senses: [], examples: [] };
    const onStreamEvent = (event, data) => {
      if (event === "translation") {
        partial.translation = data.text || "";
        renderStreaming(partial);
        setStatus("生成中…");
      } else if (event === "senses" && Array.isArray(data.items)) {
        partial.senses = data.items;
        renderStreaming(partial);
      } else if (event === "example" && data.text) {
        partial.examples[data.index ?? partial.examples.length] = data.text;
        renderStreaming(partial);
      } else if (event === "result") {
        render(data);
        setStatus(data._cached ? "缓存" : "");
        currentTranslation = followUpContext(data);
        followUpEl.hidden = false;
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
    currentTranslation = followUpContext(data);
    followUpEl.hidden = false;
    updateUrl(data, text);
  } catch (err) {
    setStage(`> ERROR: ${err.message}`);
    setStatus(`网络错误：${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleFollowUp() {
  const question = followUpInputEl.value.trim();
  if (!question || !currentTranslation || followUpController) return;

  appendFollowUpMessage("user", question);
  const answerEl = appendFollowUpMessage("assistant");
  answerEl.classList.add("streaming");
  followUpInputEl.value = "";
  followUpInputEl.disabled = true;
  followUpBtn.disabled = true;
  followUpBtn.textContent = "回答中…";

  const controller = new AbortController();
  followUpController = controller;
  let streamedAnswer = "";

  try {
    const answer = await askFollowUp({
      question,
      context: currentTranslation,
      history: followUpHistory.slice(-8),
      model: modelEl.value,
      signal: controller.signal,
      onDelta(delta) {
        streamedAnswer += delta;
        answerEl.textContent = streamedAnswer;
      },
    });
    answerEl.textContent = answer;
    followUpHistory.push({ question, answer });
  } catch (error) {
    if (error.name !== "AbortError") {
      answerEl.textContent = `回答失败：${error.message}`;
      answerEl.classList.add("follow-up-error");
    }
  } finally {
    answerEl.classList.remove("streaming");
    if (followUpController === controller) {
      followUpController = null;
      followUpInputEl.disabled = false;
      followUpBtn.disabled = false;
      followUpBtn.textContent = "提问";
      followUpInputEl.focus();
    }
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
followUpBtn.addEventListener("click", handleFollowUp);

inputEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
});

followUpInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleFollowUp();
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
