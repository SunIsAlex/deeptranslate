// 例句 [[ ]] 高亮 + 句法成分着色
import { escapeHtml } from "./dom.js";

// 例句高亮：
// 1. 模型用 [[...]] 标记过 → 直接转 <mark>（信任模型，含其判断的词形）
// 2. 模型漏标但传入了 target → 用 target 及其词形在例句里兜底匹配
// 3. 都没有 → 原样显示
// inflections 为后端给出的不规则变形（如 said、children），并入词形表
export function highlightExample(text, target, inflections) {
  const escaped = escapeHtml(text);
  // escapeHtml 不会动 [ ]，所以转义后 [[ ]] 仍在
  if (/\[\[.+?\]\]/.test(escaped)) {
    return escaped.replace(/\[\[(.+?)\]\]/g, "<mark>$1</mark>");
  }
  if (target) {
    const re = buildFormRegex(genWordForms(target, inflections));
    if (re) return escaped.replace(re, "<mark>$1</mark>");
  }
  return escaped;
}

// 生成所有可能的词形:原词 + 后端不规则变形 + 前端规则推导
// 兼顾连字符词（sock-hopping）与多词短语（pay off）：对整体加规则后缀，
// 短语的不规则变形仍依赖模型标记，这里只保证原形能被匹配到。
function genWordForms(word, inflections) {
  const w = word.toLowerCase().trim();
  const forms = new Set([w]);
  (inflections || []).forEach((inf) => {
    if (inf.form) forms.add(inf.form.toLowerCase());
  });
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

// 把词形表编成一个带词边界、大小写不敏感的正则；长形优先（避免 paid 抢在 paid off 前）
function buildFormRegex(forms) {
  const alts = forms
    .filter(Boolean)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  if (!alts.length) return null;
  return new RegExp(`\\b(${alts.join("|")})\\b`, "gi");
}

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
export function renderHighlightedSentence(input, components) {
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
