export type ComposerMode = 'auto' | 'task' | 'chat';

export const COMPOSER_MODE_STORAGE_KEY: string;
export const DEFAULT_COMPOSER_MODE: ComposerMode;

export function readComposerMode(storage: Pick<Storage, 'getItem'> | null | undefined): ComposerMode;
export function writeComposerMode(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  mode: ComposerMode,
): void;
