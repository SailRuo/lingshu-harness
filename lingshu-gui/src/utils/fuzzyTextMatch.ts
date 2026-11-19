/** Substring / token / subsequence matching for chat history search. */
export function tokenizeSearchQuery(query: string): string[] {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function fuzzyMatchText(haystack: string, query: string): boolean {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const source = String(haystack || '').toLowerCase();
  if (!source) return false;
  if (source.includes(needle)) return true;

  const tokens = tokenizeSearchQuery(needle);
  if (tokens.length > 1 && tokens.every((token) => source.includes(token))) {
    return true;
  }

  const compactNeedle = needle.replace(/\s+/g, '');
  const compactSource = source.replace(/\s+/g, '');
  if (!compactNeedle) return true;
  let index = 0;
  for (const char of compactSource) {
    if (char === compactNeedle[index]) {
      index += 1;
      if (index >= compactNeedle.length) return true;
    }
  }
  return false;
}

export function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function highlightFuzzyMatches(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const tokens = [...new Set(tokenizeSearchQuery(query))].sort((a, b) => b.length - a.length);
  if (!tokens.length) return escaped;
  let result = escaped;
  for (const token of tokens) {
    const pattern = escapeHtml(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!pattern) continue;
    result = result.replace(new RegExp(pattern, 'gi'), (match) => `<mark>${match}</mark>`);
  }
  return result;
}
