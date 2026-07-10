const VOICES = {
  us: "en-US",
  uk: "en-GB",
};

export function canSpeak() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function speakEnglish(text, variant = "us") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
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
