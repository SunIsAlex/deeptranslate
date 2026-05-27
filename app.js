// 与后端约定的接口路径
const API_URL = "/api/translate";

const inputEl = document.getElementById("input-text");
const modeEl = document.getElementById("mode");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

submitBtn.addEventListener("click", handleSubmit);

// Ctrl/Cmd + Enter 快捷提交
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
      setStatus(`请求失败：${data.error || res.status}`);
      return;
    }

    setStatus("");
    render(data);
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
  if (data.type === "word") {
    outputEl.appendChild(renderWord(data));
  } else if (data.type === "sentence") {
    outputEl.appendChild(renderSentence(data));
  } else {
    outputEl.textContent = JSON.stringify(data, null, 2);
  }
}

function renderWord(data) {
  const { input, translation, analysis } = data;
  const wrap = document.createElement("div");

  wrap.appendChild(h("h3", `${input}  ${analysis?.phonetic || ""}  ${analysis?.pos || ""}`));
  wrap.appendChild(h("p", `释义：${translation}`));

  if (analysis?.morphology?.length) {
    wrap.appendChild(h("h4", "构词分解"));
    const ul = document.createElement("ul");
    analysis.morphology.forEach((m) => {
      const li = document.createElement("li");
      li.textContent = `${m.part}（${m.kind}）— ${m.meaning}`;
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  if (analysis?.examples?.length) {
    wrap.appendChild(h("h4", "例句"));
    const ul = document.createElement("ul");
    analysis.examples.forEach((ex) => {
      const li = document.createElement("li");
      li.textContent = ex;
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  return wrap;
}

function renderSentence(data) {
  const { input, translation, analysis } = data;
  const wrap = document.createElement("div");

  wrap.appendChild(h("h3", input));
  wrap.appendChild(h("p", `翻译：${translation}`));

  if (analysis?.structure) {
    wrap.appendChild(h("p", `结构：${analysis.structure}`));
  }

  if (analysis?.components?.length) {
    wrap.appendChild(h("h4", "成分分析"));
    const ul = document.createElement("ul");
    analysis.components.forEach((c) => {
      const li = document.createElement("li");
      const note = c.note ? `（${c.note}）` : "";
      li.textContent = `[${c.role}] ${c.text} ${note}`;
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  if (analysis?.grammar_points?.length) {
    wrap.appendChild(h("h4", "语法点"));
    const ul = document.createElement("ul");
    analysis.grammar_points.forEach((g) => {
      const li = document.createElement("li");
      li.textContent = g;
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
  }

  return wrap;
}

// 小工具：创建带文本的元素
function h(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}