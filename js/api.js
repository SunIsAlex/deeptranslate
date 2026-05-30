// 翻译方向判断与后端请求

// 根据输入是否含中文判断翻译方向
export function detectDirection(text) {
  return /[一-龥]/.test(text) ? "zh2en" : "en2zh";
}

/**
 * 发起翻译请求。
 * @param {string} text 输入文本
 * @param {string} mode 分析模式（仅 en2zh 使用）
 * @param {(line: string) => void} onStage 各阶段加载日志回调
 * @returns {Promise<{res: Response, data: any, direction: string, total: number}>}
 */
export async function translate(text, mode, onStage) {
  const direction = detectDirection(text);
  const apiUrl = direction === "zh2en" ? "/api/translate-zh" : "/api/translate";
  // zh2en 不需要 mode；en2zh 带上 mode
  const payload = direction === "zh2en"
    ? JSON.stringify({ text })
    : JSON.stringify({ text, mode });

  const t0 = performance.now();
  onStage(`> POST ${apiUrl}  (${payload.length} bytes)`);

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const elapsed = Math.round(performance.now() - t0);
  onStage(`> response: ${res.status} ${res.statusText}  (${elapsed}ms)`);

  onStage(`> parsing JSON…`);
  const data = await res.json();
  const total = Math.round(performance.now() - t0);

  return { res, data, direction, total };
}
