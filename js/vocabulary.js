const STORAGE_KEY = "deeptranslate:vocabulary:v1";
const MAX_ITEMS = 500;

export function loadVocabulary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
  } catch {
    return [];
  }
}

export function saveVocabulary(items) {
  const normalized = dedupe(items).slice(0, MAX_ITEMS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function upsertVocabularyEntry(entry) {
  const term = normalizeTerm(entry.term);
  if (!term) return loadVocabulary();

  const now = new Date().toISOString();
  const items = loadVocabulary();
  const index = items.findIndex((item) => sameTerm(item.term, term));
  const nextEntry = {
    term,
    translation: String(entry.translation || "").trim(),
    relation: String(entry.relation || "").trim(),
    note: String(entry.note || "").trim(),
    relatedTo: normalizeTerm(entry.relatedTo || ""),
    source: String(entry.source || "manual").trim(),
    addedAt: now,
    updatedAt: now,
  };

  if (index >= 0) {
    const existing = items[index];
    items[index] = {
      ...existing,
      ...withoutEmpty(nextEntry),
      addedAt: existing.addedAt || now,
      updatedAt: now,
    };
  } else {
    items.unshift(nextEntry);
  }

  return saveVocabulary(items);
}

export function removeVocabularyEntry(term) {
  return saveVocabulary(loadVocabulary().filter((item) => !sameTerm(item.term, term)));
}

export function clearVocabulary() {
  localStorage.removeItem(STORAGE_KEY);
  return [];
}

export function hasVocabularyEntry(term) {
  return loadVocabulary().some((item) => sameTerm(item.term, term));
}

export function sameTerm(a, b) {
  return normalizeTerm(a).toLowerCase() === normalizeTerm(b).toLowerCase();
}

export function normalizeTerm(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  items.forEach((item) => {
    const key = normalizeTerm(item.term).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(item);
  });
  return result;
}

function withoutEmpty(entry) {
  const out = {};
  Object.entries(entry).forEach(([key, value]) => {
    if (value !== "") out[key] = value;
  });
  return out;
}

function isValidEntry(entry) {
  return entry && typeof entry === "object" && normalizeTerm(entry.term);
}
