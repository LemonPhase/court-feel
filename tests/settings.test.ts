import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, isPositionId, SETTING_RANGES } from '../src/config';
import { parseLaunchParams } from '../src/core/launch';
import { defaultSettings, loadSettings, sanitizeSettings, VALIDATED_KEYS } from '../src/core/settings';
import { isModeId } from '../src/game/modes/mode';

describe('stored settings are validated', () => {
  it('every setting has a validator, and every default lies inside its slider range', () => {
    expect([...VALIDATED_KEYS].sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    for (const [key, r] of Object.entries(SETTING_RANGES)) {
      const v = DEFAULT_SETTINGS[key as keyof typeof SETTING_RANGES];
      expect(v, key).toBeGreaterThanOrEqual(r.min);
      expect(v, key).toBeLessThanOrEqual(r.max);
    }
  });

  it('keeps well-formed values', () => {
    const s = sanitizeSettings({ fov: 90, invertY: true, volume: 0.3, touchControls: 'off' });
    expect(s.fov).toBe(90);
    expect(s.invertY).toBe(true);
    expect(s.volume).toBe(0.3);
    expect(s.touchControls).toBe('off');
  });

  it('falls back to the default for a value of the wrong type (a renamed or retyped setting from another build)', () => {
    const s = sanitizeSettings({ fov: 'wide', volume: null, invertY: 'yes', touchControls: 'sometimes', sensitivity: NaN });
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.volume).toBe(DEFAULT_SETTINGS.volume);
    expect(s.invertY).toBe(DEFAULT_SETTINGS.invertY);
    expect(s.touchControls).toBe(DEFAULT_SETTINGS.touchControls);
    expect(s.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
  });

  it('clamps numbers to the slider range and drops unknown keys', () => {
    const s = sanitizeSettings({ sensitivity: -5, fov: 500, legacyOption: 1 });
    expect(s.sensitivity).toBe(SETTING_RANGES.sensitivity.min);
    expect(s.fov).toBe(SETTING_RANGES.fov.max);
    expect(s).not.toHaveProperty('legacyOption');
  });

  it('custom bodies are validated and always a fresh object (editing one never changes the shared default)', () => {
    const s = sanitizeSettings({ bodies: { OH: { height: 2.0, jump: 0.9, power: 1.1 }, XX: { height: 2 }, MB: 'tall' } });
    expect(Object.keys(s.bodies)).toEqual(['OH']);
    expect(s.bodies.OH?.height).toBe(2.0);
    expect(sanitizeSettings({ bodies: { OH: { height: 9 } } }).bodies.OH?.height).toBeLessThanOrEqual(2.2);
    for (const raw of [null, {}, { bodies: 'x' }]) {
      const fresh = sanitizeSettings(raw);
      expect(fresh.bodies).toEqual({});
      expect(fresh.bodies).not.toBe(DEFAULT_SETTINGS.bodies);
    }
    expect(defaultSettings(true).bodies).not.toBe(DEFAULT_SETTINGS.bodies);
  });

  it('survives garbage: null, arrays, primitives', () => {
    for (const raw of [null, undefined, 42, 'x', [1, 2]]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('reduced motion turns shake and automatic replays off for a first visit only', () => {
    const reduced = defaultSettings(true);
    expect(reduced.shake).toBe(0);
    expect(reduced.replays).toBe(false);
    expect(defaultSettings(false)).toEqual(DEFAULT_SETTINGS);
    // a value the player saved wins over the reduced-motion default
    expect(sanitizeSettings({ shake: 0.8 }, reduced).shake).toBe(0.8);
  });
});

describe('loadSettings', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubStorage = (value: string | null) =>
    vi.stubGlobal('localStorage', { getItem: () => value, setItem: () => {} } as unknown as Storage);

  it('unparseable JSON gives the defaults', () => {
    stubStorage('{not json');
    expect(loadSettings(false)).toEqual(DEFAULT_SETTINGS);
  });

  it('sanitises what is stored', () => {
    stubStorage(JSON.stringify({ fov: 'wide', volume: 0.5 }));
    const s = loadSettings(false);
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.volume).toBe(0.5);
  });

  it('blocked storage gives the defaults', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(loadSettings(true)).toEqual(defaultSettings(true));
  });
});

describe('quick-start links', () => {
  it('parses a full link', () => {
    expect(parseLaunchParams('?mode=spike&pos=MB&cam=fp&bot=good&hand=left')).toEqual({
      mode: 'spike',
      pos: 'MB',
      cam: 'fp',
      bot: 'good',
      hand: 'left',
      level: null,
    });
  });

  it('a link can pick the Mini Rally level of play; an unknown level is ignored', () => {
    expect(parseLaunchParams('?mode=rally&pos=L&level=club')?.level).toBe('club');
    expect(parseLaunchParams('?mode=rally&level=legend')?.level).toBeNull();
    expect(parseLaunchParams('?mode=rally&level=toString')?.level).toBeNull();
  });

  it('a mistyped position falls back to the outside hitter instead of crashing', () => {
    expect(parseLaunchParams('?mode=spike&pos=OHH')?.pos).toBe('OH');
    expect(parseLaunchParams('?mode=rally')?.pos).toBe('OH');
  });

  it('an unknown mode is no quick start (the menu opens)', () => {
    expect(parseLaunchParams('?mode=spikey&pos=OH')).toBeNull();
    expect(parseLaunchParams('')).toBeNull();
  });

  it('unknown camera, bot and hand values are ignored', () => {
    expect(parseLaunchParams('?mode=block&cam=drone&bot=godmode&hand=ambi')).toEqual({
      mode: 'block',
      pos: 'OH',
      cam: null,
      bot: null,
      hand: null,
      level: null,
    });
  });

  it('inherited object keys are not ids', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isModeId(k), k).toBe(false);
      expect(isPositionId(k), k).toBe(false);
    }
  });
});
