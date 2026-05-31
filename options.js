const DEFAULTS = {
  endpoint: "https://api.sunisalex.org/api/translate",
  hotkey: "F2",
};

const endpointEl = document.getElementById("endpoint");
const hotkeyEl = document.getElementById("hotkey");
const savedEl = document.getElementById("saved");

chrome.storage.sync.get(DEFAULTS).then((cfg) => {
  endpointEl.value = cfg.endpoint;
  hotkeyEl.value = cfg.hotkey;
});

// 点进快捷键框后按一下键 → 自动填入对应 KeyboardEvent.key
hotkeyEl.addEventListener("keydown", (e) => {
  e.preventDefault();
  hotkeyEl.value = e.key;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    endpoint: endpointEl.value.trim() || DEFAULTS.endpoint,
    hotkey: hotkeyEl.value.trim() || DEFAULTS.hotkey,
  });
  savedEl.textContent = "已保存 ✓";
  setTimeout(() => (savedEl.textContent = ""), 1500);
});
