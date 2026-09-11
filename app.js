// 入口控制器：提交流程、加载日志、路由恢复、复制、事件绑定
import {
  inputEl, translateToolTabEl, vocabularyToolTabEl,
  translationModeOptionEl, grammarAnalysisOptionEl, targetLanguageEl,
  inputPanelLabelEl, outputPanelLabelEl, inputHelpEl,
  modeEl, grammarAnalysisEl, vocabularyDifficultyEl, modelEl,
  submitBtn, statusEl, outputEl, copyBtn,
  followUpEl, followUpThreadEl, followUpInputEl, followUpBtn,
  vocabCountEl, vocabCurrentEl, vocabCurrentTermEl, vocabCurrentMetaEl,
  addCurrentVocabBtn, suggestVocabBtn, vocabSuggestStatusEl,
  vocabSuggestionsEl, vocabListEl, clearVocabBtn,
  practiceEl, practiceKindEl, generatePracticeBtn, practiceBodyEl, practiceStatusEl,
  practiceCountEl, clearPracticeHistoryBtn,
} from "./js/dom.js";
import {
  askFollowUp,
  detectDirection,
  fetchPractice,
  fetchRelatedWords,
  fetchVocabularyHelper,
  translate,
} from "./js/api.js";
import { render, renderMarkdown, renderStreaming } from "./js/render.js";
import {
  clearVocabulary,
  hasVocabularyEntry,
  loadVocabulary,
  normalizeTerm,
  removeVocabularyEntry,
  upsertVocabularyEntry,
  upsertVocabularyEntries,
} from "./js/vocabulary.js";
import {
  addPracticeHistory,
  clearPracticeHistory,
  loadPracticeHistory,
  markPracticeAnswer,
  sameQuestion,
} from "./js/practice-history.js";

let currentTranslation = null;
let currentVocabCandidate = null;
let followUpHistory = [];
let followUpController = null;
let currentPractice = null;
let practiceHistory = [];
let currentTool = "translate";

// ── 加载日志与状态 ──────────────────────────────
function setStage(line) {
  let pre = outputEl.querySelector(".loading-stage");
  if (!pre) {
    outputEl.innerHTML = '<pre class="loading-stage"></pre>';
    pre = outputEl.querySelector(".loading-stage");
  }
  pre.textContent += line + "\n";
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ── 小工具 ─────────────────────────────────────
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function setToolTabsDisabled(disabled) {
  translateToolTabEl.disabled = disabled;
  vocabularyToolTabEl.disabled = disabled;
}

function setToolMode(tool) {
  if (tool === currentTool) return;
  currentTool = tool;
  resetFollowUp();
  resetVocabCurrent();
  resetPractice();
  inputEl.value = "";
  statusEl.textContent = "";
  copyBtn.hidden = true;

  const isVocabulary = tool === "vocabulary";
  translateToolTabEl.classList.toggle("is-active", !isVocabulary);
  vocabularyToolTabEl.classList.toggle("is-active", isVocabulary);
  translateToolTabEl.setAttribute("aria-selected", String(!isVocabulary));
  vocabularyToolTabEl.setAttribute("aria-selected", String(isVocabulary));
  translationModeOptionEl.hidden = isVocabulary;
  grammarAnalysisOptionEl.hidden = isVocabulary;
  vocabularyDifficultyEl.hidden = !isVocabulary;
  targetLanguageEl.innerHTML = isVocabulary
    ? "English <small>按主题学习</small>"
    : "中文 / English <small>双向翻译</small>";
  inputPanelLabelEl.textContent = isVocabulary ? "输入主题" : "输入文本";
  outputPanelLabelEl.textContent = isVocabulary ? "主题词汇" : "翻译结果";
  inputEl.placeholder = isVocabulary ? "例如：fitness、健康、online safety" : "输入英文或中文";
  if (isVocabulary) inputEl.setAttribute("maxlength", "80");
  else inputEl.removeAttribute("maxlength");
  inputHelpEl.textContent = isVocabulary ? "支持中文或英文主题" : "支持单词、短语与完整句子";
  submitBtn.textContent = isVocabulary ? "生成词汇" : "翻译";
  outputEl.innerHTML = `<div class="output-placeholder">${isVocabulary ? "分类词汇会显示在这里" : "翻译结果会显示在这里"}</div>`;
  inputEl.focus();
}

function resetFollowUp() {
  followUpController?.abort();
  followUpController = null;
  currentTranslation = null;
  followUpHistory = [];
  followUpThreadEl.innerHTML = "";
  followUpInputEl.value = "";
  followUpEl.hidden = true;
  followUpBtn.disabled = false;
  followUpInputEl.disabled = false;
}

function resetVocabCurrent() {
  currentVocabCandidate = null;
  vocabCurrentEl.hidden = true;
  vocabCurrentTermEl.textContent = "";
  vocabCurrentMetaEl.textContent = "";
  vocabSuggestStatusEl.textContent = "";
  vocabSuggestionsEl.innerHTML = "";
}

function resetPractice() {
  currentPractice = null;
  practiceHistory = [];
  practiceEl.hidden = true;
  practiceBodyEl.innerHTML = "";
  practiceStatusEl.textContent = "";
  generatePracticeBtn.disabled = false;
  generatePracticeBtn.textContent = "生成练习";
  updatePracticeProgress();
}

function preparePractice() {
  currentPractice = null;
  practiceHistory = loadPracticeHistory(currentTranslation);
  practiceEl.hidden = false;
  practiceStatusEl.textContent = "";
  practiceBodyEl.innerHTML = '<p class="practice-empty">尚未生成练习</p>';
  generatePracticeBtn.disabled = false;
  generatePracticeBtn.textContent = "生成练习";
  updatePracticeProgress();
}

function updatePracticeProgress() {
  const completed = practiceHistory.filter((item) => item.completedAt).length;
  practiceCountEl.textContent = `${completed} 已练 / ${practiceHistory.length} 题`;
  clearPracticeHistoryBtn.disabled = practiceHistory.length === 0;
}

function nextPracticeDifficulty() {
  const completed = practiceHistory.filter((item) => item.completedAt).length;
  return Math.min(4, 1 + Math.floor(completed / 2));
}

function difficultyLabel(value) {
  return ["", "基础识别", "应用练习", "辨析进阶", "表达挑战"][value] || "基础识别";
}

function renderPractice(practice) {
  currentPractice = practice;
  practiceBodyEl.innerHTML = "";

  const prompt = document.createElement("p");
  prompt.className = "practice-prompt";
  prompt.textContent = `${difficultyLabel(practice.difficulty)} · ${practice.prompt}`;
  const question = document.createElement("p");
  question.className = "practice-question";
  question.textContent = practice.question;
  practiceBodyEl.append(prompt, question);

  if (practice.kind === "choice") {
    const choices = document.createElement("div");
    choices.className = "practice-choices";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-label", "选择答案");
    practice.choices.forEach((choice, index) => {
      const option = document.createElement("label");
      option.className = "practice-choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "practice-answer";
      input.value = choice;
      input.id = `practice-choice-${index}`;
      const text = document.createElement("span");
      text.textContent = choice;
      option.append(input, text);
      choices.appendChild(option);
    });
    practiceBodyEl.appendChild(choices);
  } else {
    const answerInput = document.createElement("input");
    answerInput.className = "practice-answer-input";
    answerInput.type = "text";
    answerInput.autocomplete = "off";
    answerInput.placeholder = "输入你的答案";
    answerInput.setAttribute("aria-label", "你的答案");
    practiceBodyEl.appendChild(answerInput);
  }

  const actions = document.createElement("div");
  actions.className = "practice-actions";
  const checkBtn = document.createElement("button");
  checkBtn.type = "button";
  checkBtn.className = "secondary-btn";
  checkBtn.textContent = "检查答案";
  checkBtn.addEventListener("click", checkPracticeAnswer);
  actions.appendChild(checkBtn);
  practiceBodyEl.appendChild(actions);
}

function checkPracticeAnswer() {
  if (!currentPractice) return;
  const answer = currentPractice.kind === "choice"
    ? practiceBodyEl.querySelector('input[name="practice-answer"]:checked')?.value || ""
    : practiceBodyEl.querySelector(".practice-answer-input")?.value.trim() || "";
  if (!answer) {
    practiceStatusEl.textContent = "请选择或输入答案";
    return;
  }

  const accepted = currentPractice.acceptedAnswers || [currentPractice.answer];
  const correct = accepted.some((item) => normalizePracticeAnswer(item) === normalizePracticeAnswer(answer));
  practiceHistory = markPracticeAnswer(currentTranslation, currentPractice.question, correct);
  updatePracticeProgress();
  const oldFeedback = practiceBodyEl.querySelector(".practice-feedback");
  oldFeedback?.remove();

  const feedback = document.createElement("div");
  feedback.className = `practice-feedback ${correct ? "is-correct" : "is-reference"}`;
  const title = document.createElement("strong");
  title.textContent = correct ? "回答正确" : "参考答案";
  const answerText = document.createElement("p");
  answerText.textContent = currentPractice.answer;
  const explanation = document.createElement("p");
  explanation.textContent = currentPractice.explanation;
  feedback.append(title, answerText, explanation);
  practiceBodyEl.appendChild(feedback);
  practiceStatusEl.textContent = "";
}

function normalizePracticeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function followUpContext(data) {
  const {
    direction, input, type, translation,
    senses, analysis, translations,
  } = data;
  return {
    direction,
    input,
    type,
    translation,
    senses,
    analysis,
    translations,
  };
}

function appendFollowUpMessage(role, text = "") {
  const message = document.createElement("div");
  message.className = `follow-up-message follow-up-${role}`;
  message.textContent = text;
  followUpThreadEl.appendChild(message);
  return message;
}

function relationLabel(value) {
  const labels = {
    synonym: "近义",
    antonym: "反义",
    related: "相关",
    word_family: "词族",
    phrase: "短语",
  };
  return labels[value] || "相关";
}

function vocabNote(item) {
  const parts = [];
  if (item.category) parts.push(item.category);
  if (item.relation) parts.push(relationLabel(item.relation));
  if (item.partOfSpeech) parts.push(item.partOfSpeech);
  if (item.translation || item.note) parts.push(item.translation || item.note);
  return parts.join(" · ");
}

function getVocabCandidate(data) {
  if (data.direction !== "en2zh" || !["word", "phrase"].includes(data.type)) return null;
  const term = normalizeTerm(data.input);
  if (!term || term.length > 80) return null;

  const senses = Array.isArray(data.senses)
    ? data.senses.map((sense) => sense?.zh).filter(Boolean)
    : [];
  const partsOfSpeech = Array.isArray(data.senses)
    ? [...new Set(data.senses.map((sense) => sense?.pos).filter(Boolean))]
    : [];
  const translation = senses.length ? senses.slice(0, 3).join("；") : data.translation || "";
  return {
    term,
    translation,
    note: partsOfSpeech.join("/") || data.analysis?.pos || "",
    source: "search",
  };
}

function setCurrentVocabCandidate(data) {
  currentVocabCandidate = getVocabCandidate(data);
  vocabSuggestionsEl.innerHTML = "";
  vocabSuggestStatusEl.textContent = "";

  if (!currentVocabCandidate) {
    vocabCurrentEl.hidden = true;
    return;
  }

  vocabCurrentEl.hidden = false;
  vocabCurrentTermEl.textContent = currentVocabCandidate.term;
  vocabCurrentMetaEl.textContent = currentVocabCandidate.translation || currentVocabCandidate.note;
  refreshCurrentVocabButton();
}

function refreshCurrentVocabButton() {
  if (!currentVocabCandidate) return;
  const saved = hasVocabularyEntry(currentVocabCandidate.term);
  addCurrentVocabBtn.textContent = saved ? "已加入" : "加入";
  addCurrentVocabBtn.disabled = saved;
}

function renderVocabulary() {
  const items = loadVocabulary();
  vocabCountEl.textContent = `${items.length} 个`;
  clearVocabBtn.disabled = items.length === 0;
  vocabListEl.innerHTML = "";

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "vocab-item";

    const info = document.createElement("div");
    info.className = "vocab-info";
    const term = document.createElement("strong");
    term.textContent = item.term;
    const note = document.createElement("div");
    note.className = "vocab-note";
    note.textContent = vocabNote(item);
    info.append(term, note);
    if (item.example) {
      const example = document.createElement("div");
      example.className = "vocab-example";
      example.textContent = item.exampleTranslation
        ? `${item.example} — ${item.exampleTranslation}`
        : item.example;
      info.appendChild(example);
    }

    const actions = document.createElement("div");
    actions.className = "vocab-actions";
    const searchBtn = document.createElement("button");
    searchBtn.className = "text-btn";
    searchBtn.type = "button";
    searchBtn.textContent = "查询";
    searchBtn.addEventListener("click", () => {
      if (currentTool !== "translate") setToolMode("translate");
      inputEl.value = item.term;
      modeEl.value = "word";
      handleSubmit();
    });
    const removeBtn = document.createElement("button");
    removeBtn.className = "text-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "删除";
    removeBtn.addEventListener("click", () => {
      removeVocabularyEntry(item.term);
      renderVocabulary();
      refreshCurrentVocabButton();
    });
    actions.append(searchBtn, removeBtn);

    row.append(info, actions);
    vocabListEl.appendChild(row);
  });
}

function renderRelatedSuggestions(items) {
  vocabSuggestionsEl.innerHTML = "";
  const normalizedItems = items
    .map((item) => ({
      term: normalizeTerm(item.term),
      relation: normalizeTerm(item.relation),
      note: normalizeTerm(item.note),
      translation: normalizeTerm(item.translation),
    }))
    .filter((item) => item.term)
    .filter((item, index, all) =>
      all.findIndex((other) => other.term.toLowerCase() === item.term.toLowerCase()) === index
    );

  normalizedItems.forEach((item) => {
    const chip = document.createElement("button");
    chip.className = "vocab-chip";
    chip.type = "button";
    const saved = hasVocabularyEntry(item.term);
    chip.textContent = `${item.term} · ${relationLabel(item.relation)}`;
    if (item.note || item.translation) chip.title = item.note || item.translation;
    chip.disabled = saved;
    if (saved) chip.textContent += " ✓";
    chip.addEventListener("click", () => {
      upsertVocabularyEntry({
        ...item,
        relatedTo: currentVocabCandidate?.term || "",
        source: "related",
      });
      chip.disabled = true;
      chip.textContent = `${item.term} · ${relationLabel(item.relation)} ✓`;
      renderVocabulary();
      refreshCurrentVocabButton();
    });
    vocabSuggestionsEl.appendChild(chip);
  });
}

function topicVocabularyEntries(data) {
  return (data.categories || []).flatMap((category) => {
    const categoryLabel = [category.nameZh, category.nameEn].filter(Boolean).join(" / ");
    return (category.items || []).map((item) => ({
      ...item,
      topic: data.topic,
      category: categoryLabel,
      relatedTo: data.topic,
      source: "topic",
    }));
  });
}

function vocabularyDifficultyLabel(value) {
  const labels = {
    beginner: "基础 A1–A2",
    intermediate: "中级 B1–B2",
    advanced: "进阶 B2–C1",
    expert: "专家 C1–C2",
  };
  return labels[value] || labels.advanced;
}

function renderTopicVocabulary(data) {
  outputEl.innerHTML = "";
  const root = document.createElement("div");
  root.className = "topic-result";

  const heading = document.createElement("div");
  heading.className = "topic-heading";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = data.topic;
  titleWrap.appendChild(title);
  const subtitleParts = [];
  if (data.topicTranslation && data.topicTranslation.toLowerCase() !== data.topic.toLowerCase()) {
    subtitleParts.push(data.topicTranslation);
  }
  subtitleParts.push(vocabularyDifficultyLabel(data.difficulty));
  if (subtitleParts.length) {
    const subtitle = document.createElement("div");
    subtitle.className = "topic-subtitle";
    subtitle.textContent = subtitleParts.join(" · ");
    titleWrap.appendChild(subtitle);
  }

  const saveAllBtn = document.createElement("button");
  saveAllBtn.className = "secondary-btn";
  saveAllBtn.type = "button";
  saveAllBtn.textContent = "全部加入生词本";
  saveAllBtn.addEventListener("click", () => {
    const entries = topicVocabularyEntries(data);
    const newCount = entries.filter((item) => !hasVocabularyEntry(item.term)).length;
    upsertVocabularyEntries(entries);
    renderVocabulary();
    renderTopicVocabulary(data);
    const skippedCount = entries.length - newCount;
    setStatus(`新增 ${newCount} 个，跳过 ${skippedCount} 个已有词条`);
  });
  if (topicVocabularyEntries(data).every((item) => hasVocabularyEntry(item.term))) {
    saveAllBtn.disabled = true;
    saveAllBtn.textContent = "已全部加入";
  }
  heading.append(titleWrap, saveAllBtn);
  root.appendChild(heading);

  (data.categories || []).forEach((category) => {
    const section = document.createElement("section");
    section.className = "topic-category";
    const categoryTitle = document.createElement("h4");
    categoryTitle.textContent = category.nameZh || category.nameEn;
    if (category.nameZh && category.nameEn) {
      const enName = document.createElement("span");
      enName.textContent = category.nameEn;
      categoryTitle.appendChild(enName);
    }
    const items = document.createElement("div");
    items.className = "topic-items";

    (category.items || []).forEach((item) => {
      const row = document.createElement("article");
      row.className = "topic-item";
      const main = document.createElement("div");
      main.className = "topic-item-main";
      const label = document.createElement("div");
      const term = document.createElement("span");
      term.className = "topic-term";
      term.textContent = item.term;
      label.appendChild(term);
      if (item.partOfSpeech) {
        const pos = document.createElement("span");
        pos.className = "topic-pos";
        pos.textContent = item.partOfSpeech;
        label.appendChild(pos);
      }
      const translation = document.createElement("span");
      translation.className = "topic-translation";
      translation.textContent = item.translation;
      label.appendChild(translation);

      const saveBtn = document.createElement("button");
      saveBtn.className = "text-btn topic-save";
      saveBtn.type = "button";
      const saved = hasVocabularyEntry(item.term);
      saveBtn.textContent = saved ? "已加入" : "加入";
      saveBtn.disabled = saved;
      saveBtn.addEventListener("click", () => {
        const categoryLabel = [category.nameZh, category.nameEn].filter(Boolean).join(" / ");
        upsertVocabularyEntry({
          ...item,
          topic: data.topic,
          category: categoryLabel,
          relatedTo: data.topic,
          source: "topic",
        });
        renderVocabulary();
        renderTopicVocabulary(data);
        setStatus(`已加入 ${item.term}`);
      });
      main.append(label, saveBtn);

      const example = document.createElement("p");
      example.className = "topic-example";
      example.textContent = item.example;
      row.append(main, example);
      if (item.exampleTranslation) {
        const exampleZh = document.createElement("p");
        exampleZh.className = "topic-example-zh";
        exampleZh.textContent = item.exampleTranslation;
        row.appendChild(exampleZh);
      }
      items.appendChild(row);
    });
    section.append(categoryTitle, items);
    root.appendChild(section);
  });

  outputEl.appendChild(root);
}

// ── 提交流程 ───────────────────────────────────
async function handleSubmit() {
  const text = inputEl.value.trim();
  if (!text) {
    setStatus("请输入内容");
    return;
  }

  outputEl.innerHTML = "";
  resetFollowUp();
  resetVocabCurrent();
  resetPractice();
  submitBtn.disabled = true;
  setToolTabsDisabled(true);
  copyBtn.hidden = true;
  setStatus("");

  const direction = detectDirection(text);
  const settings = {
    grammarAnalysis: grammarAnalysisEl.checked,
    model: modelEl.value,
  };
  setStage(`> input: "${truncate(text, 50)}"`);
  setStage(`> direction: ${direction}  |  length: ${text.length} chars`);
  setStage(`> model: ${settings.model}  |  grammar: ${settings.grammarAnalysis ? "ON" : "OFF"}`);

  try {
    const partial = { input: text, translation: "", senses: [], examples: [] };
    const onStreamEvent = (event, data) => {
      if (event === "translation") {
        partial.translation = data.text || "";
        renderStreaming(partial);
        setStatus("生成中…");
      } else if (event === "senses" && Array.isArray(data.items)) {
        partial.senses = data.items;
        renderStreaming(partial);
      } else if (event === "example" && data.text) {
        partial.examples[data.index ?? partial.examples.length] = data.text;
        renderStreaming(partial);
      } else if (event === "result") {
        render(data);
        setStatus(data._cached ? "缓存" : "");
        currentTranslation = followUpContext(data);
        setCurrentVocabCandidate(data);
        followUpEl.hidden = false;
        preparePractice();
      }
    };
    const { res, data, total } = await translate(
      text,
      modeEl.value,
      setStage,
      onStreamEvent,
      settings,
    );

    if (!res.ok) {
      setStatus(data.message || data.error || `请求失败 ${res.status}`);
      return;
    }

    const typeLabel = data.direction === "zh2en" ? "zh2en" : data.type;
    setStage(`> type: ${typeLabel}  |  cached: ${data._cached ? "HIT" : "MISS"}  |  ${total}ms`);
    setStage(`> rendering…`);

    setStatus(data._cached ? "缓存" : "");
    copyBtn.hidden = false;
    render(data);
    currentTranslation = followUpContext(data);
    setCurrentVocabCandidate(data);
    followUpEl.hidden = false;
    preparePractice();
    updateUrl(data, text);
  } catch (err) {
    setStage(`> ERROR: ${err.message}`);
    setStatus(`网络错误：${err.message}`);
  } finally {
    submitBtn.disabled = false;
    setToolTabsDisabled(false);
  }
}

async function handleVocabularySubmit() {
  const topic = inputEl.value.replace(/\s+/g, " ").trim();
  if (!topic) {
    setStatus("请输入主题");
    return;
  }

  outputEl.innerHTML = "";
  resetFollowUp();
  resetVocabCurrent();
  resetPractice();
  submitBtn.disabled = true;
  setToolTabsDisabled(true);
  copyBtn.hidden = true;
  setStatus("");
  setStage(`> topic: "${truncate(topic, 50)}"`);
  setStage(`> difficulty: ${vocabularyDifficultyLabel(vocabularyDifficultyEl.value)}`);
  setStage(`> model: ${modelEl.value}  |  target: 20 words / 4 categories`);

  try {
    const data = await fetchVocabularyHelper({
      topic,
      difficulty: vocabularyDifficultyEl.value,
      model: modelEl.value,
    });
    renderTopicVocabulary(data);
    const count = topicVocabularyEntries(data).length;
    setStatus(`已生成 ${count} 个词条`);
  } catch (error) {
    setStage(`> ERROR: ${error.message}`);
    setStatus(`生成失败：${error.message}`);
  } finally {
    submitBtn.disabled = false;
    setToolTabsDisabled(false);
  }
}

function handlePrimarySubmit() {
  return currentTool === "vocabulary" ? handleVocabularySubmit() : handleSubmit();
}

async function handleFollowUp() {
  const question = followUpInputEl.value.trim();
  if (!question || !currentTranslation || followUpController) return;

  appendFollowUpMessage("user", question);
  const answerEl = appendFollowUpMessage("assistant");
  answerEl.classList.add("streaming");
  followUpInputEl.value = "";
  followUpInputEl.disabled = true;
  followUpBtn.disabled = true;
  followUpBtn.textContent = "回答中…";

  const controller = new AbortController();
  followUpController = controller;
  let streamedAnswer = "";
  let renderFrame = null;

  try {
    const answer = await askFollowUp({
      question,
      context: currentTranslation,
      history: followUpHistory.slice(-8),
      model: modelEl.value,
      signal: controller.signal,
      onDelta(delta) {
        streamedAnswer += delta;
        if (renderFrame === null) {
          renderFrame = requestAnimationFrame(() => {
            renderFrame = null;
            renderMarkdown(answerEl, streamedAnswer);
          });
        }
      },
    });
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
    renderMarkdown(answerEl, answer);
    followUpHistory.push({ question, answer });
  } catch (error) {
    if (renderFrame !== null) cancelAnimationFrame(renderFrame);
    renderFrame = null;
    if (error.name !== "AbortError") {
      answerEl.textContent = `回答失败：${error.message}`;
      answerEl.classList.add("follow-up-error");
    }
  } finally {
    answerEl.classList.remove("streaming");
    if (followUpController === controller) {
      followUpController = null;
      followUpInputEl.disabled = false;
      followUpBtn.disabled = false;
      followUpBtn.textContent = "提问";
      followUpInputEl.focus();
    }
  }
}

// 把当前查询写入地址栏，便于复制分享
function updateUrl(data, text) {
  if (data.direction === "zh2en") {
    history.pushState(null, "", `/zh/${encodeURIComponent(text)}`);
  } else {
    const prefixMap = { word: "w", phrase: "p", sentence: "s" };
    const prefix = prefixMap[data.type] || "s";
    history.pushState(null, "", `/${prefix}/${encodeURIComponent(text)}`);
  }
}

// ── 事件绑定 ───────────────────────────────────
submitBtn.addEventListener("click", handlePrimarySubmit);
translateToolTabEl.addEventListener("click", () => setToolMode("translate"));
vocabularyToolTabEl.addEventListener("click", () => setToolMode("vocabulary"));
followUpBtn.addEventListener("click", handleFollowUp);

generatePracticeBtn.addEventListener("click", async () => {
  if (!currentTranslation) return;
  generatePracticeBtn.disabled = true;
  generatePracticeBtn.textContent = "生成中…";
  practiceStatusEl.textContent = "";

  try {
    const practice = await requestFreshPractice();
    practiceHistory = addPracticeHistory(currentTranslation, practice);
    updatePracticeProgress();
    renderPractice(practice);
  } catch (error) {
    practiceStatusEl.textContent = error.message || "练习生成失败";
  } finally {
    generatePracticeBtn.disabled = false;
    generatePracticeBtn.textContent = "换一题";
  }
});

clearPracticeHistoryBtn.addEventListener("click", () => {
  if (!currentTranslation || !practiceHistory.length) return;
  practiceHistory = clearPracticeHistory(currentTranslation);
  currentPractice = null;
  practiceBodyEl.innerHTML = '<p class="practice-empty">尚未生成练习</p>';
  practiceStatusEl.textContent = "记录已清空";
  updatePracticeProgress();
});

async function requestFreshPractice() {
  const difficulty = nextPracticeDifficulty();
  let history = practiceHistory;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const practice = await fetchPractice({
      context: currentTranslation,
      kind: practiceKindEl.value,
      model: modelEl.value,
      history,
      difficulty,
    });
    if (!history.some((item) => sameQuestion(item.question, practice.question))) {
      return practice;
    }
    history = [{ question: practice.question, answer: practice.answer, kind: practice.kind, difficulty }, ...history];
  }

  throw new Error("未能生成新题，请重试");
}

addCurrentVocabBtn.addEventListener("click", () => {
  if (!currentVocabCandidate) return;
  upsertVocabularyEntry(currentVocabCandidate);
  renderVocabulary();
  refreshCurrentVocabButton();
});

suggestVocabBtn.addEventListener("click", async () => {
  if (!currentVocabCandidate || !currentTranslation) return;
  suggestVocabBtn.disabled = true;
  vocabSuggestStatusEl.textContent = "联想中…";
  vocabSuggestionsEl.innerHTML = "";

  try {
    const items = await fetchRelatedWords({
      input: currentVocabCandidate.term,
      context: currentTranslation,
      model: modelEl.value,
    });
    renderRelatedSuggestions(items);
    vocabSuggestStatusEl.textContent = items.length ? "" : "无结果";
  } catch (error) {
    vocabSuggestStatusEl.textContent = error.message || "联想失败";
  } finally {
    suggestVocabBtn.disabled = false;
  }
});

clearVocabBtn.addEventListener("click", () => {
  if (!loadVocabulary().length) return;
  clearVocabulary();
  renderVocabulary();
  refreshCurrentVocabButton();
  renderRelatedSuggestions([]);
  vocabSuggestStatusEl.textContent = "";
});

inputEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handlePrimarySubmit();
  }
});

followUpInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleFollowUp();
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`https://deeptranslate.sunisalex.org${location.pathname}`);
    copyBtn.classList.add("copied");
    copyBtn.title = "已复制";
    copyBtn.setAttribute("aria-label", "分享链接已复制");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.title = "复制分享链接";
      copyBtn.setAttribute("aria-label", "复制分享链接");
    }, 1500);
  } catch {
    setStatus("复制失败");
  }
});

renderVocabulary();

// ── 页面加载时读取 URL 路径，恢复查询 ───────────
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
