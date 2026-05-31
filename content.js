// DeepTranslate 划词翻译 content script
// 流程：选中英文 → 按 F2 → 请求后台翻译 → 在选区附近弹出 tooltip 渲染 JSON。

(() => {
  "use strict";

  let hotkey = "F2";
  chrome.storage.sync.get({ hotkey: "F2" }).then((cfg) => {
    hotkey = cfg.hotkey || "F2";
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.hotkey) hotkey = changes.hotkey.newValue || "F2";
  });

  let host = null; // tooltip 宿主元素
  let shadow = null;
  let lastReqId = 0;

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== hotkey) return;
      // 避免在输入框里抢键
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) {
        // 输入框内仍允许：用选中的文本翻译
      }
      const sel = window.getSelection();
      const text = (sel?.toString() || "").trim();
      if (!text) return;

      e.preventDefault();
      e.stopPropagation();

      const rect = getSelectionRect(sel);
      translateAndShow(text, rect);
    },
    true
  );

  // 点击其它地方 / Esc / 滚动 → 关闭
  document.addEventListener("mousedown", (e) => {
    if (host && !host.contains(e.target)) removeTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") removeTooltip();
  });
  window.addEventListener("scroll", () => removeTooltip(), true);

  function getSelectionRect(sel) {
    try {
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch {}
    return { left: window.innerWidth / 2, bottom: 80, top: 60, width: 0, height: 0 };
  }

  async function translateAndShow(text, rect) {
    const reqId = ++lastReqId;
    showTooltip(rect, loadingNode(text));

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "translate", text });
    } catch (e) {
      resp = { ok: false, error: String(e) };
    }
    if (reqId !== lastReqId) return; // 已被更新的请求取代

    if (!resp?.ok) {
      showTooltip(rect, errorNode(resp?.error || "请求失败", resp?.data));
      return;
    }
    showTooltip(rect, render(resp.data));
  }

  // ---------- tooltip 容器（Shadow DOM 隔离页面样式）----------

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.id = "deeptranslate-tooltip-host";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;top:0;left:0;";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);
    const panel = document.createElement("div");
    panel.className = "dt-panel";
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
  }

  function removeTooltip() {
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
    lastReqId++; // 作废进行中的请求
  }

  function showTooltip(rect, contentNode) {
    ensureHost();
    const panel = shadow.querySelector(".dt-panel");
    panel.innerHTML = "";

    const close = document.createElement("button");
    close.className = "dt-close";
    close.textContent = "×";
    close.title = "关闭 (Esc)";
    close.addEventListener("click", removeTooltip);
    panel.appendChild(close);

    const body = document.createElement("div");
    body.className = "dt-body";
    body.appendChild(contentNode);
    panel.appendChild(body);

    position(panel, rect);
  }

  function position(panel, rect) {
    // 先放到可测量位置
    panel.style.visibility = "hidden";
    panel.style.left = "0px";
    panel.style.top = "0px";
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;

    let left = rect.left;
    if (left + pw > vw - gap) left = vw - pw - gap;
    if (left < gap) left = gap;

    let top = rect.bottom + gap;
    if (top + ph > vh - gap) {
      // 下方放不下 → 放选区上方
      top = rect.top - ph - gap;
      if (top < gap) top = gap;
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = "visible";
  }

  // ---------- 状态节点 ----------

  function loadingNode(text) {
    const wrap = document.createElement("div");
    wrap.className = "dt-loading";
    const spin = document.createElement("span");
    spin.className = "dt-spinner";
    wrap.appendChild(spin);
    wrap.appendChild(document.createTextNode(`翻译中：${truncate(text, 40)}`));
    return wrap;
  }

  function errorNode(message, data) {
    const wrap = document.createElement("div");
    wrap.className = "dt-error";
    wrap.appendChild(el("div", "dt-error-title", "翻译失败"));
    wrap.appendChild(el("div", "dt-error-msg", String(message)));
    if (data?.raw) wrap.appendChild(el("pre", "dt-raw", String(data.raw)));
    return wrap;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // ---------- 渲染（移植自网站 render.js / highlight.js）----------

  function render(data) {
    const wrap = document.createElement("div");
    wrap.className = "dt-result";
    if (!data || typeof data !== "object") {
      wrap.appendChild(el("pre", "dt-raw", JSON.stringify(data, null, 2)));
      return wrap;
    }
    if (data.type === "word") wrap.appendChild(renderWord(data));
    else if (data.type === "phrase") wrap.appendChild(renderPhrase(data));
    else if (data.type === "sentence") wrap.appendChild(renderSentence(data));
    else wrap.appendChild(el("pre", "dt-raw", JSON.stringify(data, null, 2)));
    return wrap;
  }

  function header(input, analysis, withPhonetic) {
    const h = el("div", "dt-h3");
    h.appendChild(document.createTextNode(input));
    if (withPhonetic && analysis?.phonetic) h.appendChild(el("span", "dt-phonetic", analysis.phonetic));
    if (analysis?.pos) h.appendChild(el("span", "dt-pos", analysis.pos));
    return h;
  }

  function renderWord(data) {
    const { input, translation, analysis } = data;
    const frag = document.createDocumentFragment();
    frag.appendChild(header(input, analysis, true));
    frag.appendChild(el("div", "dt-translation", translation));
    if (analysis?.fullForm) frag.appendChild(el("div", "dt-full-form", analysis.fullForm));

    if (analysis?.inflections?.length) {
      frag.appendChild(
        section("词形变化", analysis.inflections.map((inf) => el("li", "", `${inf.form} — ${inf.label}`)))
      );
    }
    if (analysis?.morphology?.length) {
      frag.appendChild(
        section("构词分解", analysis.morphology.map((m) => {
          const li = el("li");
          li.append(el("span", "dt-morph-part", m.part), el("span", "dt-morph-kind", m.kind), document.createTextNode(m.meaning));
          return li;
        }))
      );
    }
    if (analysis?.examples?.length) {
      frag.appendChild(exampleSection(analysis.examples, input, analysis.inflections));
    }
    return frag;
  }

  function renderPhrase(data) {
    const { input, translation, analysis } = data;
    const frag = document.createDocumentFragment();
    frag.appendChild(header(input, analysis, false));
    frag.appendChild(el("div", "dt-translation", translation));
    if (analysis?.usage) frag.appendChild(section("用法", [el("li", "", analysis.usage)]));
    if (analysis?.examples?.length) frag.appendChild(exampleSection(analysis.examples, input));
    return frag;
  }

  function renderSentence(data) {
    const { input, translation, analysis } = data;
    const frag = document.createDocumentFragment();
    frag.appendChild(el("div", "dt-h3", input));
    frag.appendChild(el("div", "dt-translation", translation));
    if (analysis?.structure) frag.appendChild(section("结构", [el("li", "", analysis.structure)]));
    if (analysis?.components?.length) {
      const sec = el("section", "dt-section");
      sec.appendChild(el("h4", "", "成分分析"));
      sec.appendChild(renderHighlightedSentence(input, analysis.components));
      const ul = el("ul");
      analysis.components.forEach((c) => {
        const li = el("li");
        li.append(el("span", "dt-comp-role", c.role), el("span", "dt-comp-text", c.text));
        if (c.note) li.appendChild(el("span", "dt-comp-note", c.note));
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      frag.appendChild(sec);
    }
    if (analysis?.grammar_points?.length) {
      frag.appendChild(section("语法点", analysis.grammar_points.map((g) => el("li", "", g))));
    }
    return frag;
  }

  function exampleSection(examples, target, inflections) {
    const sec = el("section", "dt-section");
    sec.appendChild(el("h4", "", "例句"));
    const ul = el("ul");
    examples.forEach((ex) => {
      const li = el("li");
      li.innerHTML = highlightExample(ex, target, inflections);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    return sec;
  }

  // ---------- DOM 小工具 ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function section(title, items) {
    const sec = el("section", "dt-section");
    sec.appendChild(el("h4", "", title));
    const ul = el("ul");
    items.forEach((i) => ul.appendChild(i));
    sec.appendChild(ul);
    return sec;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // ---------- 例句高亮（移植 highlight.js）----------

  function highlightExample(text, target, inflections) {
    const escaped = escapeHtml(text);
    if (/\[\[.+?\]\]/.test(escaped)) {
      return escaped.replace(/\[\[(.+?)\]\]/g, "<mark>$1</mark>");
    }
    if (target) {
      const re = buildFormRegex(genWordForms(target, inflections));
      if (re) return escaped.replace(re, "<mark>$1</mark>");
    }
    return escaped;
  }

  function genWordForms(word, inflections) {
    const w = word.toLowerCase().trim();
    const forms = new Set([w]);
    (inflections || []).forEach((inf) => {
      if (inf.form) forms.add(inf.form.toLowerCase());
    });
    forms.add(w + "s");
    forms.add(w + "es");
    forms.add(w + "ed");
    forms.add(w + "ing");
    forms.add(w + "d");
    if (w.endsWith("e")) {
      const stem = w.slice(0, -1);
      forms.add(stem + "ing");
      forms.add(stem + "ed");
    }
    if (w.endsWith("y")) {
      const stem = w.slice(0, -1);
      forms.add(stem + "ies");
      forms.add(stem + "ied");
    }
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
      const last = w[w.length - 1];
      forms.add(w + last + "ed");
      forms.add(w + last + "ing");
    }
    return [...forms];
  }

  function buildFormRegex(forms) {
    const alts = forms
      .filter(Boolean)
      .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);
    if (!alts.length) return null;
    return new RegExp(`\\b(${alts.join("|")})\\b`, "gi");
  }

  const ROLE_COLORS = {
    "主语": "#e3f2fd",
    "谓语": "#fff3e0",
    "宾语": "#e8f5e9",
    "表语": "#f3e5f5",
    "定语": "#fce4ec",
    "状语": "#fff9c4",
    "补语": "#e0f7fa",
    "同位语": "#efebe9",
    "插入语": "#eceff1",
  };

  function renderHighlightedSentence(input, components) {
    const segments = [];
    let cursor = 0;
    let ok = true;
    for (const comp of components) {
      const idx = input.indexOf(comp.text, cursor);
      if (idx === -1) {
        ok = false;
        break;
      }
      if (idx > cursor) segments.push({ type: "plain", text: input.slice(cursor, idx) });
      segments.push({ type: "mark", text: comp.text, role: comp.role, note: comp.note });
      cursor = idx + comp.text.length;
    }

    const wrap = el("div", "dt-highlight-sentence");
    if (!ok) {
      wrap.textContent = input;
      return wrap;
    }
    for (const seg of segments) {
      if (seg.type === "plain") {
        wrap.appendChild(document.createTextNode(seg.text));
      } else {
        const span = el("span", "dt-hl-span");
        span.style.background = ROLE_COLORS[seg.role] || "#f5f5f5";
        span.textContent = seg.text;
        span.title = seg.note ? `${seg.role} · ${seg.note}` : seg.role;
        const tag = el("sub", "dt-hl-tag", seg.role);
        span.appendChild(tag);
        wrap.appendChild(span);
      }
    }
    if (cursor < input.length) wrap.appendChild(document.createTextNode(input.slice(cursor)));
    return wrap;
  }

  // ---------- 样式（注入 Shadow DOM）----------

  const STYLE = `
    .dt-panel {
      position: fixed;
      max-width: 380px;
      max-height: 70vh;
      overflow: auto;
      box-sizing: border-box;
      background: #fff;
      color: #1f2329;
      border: 1px solid #e3e6eb;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18);
      padding: 12px 14px 14px;
      font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      text-align: left;
    }
    .dt-close {
      position: absolute; top: 6px; right: 8px;
      border: none; background: transparent; cursor: pointer;
      font-size: 18px; line-height: 1; color: #98a2b3; padding: 2px 4px;
    }
    .dt-close:hover { color: #1f2329; }
    .dt-body { padding-right: 10px; }
    .dt-h3 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
    .dt-phonetic { font-weight: 400; color: #5b6b7c; margin-left: 8px; font-size: 13px; }
    .dt-pos { font-weight: 400; color: #1a73e8; background: #e8f0fe; border-radius: 4px; padding: 0 6px; margin-left: 8px; font-size: 12px; }
    .dt-translation { font-size: 15px; margin: 4px 0 8px; }
    .dt-full-form { color: #5b6b7c; font-size: 13px; margin: -4px 0 8px; }
    .dt-section { margin-top: 10px; }
    .dt-section h4 { margin: 0 0 4px; font-size: 13px; color: #5b6b7c; font-weight: 600; }
    .dt-section ul { margin: 0; padding-left: 18px; }
    .dt-section li { margin: 2px 0; }
    .dt-morph-part { font-weight: 600; margin-right: 6px; }
    .dt-morph-kind { color: #1a73e8; font-size: 12px; background: #e8f0fe; border-radius: 4px; padding: 0 5px; margin-right: 6px; }
    .dt-comp-role { color: #1a73e8; font-size: 12px; margin-right: 6px; }
    .dt-comp-text { font-weight: 500; margin-right: 6px; }
    .dt-comp-note { color: #98a2b3; font-size: 12px; }
    mark { background: #fff3a0; color: inherit; border-radius: 2px; padding: 0 1px; }
    .dt-highlight-sentence { margin: 4px 0 6px; line-height: 2.2; }
    .dt-hl-span { border-radius: 3px; padding: 1px 3px; margin: 0 1px; position: relative; }
    .dt-hl-tag { font-size: 9px; color: #5b6b7c; vertical-align: baseline; margin-left: 2px; bottom: 0; }
    .dt-loading { display: flex; align-items: center; gap: 8px; color: #5b6b7c; }
    .dt-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #d0d5dd; border-top-color: #1a73e8;
      display: inline-block; animation: dt-spin .7s linear infinite;
    }
    @keyframes dt-spin { to { transform: rotate(360deg); } }
    .dt-error-title { font-weight: 600; color: #d92d20; }
    .dt-error-msg { color: #5b6b7c; margin-top: 2px; word-break: break-all; }
    .dt-raw { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: #f7f8fa; border-radius: 6px; padding: 8px; margin-top: 6px; }
  `;
})();
