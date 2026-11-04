import { DEFAULT_SETTINGS, type Settings } from '../config';
import { sanitizeBodies } from '../game/body';

const KEY = 'courtfeel.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // custom bodies: known positions only, clamped (a fresh object, never the shared default)
      return { ...DEFAULT_SETTINGS, ...saved, bodies: sanitizeBodies(saved?.bodies), hand: saved?.hand === 'left' ? 'left' : 'right' };
    }
  } catch {
    /* private mode / blocked storage: fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS, bodies: {} };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
