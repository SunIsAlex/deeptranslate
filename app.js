const API_URL = "/api/translate";

const inputEl = document.getElementById("input-text");
const modeEl = document.getElementById("mode");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");

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
copyBtn.hidden = false;
render(data);
    // 提交时更新地址栏（不刷页面）
    // handleSubmit 里成功拿到 data 之后
const prefix = data.type === "word" ? "w" : "s";
history.pushState(null, "", `/${prefix}/${encodeURIComponent(text)}`);
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
  frag.appendChild(el("h4", "", "成分分析"));
  frag.appendChild(renderHighlightedSentence(input, analysis.components));
  // 原来的列表保留作为详细说明
  const ul = document.createElement("ul");
  analysis.components.forEach((c) => {
    const li = document.createElement("li");
    li.append(el("span", "comp-role", c.role), el("span", "comp-text", c.text));
    if (c.note) li.appendChild(el("span", "comp-note", c.note));
    ul.appendChild(li);
  });
  frag.appendChild(ul);
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
// 页面加载时（替换原来的 restoreFromUrl）
(function restoreFromUrl() {
  const m = location.pathname.match(/^\/(w|s)\/(.+)$/);
  if (!m) return;
  const [, prefix, encoded] = m;
  const text = decodeURIComponent(encoded);
  inputEl.value = text;
  modeEl.value = prefix === "w" ? "word" : "sentence";
  handleSubmit();
})();


// role → 颜色映射（柔和色板，和 Google 蓝主色不冲突）
const ROLE_COLORS = {
  "主语": "#e3f2fd",   // 浅蓝
  "谓语": "#fff3e0",   // 浅橙
  "宾语": "#e8f5e9",   // 浅绿
  "表语": "#f3e5f5",   // 浅紫
  "定语": "#fce4ec",   // 浅粉
  "状语": "#fff9c4",   // 浅黄
  "补语": "#e0f7fa",   // 浅青
  "同位语": "#efebe9", // 浅棕
  "插入语": "#eceff1", // 浅灰
};

/**
 * 把原句按 components 切片渲染为高亮元素
 * @param {string} input 原句
 * @param {Array<{role, text, note}>} components 句法成分（按句中顺序）
 * @returns {HTMLElement} 一个包含高亮片段的 div
 */
function renderHighlightedSentence(input, components) {
  const wrap = document.createElement("div");
  wrap.className = "highlight-sentence";

  let cursor = 0;
  for (const comp of components) {
    // 在原句中定位 comp.text（从 cursor 开始找，避免重复词的误匹配）
    const idx = input.indexOf(comp.text, cursor);
    if (idx === -1) {
      // 找不到（模型给出的片段与原句不完全一致），降级显示
      const span = document.createElement("span");
      span.className = "hl-fallback";
      span.textContent = comp.text;
      wrap.appendChild(span);
      continue;
    }

    // 把 cursor 到 idx 之间的部分作为普通文本插入
    if (idx > cursor) {
      wrap.appendChild(document.createTextNode(input.slice(cursor, idx)));
    }

    // 高亮片段
    const span = document.createElement("span");
    span.className = "hl-span";
    span.style.background = ROLE_COLORS[comp.role] || "#f5f5f5";
    span.textContent = comp.text;
    span.dataset.role = comp.role;
    if (comp.note) {
      span.title = `${comp.role} · ${comp.note}`;
    } else {
      span.title = comp.role;
    }
    // 角色标签（小字上标）
    const tag = document.createElement("sub");
    tag.className = "hl-tag";
    tag.textContent = comp.role;
    span.appendChild(tag);
    wrap.appendChild(span);

    cursor = idx + comp.text.length;
  }

  // 剩余部分
  if (cursor < input.length) {
    wrap.appendChild(document.createTextNode(input.slice(cursor)));
  }

  return wrap;
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
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