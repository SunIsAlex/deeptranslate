const inputEl = document.getElementById("input-text");
const modeEl = document.getElementById("mode");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");
const copyBtn = document.getElementById("copy-btn");


// 加在工具函数区
// 转义,防 XSS(因为高亮要用 innerHTML)
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// 生成所有可能的词形:原词 + 后端不规则变形 + 前端规则推导
function genWordForms(word, inflections) {
  const forms = new Set([word.toLowerCase()]);
  (inflections || []).forEach((inf) => {
    if (inf.form) forms.add(inf.form.toLowerCase());
  });
  const w = word.toLowerCase();
  // 规则变形推导
  forms.add(w + "s");
  forms.add(w + "es");
  forms.add(w + "ed");
  forms.add(w + "ing");
  forms.add(w + "d");
  // 去 e 类:make → making / made
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    forms.add(stem + "ing");
    forms.add(stem + "ed");
  }
  // 变 y 类:study → studies / studied
  if (w.endsWith("y")) {
    const stem = w.slice(0, -1);
    forms.add(stem + "ies");
    forms.add(stem + "ied");
  }
  // 双写末辅音:stop → stopped / stopping(简单启发式:CVC 结尾)
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
    const last = w[w.length - 1];
    forms.add(w + last + "ed");
    forms.add(w + last + "ing");
  }
  return [...forms];
}

// 把例句中 [[...]] 标记转为 <mark>，无标记则原样显示
function highlightExample(text) {
  const escaped = escapeHtml(text);
  // escapeHtml 不会动 [ ]，所以转义后 [[ ]] 仍在
  return escaped.replace(/\[\[(.+?)\]\]/g, "<mark>$1</mark>");
}
function setStage(line) {
  let pre = outputEl.querySelector(".loading-stage");
  if (!pre) {
    outputEl.innerHTML = '<pre class="loading-stage"></pre>';
    pre = outputEl.querySelector(".loading-stage");
  }
  pre.textContent += line + "\n";
}

// 根据输入是否含中文判断翻译方向
function detectDirection(text) {
  return /[\u4e00-\u9fa5]/.test(text) ? "zh2en" : "en2zh";
}

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

  outputEl.innerHTML = "";
  submitBtn.disabled = true;
  copyBtn.hidden = true;
  setStatus("");

  const direction = detectDirection(text);
  const apiUrl = direction === "zh2en" ? "/api/translate-zh" : "/api/translate";
  const mode = modeEl.value;
  const t0 = performance.now();

  setStage(`> input: "${truncate(text, 50)}"`);
  setStage(`> direction: ${direction}  |  length: ${text.length} chars`);

  try {
    // zh2en 不需要 mode；en2zh 带上 mode
    const payload = direction === "zh2en"
      ? JSON.stringify({ text })
      : JSON.stringify({ text, mode });
    setStage(`> POST ${apiUrl}  (${payload.length} bytes)`);

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    const elapsed = Math.round(performance.now() - t0);
    setStage(`> response: ${res.status} ${res.statusText}  (${elapsed}ms)`);

    setStage(`> parsing JSON…`);
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.message || data.error || `请求失败 ${res.status}`);
      return;
    }

    const total = Math.round(performance.now() - t0);
    const typeLabel = data.direction === "zh2en" ? "zh2en" : data.type;
    setStage(`> type: ${typeLabel}  |  cached: ${data._cached ? "HIT" : "MISS"}  |  ${total}ms`);
    setStage(`> rendering…`);

    // 短暂停顿让用户看清最后一行,再渲染结果
    await sleep(1000);

    setStatus(data._cached ? "缓存" : "");
    copyBtn.hidden = false;
    render(data);

    // 更新地址栏
    if (data.direction === "zh2en") {
      history.pushState(null, "", `/zh/${encodeURIComponent(text)}`);
    } else {
      const prefixMap = { word: "w", phrase: "p", sentence: "s" };
      const prefix = prefixMap[data.type] || "s";
      history.pushState(null, "", `/${prefix}/${encodeURIComponent(text)}`);
    }
  } catch (err) {
    setStage(`> ERROR: ${err.message}`);
    setStatus(`网络错误：${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
}

// 工具函数
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function setStatus(msg) {
  statusEl.textContent = msg;
}

function render(data) {
  const wrap = document.createElement("div");
  wrap.className = "result";
  if (data.direction === "zh2en") wrap.appendChild(renderZh(data));
  else if (data.type === "word") wrap.appendChild(renderWord(data));
  else if (data.type === "phrase") wrap.appendChild(renderPhrase(data));
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
if (analysis?.inflections?.length) {
  frag.appendChild(section("词形变化",
    analysis.inflections.map((inf) =>
      el("li", "", `${inf.form} — ${inf.label}`)
    )
  ));
}
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
  const sec = document.createElement("section");
  sec.appendChild(el("h4", "", "例句"));
  const ul = document.createElement("ul");
  analysis.examples.forEach((ex) => {
    const li = document.createElement("li");
    li.innerHTML = highlightExample(ex);
    ul.appendChild(li);
  });
  sec.appendChild(ul);
  frag.appendChild(sec);
}

  return frag;
}

function renderPhrase(data) {
  const { input, translation, analysis } = data;
  const frag = document.createDocumentFragment();

  const h = document.createElement("h3");
  h.textContent = input;
  if (analysis?.pos) {
    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = analysis.pos;
    h.appendChild(pos);
  }
  frag.appendChild(h);

  frag.appendChild(el("div", "translation", translation));

  if (analysis?.usage) {
    frag.appendChild(section("用法", [el("li", "", analysis.usage)]));
  }

  if (analysis?.examples?.length) {
    const sec = document.createElement("section");
    sec.appendChild(el("h4", "", "例句"));
    const ul = document.createElement("ul");
    analysis.examples.forEach((ex) => {
      const li = document.createElement("li");
      li.innerHTML = highlightExample(ex);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    frag.appendChild(sec);
  }
  return frag;
}

function renderZh(data) {
  const { input, type, translations } = data;
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "", input));

  // 句子：单一译法，简洁显示，不重复
  if (type === "sentence" && translations?.length) {
    const t = translations[0];
    const en = document.createElement("div");
    en.className = "translation";
    en.innerHTML = highlightExample(t.en || "");
    frag.appendChild(en);
    return frag;
  }

  // 词/短语：多备选
  if (translations?.length) {
    translations.forEach((t) => {
      const sec = document.createElement("section");
      sec.className = "zh-item";
      const en = document.createElement("div");
      en.className = "zh-en";
      en.innerHTML = highlightExample(t.en || "");
      sec.appendChild(en);
      if (t.note && t.note.trim()) sec.appendChild(el("div", "zh-note", t.note));
      if (t.example) {
        const ex = document.createElement("div");
        ex.className = "zh-example";
        ex.innerHTML = highlightExample(t.example);
        sec.appendChild(ex);
      }
      frag.appendChild(sec);
    });
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

// 页面加载时读取 URL 路径，恢复查询
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
  // 先尝试构建高亮片段，全程检测是否能严格顺序匹配
  const segments = [];
  let cursor = 0;
  let ok = true;

  for (const comp of components) {
    const idx = input.indexOf(comp.text, cursor);
    if (idx === -1) {
      ok = false; // 有成分无法在剩余原句中按序定位 → 放弃高亮
      break;
    }
    if (idx > cursor) {
      segments.push({ type: "plain", text: input.slice(cursor, idx) });
    }
    segments.push({ type: "mark", text: comp.text, role: comp.role, note: comp.note });
    cursor = idx + comp.text.length;
  }

  const wrap = document.createElement("div");
  wrap.className = "highlight-sentence";

  if (!ok) {
    // 降级：直接显示完整原句，不高亮（保证句子正确）
    wrap.textContent = input;
    return wrap;
  }

  // 正常：拼接高亮片段
  for (const seg of segments) {
    if (seg.type === "plain") {
      wrap.appendChild(document.createTextNode(seg.text));
    } else {
      const span = document.createElement("span");
      span.className = "hl-span";
      span.style.background = ROLE_COLORS[seg.role] || "#f5f5f5";
      span.textContent = seg.text;
      span.title = seg.note ? `${seg.role} · ${seg.note}` : seg.role;
      const tag = document.createElement("sub");
      tag.className = "hl-tag";
      tag.textContent = seg.role;
      span.appendChild(tag);
      wrap.appendChild(span);
    }
  }
  // 补上尾部
  if (cursor < input.length) {
    wrap.appendChild(document.createTextNode(input.slice(cursor)));
  }
  return wrap;
}

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
