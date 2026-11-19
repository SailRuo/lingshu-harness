export const COMPOSER_MODE_STORAGE_KEY = 'lingshu-chat-composer-mode';
export const DEFAULT_COMPOSER_MODE = 'auto';
const VALID_COMPOSER_MODES = new Set(['auto', 'task', 'chat']);

function isValidComposerMode(value) {
  return typeof value === 'string' && VALID_COMPOSER_MODES.has(value);
}

export function readComposerMode(storage) {
  if (!storage?.getItem) return DEFAULT_COMPOSER_MODE;
  try {
    const stored = storage.getItem(COMPOSER_MODE_STORAGE_KEY);
    return isValidComposerMode(stored) ? stored : DEFAULT_COMPOSER_MODE;
  } catch {
    return DEFAULT_COMPOSER_MODE;
  }
}

export function writeComposerMode(storage, mode) {
  if (!storage?.setItem || !isValidComposerMode(mode)) return;
  try {
    storage.setItem(COMPOSER_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore persistence errors so the composer still works in restricted environments.
  }
}
