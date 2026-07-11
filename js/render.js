// 各类型翻译结果的渲染
import { el, textLi, section, outputEl } from "./dom.js";
import { highlightExample, renderHighlightedSentence } from "./highlight.js";
import { canSpeak, speakEnglish } from "./speech.js";

// 渲染入口：按 direction / type 分发到对应渲染器
export function render(data) {
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

// SSE 过程中按义项、英文解释、例句的顺序展示完整内容，最终由 render 替换。
export function renderStreaming({ input, translation, senses, examples }) {
  const wrap = document.createElement("div");
  wrap.className = "result streaming-result";
  wrap.appendChild(createResultHeading(input));
  if (translation) wrap.appendChild(renderSenses(senses, translation));

  const completedExamples = (examples || []).filter(Boolean);
  if (completedExamples.length) {
    const sec = document.createElement("section");
    sec.appendChild(el("h4", "", "例句"));
    const ul = document.createElement("ul");
    completedExamples.forEach((example) => ul.appendChild(createExampleItem(example, input)));
    sec.appendChild(ul);
    wrap.appendChild(sec);
  }

  outputEl.innerHTML = "";
  outputEl.appendChild(wrap);
}

export function renderMarkdown(container, source) {
  if (!globalThis.marked?.parse) {
    container.textContent = source;
    return;
  }
  const html = globalThis.marked.parse(source, { gfm: true, breaks: true });
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeMarkdown(template.content);
  container.replaceChildren(template.content);
}

function sanitizeMarkdown(root) {
  const allowedTags = new Set([
    "A", "B", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HR", "I", "LI", "OL", "P", "PRE", "S", "STRONG",
    "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
  ]);
  const blockedTags = new Set([
    "AUDIO", "BUTTON", "EMBED", "FORM", "IFRAME", "INPUT", "LINK", "MATH",
    "META", "OBJECT", "SCRIPT", "SOURCE", "STYLE", "SVG", "TEMPLATE", "VIDEO",
  ]);

  root.querySelectorAll("*").forEach((node) => {
    if (blockedTags.has(node.tagName)) {
      node.remove();
      return;
    }
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }

    const href = node.tagName === "A" ? node.getAttribute("href") : null;
    const title = node.tagName === "A" ? node.getAttribute("title") : null;
    const codeClass = node.tagName === "CODE" ? node.getAttribute("class") : null;
    [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));

    if (node.tagName === "A" && isSafeLink(href)) {
      node.setAttribute("href", href);
      if (title) node.setAttribute("title", title);
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "CODE" && /^language-[\w-]+$/.test(codeClass || "")) {
      node.setAttribute("class", codeClass);
    }
  });
}

function isSafeLink(href) {
  if (!href) return false;
  if (href.startsWith("#") || href.startsWith("/")) return true;
  try {
    const url = new URL(href, location.origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function renderWord(data) {
  const { input, translation, senses, analysis } = data;
  const frag = document.createDocumentFragment();

  const h = document.createElement("h3");
  h.textContent = input;
  
  frag.appendChild(createResultHeading(input, h));

  frag.appendChild(renderSenses(senses, translation, {
    phonetic: analysis?.phonetic,
    pos: analysis?.pos,
  }));
  if (analysis?.fullForm) {
  frag.appendChild(el("div", "full-form", analysis.fullForm));
}
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
    analysis.examples.forEach((ex) => ul.appendChild(createExampleItem(ex, input, analysis.inflections)));
    sec.appendChild(ul);
    frag.appendChild(sec);
  }

  return frag;
}

function renderPhrase(data) {
  const { input, translation, senses, analysis } = data;
  const frag = document.createDocumentFragment();

  const h = document.createElement("h3");
  h.textContent = input;
  frag.appendChild(createResultHeading(input, h));

  frag.appendChild(renderSenses(senses, translation, { pos: analysis?.pos }));

  if (analysis?.usage) {
    frag.appendChild(section("用法", [el("li", "", analysis.usage)]));
  }

  if (analysis?.examples?.length) {
    const sec = document.createElement("section");
    sec.appendChild(el("h4", "", "例句"));
    const ul = document.createElement("ul");
    analysis.examples.forEach((ex) => ul.appendChild(createExampleItem(ex, input)));
    sec.appendChild(ul);
    frag.appendChild(sec);
  }
  return frag;
}

// 新接口按义项同时返回中文释义和英文解释；fallback 兼容旧缓存或旧接口数据。
function renderSenses(senses, fallback, legacy = {}) {
  const validSenses = Array.isArray(senses)
    ? senses.filter((sense) => sense?.zh || sense?.definition)
    : [];

  if (!validSenses.length) return el("div", "translation", fallback || "");

  const list = document.createElement("ol");
  list.className = "sense-list";
  validSenses.forEach((sense, index) => {
    const item = document.createElement("li");
    item.className = "sense-item";
    const phonetic = sense.phonetic || (index === 0 ? legacy.phonetic : "");
    const pos = sense.pos || (index === 0 ? legacy.pos : "");
    if (sense.zh || phonetic || pos) {
      const heading = el("div", "sense-zh", sense.zh || "");
      if (phonetic) heading.appendChild(el("span", "phonetic", phonetic));
      if (pos) heading.appendChild(el("span", "pos", pos));
      item.appendChild(heading);
    }
    if (sense.definition) {
      item.appendChild(el("div", "sense-definition", sense.definition));
    }
    list.appendChild(item);
  });
  return list;
}

function renderZh(data) {
  const { input, type, translations } = data;
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "", input));

  // 句子：单一译法，简洁显示，不重复
  if (type === "sentence" && translations?.length) {
    const t = translations[0];
    frag.appendChild(createSpokenText(t.en || "", "translation"));
    return frag;
  }

  // 词/短语：多备选
  if (translations?.length) {
    translations.forEach((t) => {
      const sec = document.createElement("section");
      sec.className = "zh-item";
      sec.appendChild(createSpokenText(t.en || "", "zh-en"));
      if (t.note && t.note.trim()) sec.appendChild(el("div", "zh-note", t.note));
      if (t.example) {
        sec.appendChild(createSpokenText(t.example, "zh-example", t.en));
      }
      frag.appendChild(sec);
    });
  }
  return frag;
}

function renderSentence(data) {
  const { input, translation, analysis } = data;
  const frag = document.createDocumentFragment();

  frag.appendChild(createResultHeading(input));
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

function createResultHeading(text, heading = null) {
  const row = document.createElement("div");
  row.className = "result-heading";
  row.appendChild(heading || el("h3", "", text));
  row.appendChild(createSpeechControls(text));
  return row;
}

function createSpokenText(text, className, target, inflections) {
  const row = document.createElement("div");
  row.className = `${className} spoken-text`;
  const content = document.createElement("span");
  content.innerHTML = highlightExample(text, target, inflections);
  row.append(content, createSpeechControls(text));
  return row;
}

function createExampleItem(text, target, inflections) {
  const item = document.createElement("li");
  item.className = "example-item";
  const content = document.createElement("span");
  content.innerHTML = highlightExample(text, target, inflections);
  item.append(content, createSpeechControls(text));
  return item;
}

function createSpeechControls(text) {
  const controls = document.createElement("span");
  controls.className = "speech-controls";
  if (!canSpeak() || !String(text || "").trim()) return controls;

  [
    ["us", "US", "播放美式发音"],
    ["uk", "UK", "播放英式发音"],
  ].forEach(([variant, label, title]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speech-btn";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", () => speakEnglish(text, variant));
    controls.appendChild(button);
  });
  return controls;
}
