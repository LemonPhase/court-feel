import { DEFAULT_SETTINGS, SETTING_RANGES, TOUCH_CONTROL_MODES, type BooleanSettingKey, type NumericSettingKey, type Settings } from '../config';
import { sanitizeBodies } from '../game/body';
import { clamp } from './mathx';

const KEY = 'courtfeel.settings.v1';

/** every boolean setting (a Record so that adding one to Settings without listing it here fails to compile) */
const BOOLEAN_SETTINGS: Record<BooleanSettingKey, true> = {
  invertY: true,
  womenNet: true,
  slowmoAssist: true,
  landingMarker: true,
  replays: true,
  firstPerson: true,
  showHints: true,
};

/** the keys each validator in sanitizeSettings handles (exported for the coverage test) */
export const VALIDATED_KEYS: readonly (keyof Settings)[] = [
  ...(Object.keys(SETTING_RANGES) as NumericSettingKey[]),
  ...(Object.keys(BOOLEAN_SETTINGS) as BooleanSettingKey[]),
  'touchControls',
  'bodies',
];

/** does the OS ask for reduced motion? (false where matchMedia is unavailable) */
export function systemPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** first-visit defaults: a player whose OS asks for reduced motion starts without camera shake and automatic replays */
export function defaultSettings(prefersReducedMotion = false): Settings {
  // a fresh bodies map: the player's custom bodies are edited in place, never the shared default
  const s = { ...DEFAULT_SETTINGS, bodies: {} };
  if (prefersReducedMotion) {
    s.shake = 0;
    s.replays = false;
  }
  return s;
}

/**
 * Stored settings are untrusted: another build may have saved a field with a different type
 * or range, or the storage was edited by hand. A stored value is kept only if it has the
 * right type (numbers must be finite and are clamped to the slider range, choices must be a
 * known option); anything else falls back to the default. Unknown keys are dropped.
 */
export function sanitizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  // custom bodies: known positions only, clamped, always a fresh object (never the shared default)
  const valid = !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const out: Settings = { ...defaults, bodies: sanitizeBodies(valid ? (raw as Record<string, unknown>).bodies : undefined) };
  if (!valid) return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(SETTING_RANGES) as NumericSettingKey[]) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = SETTING_RANGES[key];
    out[key] = clamp(v, r.min, r.max);
  }
  for (const key of Object.keys(BOOLEAN_SETTINGS) as BooleanSettingKey[]) {
    const v = src[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  const tc = src.touchControls;
  if (TOUCH_CONTROL_MODES.includes(tc as Settings['touchControls'])) out.touchControls = tc as Settings['touchControls'];
  return out;
}

export function loadSettings(prefersReducedMotion = systemPrefersReducedMotion()): Settings {
  const defaults = defaultSettings(prefersReducedMotion);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw), defaults);
  } catch {
    /* private mode / blocked storage / unparseable JSON: fall back to defaults */
  }
  return defaults;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
