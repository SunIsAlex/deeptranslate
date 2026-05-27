const API_URL = "/api/translate";

const inputEl = document.getElementById("input-text");
const modeEl = document.getElementById("mode");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

submitBtn.addEventListener("click", handleSubmit);

inputEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
});

async function handleSubmit() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus("请输入内容");
    return;
  }

  setStatus("分析中…");
  outputEl.innerHTML = "";
  submitBtn.disabled = true;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: modeEl.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.message || data.error || `请求失败 ${res.status}`);
      return;
    }
    setStatus(data._cached ? "缓存" : "");
    render(data);
    // 提交时更新地址栏（不刷页面）
    history.pushState(null, "", `?text=${encodeURIComponent(text)}&mode=${modeEl.value}`);
  } catch (err) {
    setStatus(`网络错误：${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function render(data) {
  const wrap = document.createElement("div");
  wrap.className = "result";
  if (data.type === "word") wrap.appendChild(renderWord(data));
  else if (data.type === "sentence") wrap.appendChild(renderSentence(data));
  else wrap.textContent = JSON.stringify(data, null, 2);
  outputEl.innerHTML = "";
  outputEl.appendChild(wrap);
}

function renderWord(data) {
  const { input, translation, analysis } = data;
  const frag = document.createDocumentFragment();

  const h = document.createElement("h3");
  h.textContent = input;
  if (analysis?.phonetic) {
    const ph = document.createElement("span");
    ph.className = "phonetic";
    ph.textContent = analysis.phonetic;
    h.appendChild(ph);
  }
  if (analysis?.pos) {
    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = analysis.pos;
    h.appendChild(pos);
  }
  frag.appendChild(h);

  frag.appendChild(el("div", "translation", translation));

  if (analysis?.morphology?.length) {
    frag.appendChild(section("构词分解", analysis.morphology.map((m) => {
      const li = document.createElement("li");
      const p = el("span", "morph-part", m.part);
      const k = el("span", "morph-kind", m.kind);
      const meaning = document.createTextNode(m.meaning);
      li.append(p, k, meaning);
      return li;
    })));
  }

  if (analysis?.examples?.length) {
    frag.appendChild(section("例句", analysis.examples.map(textLi)));
  }

  return frag;
}

function renderSentence(data) {
  const { input, translation, analysis } = data;
  const frag = document.createDocumentFragment();

  frag.appendChild(el("h3", "", input));
  frag.appendChild(el("div", "translation", translation));

  if (analysis?.structure) {
    frag.appendChild(section("结构", [textLi(analysis.structure)]));
  }

  if (analysis?.components?.length) {
    frag.appendChild(section("成分分析", analysis.components.map((c) => {
      const li = document.createElement("li");
      const role = el("span", "comp-role", c.role);
      const text = el("span", "comp-text", c.text);
      li.append(role, text);
      if (c.note) li.appendChild(el("span", "comp-note", c.note));
      return li;
    })));
  }

  if (analysis?.grammar_points?.length) {
    frag.appendChild(section("语法点", analysis.grammar_points.map(textLi)));
  }

  return frag;
}

// 工具函数
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textLi(text) {
  return el("li", "", text);
}

function section(title, items) {
  const sec = document.createElement("section");
  sec.appendChild(el("h4", "", title));
  const ul = document.createElement("ul");
  items.forEach((item) => ul.appendChild(item));
  sec.appendChild(ul);
  return sec;
}

// 页面加载时读取 URL 参数
(function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const text = params.get("text");
  const mode = params.get("mode");
  if (!text) return;
  inputEl.value = text;
  if (mode) modeEl.value = mode;
  handleSubmit();
})();