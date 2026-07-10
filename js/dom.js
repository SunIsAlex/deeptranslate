// DOM 元素引用与通用 DOM 构建工具

export const inputEl = document.getElementById("input-text");
export const modeEl = document.getElementById("mode");
export const grammarAnalysisEl = document.getElementById("grammar-analysis");
export const modelEl = document.getElementById("model");
export const submitBtn = document.getElementById("submit-btn");
export const statusEl = document.getElementById("status");
export const outputEl = document.getElementById("output");
export const copyBtn = document.getElementById("copy-btn");
export const followUpEl = document.getElementById("follow-up");
export const followUpThreadEl = document.getElementById("follow-up-thread");
export const followUpInputEl = document.getElementById("follow-up-input");
export const followUpBtn = document.getElementById("follow-up-btn");
export const vocabEl = document.getElementById("vocab");
export const vocabCountEl = document.getElementById("vocab-count");
export const vocabCurrentEl = document.getElementById("vocab-current");
export const vocabCurrentTermEl = document.getElementById("vocab-current-term");
export const vocabCurrentMetaEl = document.getElementById("vocab-current-meta");
export const addCurrentVocabBtn = document.getElementById("add-current-vocab");
export const suggestVocabBtn = document.getElementById("suggest-vocab");
export const vocabSuggestStatusEl = document.getElementById("vocab-suggest-status");
export const vocabSuggestionsEl = document.getElementById("vocab-suggestions");
export const vocabListEl = document.getElementById("vocab-list");
export const clearVocabBtn = document.getElementById("clear-vocab");
export const practiceEl = document.getElementById("practice");
export const practiceKindEl = document.getElementById("practice-kind");
export const generatePracticeBtn = document.getElementById("generate-practice");
export const practiceBodyEl = document.getElementById("practice-body");
export const practiceStatusEl = document.getElementById("practice-status");

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
