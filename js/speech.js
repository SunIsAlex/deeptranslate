const VOICES = {
  us: "en-US",
  uk: "en-GB",
};

export function canSpeak() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function englishSpeechText(text) {
  const source = String(text || "").replace(/\[\[|\]\]/g, "");
  const chinese = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const translatedSuffix = /\s+(?:—|–|-)\s+(?=[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/;
  return source
    .split(translatedSuffix, 1)[0]
    .split(chinese, 1)[0]
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
