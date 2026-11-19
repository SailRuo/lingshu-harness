export type ThemeMode = 'light' | 'dark' | 'system';

export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark';

export function applyThemeToDocument(
  doc: Document,
  mode: ThemeMode,
  getSystemPrefersDark?: () => boolean,
): void;
