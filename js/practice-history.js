const STORAGE_KEY = "deeptranslate:practice-history:v1";
const MAX_TOPICS = 40;
const MAX_ITEMS_PER_TOPIC = 12;

export function loadPracticeHistory(context) {
  const store = loadStore();
  return Array.isArray(store[topicKey(context)]?.items)
    ? store[topicKey(context)].items
    : [];
}

export function addPracticeHistory(context, practice) {
  const store = loadStore();
  const key = topicKey(context);
  const existing = Array.isArray(store[key]?.items) ? store[key].items : [];
  const entry = normalizeEntry(practice);
  if (!entry) return existing;

  const items = [entry, ...existing.filter((item) => !sameQuestion(item.question, entry.question))]
    .slice(0, MAX_ITEMS_PER_TOPIC);
  store[key] = { updatedAt: new Date().toISOString(), items };
  saveStore(store);
  return items;
}

export function markPracticeAnswer(context, question, correct) {
  const store = loadStore();
  const key = topicKey(context);
  const existing = Array.isArray(store[key]?.items) ? store[key].items : [];
  const now = new Date().toISOString();
  const items = existing.map((item) =>
    sameQuestion(item.question, question)
      ? { ...item, completedAt: item.completedAt || now, correct: Boolean(correct) }
      : item
  );
  store[key] = { updatedAt: now, items };
  saveStore(store);
  return items;
}

export function clearPracticeHistory(context) {
  const store = loadStore();
  delete store[topicKey(context)];
  saveStore(store);
  return [];
}

export function sameQuestion(a, b) {
  return normalizeQuestion(a) === normalizeQuestion(b);
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  try {
    const topics = Object.entries(store)
      .sort(([, a], [, b]) => String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")))
      .slice(0, MAX_TOPICS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(topics)));
  } catch {
    // 本地存储不可用时，当前页面内的练习仍可继续。
  }
}

function topicKey(context) {
  const direction = String(context?.direction || "unknown");
  const input = String(context?.input || "").replace(/\s+/g, " ").trim().toLowerCase();
  return `${direction}:${input}`;
}

function normalizeEntry(practice) {
  const question = String(practice?.question || "").replace(/\s+/g, " ").trim();
  if (!question) return null;
  return {
    question,
    answer: String(practice.answer || "").replace(/\s+/g, " ").trim().slice(0, 180),
    kind: String(practice.kind || "auto").trim(),
    difficulty: Number(practice.difficulty) || 1,
    createdAt: new Date().toISOString(),
  };
}

function normalizeQuestion(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
