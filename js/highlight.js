// 例句 [[ ]] 高亮 + 句法成分着色
import { escapeHtml } from "./dom.js";

// 把例句中 [[...]] 标记转为 <mark>，无标记则原样显示
export function highlightExample(text) {
  const escaped = escapeHtml(text);
  // escapeHtml 不会动 [ ]，所以转义后 [[ ]] 仍在
  return escaped.replace(/\[\[(.+?)\]\]/g, "<mark>$1</mark>");
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
