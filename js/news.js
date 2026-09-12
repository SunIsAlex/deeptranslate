export function parseNewsHighlights(value) {
  const text = String(value || "");
  const tokens = [];
  const pattern = /(\[\[[\s\S]*?\]\]|\{\{[\s\S]*?\}\})/g;
  let offset = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) {
      tokens.push({ type: "text", text: text.slice(offset, match.index) });
    }
    const raw = match[0];
    const isPhrase = raw.startsWith("[[");
    const content = raw.slice(2, -2);
    if (content) tokens.push({ type: isPhrase ? "phrase" : "grammar", text: content });
    offset = match.index + raw.length;
  }

  if (offset < text.length) tokens.push({ type: "text", text: text.slice(offset) });
  return tokens.length ? tokens : [{ type: "text", text }];
}
