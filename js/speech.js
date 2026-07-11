const VOICES = {
  us: "en-US",
  uk: "en-GB",
};

export function canSpeak() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function englishSpeechText(text) {
  return String(text || "")
    .replace(/\[\[|\]\]/g, "")
    .split(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, 1)[0]
    .replace(/\s*[—–-]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speakEnglish(text, variant = "us") {
  const source = englishSpeechText(text);
  if (!source || !canSpeak()) return false;

  const locale = VOICES[variant] || VOICES.us;
  const utterance = new SpeechSynthesisUtterance(source);
  utterance.lang = locale;
  utterance.rate = 0.88;

  const voice = speechSynthesis.getVoices().find((item) =>
    item.lang.toLowerCase().startsWith(locale.toLowerCase())
  );
  if (voice) utterance.voice = voice;

  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
  return true;
}
