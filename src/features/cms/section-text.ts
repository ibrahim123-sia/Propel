/**
 * The words a page's sections show (headings, text, button labels), for the AI title and
 * description suggestions. Walks the section data and keeps the strings that read as text,
 * not ids, addresses or style values. Client-safe.
 */
/** Addresses, ids and lowercase tokens such as "left", "ink" or "two-column". */
const NOT_TEXT = /^(https?:|mailto:|tel:|\/|#)|^[0-9a-f-]{32,36}$|^[a-z0-9_-]+$/;

export function sectionsText(sections: unknown, max = 20_000): string {
  const out: string[] = [];
  let length = 0;
  const walk = (value: unknown) => {
    if (length >= max) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text && !NOT_TEXT.test(text)) {
        out.push(text);
        length += text.length + 1;
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(sections);
  return out.join(" ").replace(/\s+/g, " ").slice(0, max);
}
