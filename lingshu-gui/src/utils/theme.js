export function resolveThemeMode(mode, prefersDark) {
  if (mode === 'system') {
    return prefersDark ? 'dark' : 'light';
  }

  return mode === 'dark' ? 'dark' : 'light';
}

export function applyThemeToDocument(doc, mode, getSystemPrefersDark = defaultSystemPrefersDark) {
  if (!doc?.documentElement || !doc?.body) {
    return;
  }

  const actualMode = resolveThemeMode(mode, getSystemPrefersDark());
  doc.documentElement.setAttribute('data-theme', actualMode);

  if (actualMode === 'dark') {
    doc.body.setAttribute('arco-theme', 'dark');
    return;
  }

  doc.body.removeAttribute('arco-theme');
}

function defaultSystemPrefersDark() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
