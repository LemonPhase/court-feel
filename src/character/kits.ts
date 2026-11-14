import { Rng } from '../core/mathx';
import type { Kit } from './rig';

const SKINS = [0xf1c6a0, 0xe0ac84, 0xc68e64, 0xa36f4a, 0x7d5034, 0x5a3825, 0xebbd96];
const HAIRS = [0x16100a, 0x2e1c10, 0x4a2f1a, 0x7a5a32, 0xb08a4a, 0x0e0e0e, 0x5c2a14];
const EYES = [0x3b2414, 0x4a2e18, 0x2c1a0e, 0x5a4326, 0x40584a, 0x3f5c7a, 0x2a1c12];
/** jersey numbers by roster slot */
const NUMBERS = [7, 4, 11, 9, 2, 14, 1, 17, 5, 10, 3, 8, 12, 6, 15, 13, 18, 16];

export const TEAM_COLORS = {
  home: { jersey: 0xd8342c, trim: 0xffffff, shorts: 0x1a1c24, libero: 0xf2c230, liberoTrim: 0x1a1c24 },
  away: { jersey: 0x1f5fbf, trim: 0xf2f2f2, shorts: 0xf0f0f0, libero: 0x2fbf71, liberoTrim: 0x0e2d1c },
};

export function makeKit(team: 0 | 1, libero: boolean, seed: number): Kit {
  const rng = new Rng(seed * 7919 + team * 104729);
  const c = team === 0 ? TEAM_COLORS.home : TEAM_COLORS.away;
  return {
    jersey: libero ? c.libero : c.jersey,
    jerseyTrim: libero ? c.liberoTrim : c.trim,
    shorts: c.shorts,
    skin: rng.pick(SKINS),
    hair: rng.pick(HAIRS),
    shoes: team === 0 ? 0xf4f4f4 : 0x22252e,
    socks: team === 0 ? 0xf2f2f2 : 0x1d2230,
    pads: 0x202228,
    sole: team === 0 ? 0xc9a36b : 0x2a2d36,
    shoeAccent: libero ? c.libero : c.jersey,
    eyes: rng.pick(EYES),
    hairStyle: rng.pick([0, 1, 2, 0, 3, 4, 0] as const),
    brow: rng.range(0.85, 1.25),
    build: rng.range(0.96, 1.05),
    number: NUMBERS[Math.abs(seed) % NUMBERS.length],
    tape: rng.pick([0, 0, 1, 2, 0] as const),
  };
}
