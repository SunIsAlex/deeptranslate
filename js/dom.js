// DOM 元素引用与通用 DOM 构建工具

export const inputEl = document.getElementById("input-text");
export const modeEl = document.getElementById("mode");
export const grammarAnalysisEl = document.getElementById("grammar-analysis");
export const modelEl = document.getElementById("model");
export const submitBtn = document.getElementById("submit-btn");
export const statusEl = document.getElementById("status");
export const outputEl = document.getElementById("output");
export const copyBtn = document.getElementById("copy-btn");

// 转义,防 XSS(因为高亮要用 innerHTML)
export function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function textLi(text) {
  return el("li", "", text);
}

export function section(title, items) {
  const sec = document.createElement("section");
  sec.appendChild(el("h4", "", title));
  const ul = document.createElement("ul");
  items.forEach((item) => ul.appendChild(item));
  sec.appendChild(ul);
  return sec;
}
