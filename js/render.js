// 各类型翻译结果的渲染
import { el, textLi, section, outputEl } from "./dom.js";
import { highlightExample, renderHighlightedSentence } from "./highlight.js";

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

function renderWord(data) {
  const { input, translation, senses, analysis } = data;
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

  frag.appendChild(renderSenses(senses, translation));
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
    analysis.examples.forEach((ex) => {
      const li = document.createElement("li");
      li.innerHTML = highlightExample(ex, input, analysis.inflections);
      ul.appendChild(li);
    });
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
  if (analysis?.pos) {
    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = analysis.pos;
    h.appendChild(pos);
  }
  frag.appendChild(h);

  frag.appendChild(renderSenses(senses, translation));

  if (analysis?.usage) {
    frag.appendChild(section("用法", [el("li", "", analysis.usage)]));
  }

  if (analysis?.examples?.length) {
    const sec = document.createElement("section");
    sec.appendChild(el("h4", "", "例句"));
    const ul = document.createElement("ul");
    analysis.examples.forEach((ex) => {
      const li = document.createElement("li");
      li.innerHTML = highlightExample(ex, input);
      ul.appendChild(li);
    });
    sec.appendChild(ul);
    frag.appendChild(sec);
  }
  return frag;
}

// 新接口按义项同时返回中文释义和英文解释；fallback 兼容旧缓存或旧接口数据。
function renderSenses(senses, fallback) {
  const validSenses = Array.isArray(senses)
    ? senses.filter((sense) => sense?.zh || sense?.definition)
    : [];

  if (!validSenses.length) return el("div", "translation", fallback || "");

  const list = document.createElement("ol");
  list.className = "sense-list";
  validSenses.forEach((sense) => {
    const item = document.createElement("li");
    item.className = "sense-item";
    if (sense.zh) item.appendChild(el("div", "sense-zh", sense.zh));
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
        ex.innerHTML = highlightExample(t.example, t.en);
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
