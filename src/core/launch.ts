import { isPositionId, type Hand, type PositionId } from '../config';
import { isBotQuality, type BotQuality } from '../game/bot';
import { isModeId, type ModeId } from '../game/modes/mode';
import { isRankedMode, RANKED_MODES, type RankedPlay } from '../game/boards';

/**
 * A quick-start link: ?mode=spike&pos=OH&cam=fp&bot=perfect&hand=left, ?ranked=spike&pos=OH for a
 * ranked run on a season board, or ?ranked=weekly for this week's featured board.
 */
export interface LaunchParams {
  mode: ModeId;
  pos: PositionId;
  /** a ranked run (season or weekly board) instead of practice */
  ranked: RankedPlay | null;
  /** camera override, or null to keep the saved setting */
  cam: 'fp' | 'tp' | null;
  /** autopilot for automated runs, or null */
  bot: BotQuality | null;
  /** hitting hand override, or null to keep the saved setting */
  hand: Hand | null;
}

/**
 * Quick-start links are shared by hand, so every value is checked: an unknown mode means no
 * quick start (the start menu opens as usual), an unknown position falls back to Outside
 * Hitter, and an unknown camera, bot or hand is ignored. `ranked` names a drill with ranked runs (or
 * `weekly`) and takes the place of `mode`; any other value is ignored.
 */
export function parseLaunchParams(search: string): LaunchParams | null {
  const q = new URLSearchParams(search);
  const r = q.get('ranked');
  const ranked: RankedPlay | null = r === 'weekly' ? 'weekly' : isRankedMode(r) ? 'season' : null;
  const mode = r === 'weekly' ? RANKED_MODES[0] : isRankedMode(r) ? r : q.get('mode');
  if (!isModeId(mode)) return null;
  const pos = q.get('pos');
  const cam = q.get('cam');
  const bot = q.get('bot');
  const hand = q.get('hand');
  return {
    mode,
    pos: isPositionId(pos) ? pos : 'OH',
    ranked,
    cam: cam === 'fp' || cam === 'tp' ? cam : null,
    bot: isBotQuality(bot) ? bot : null,
    hand: hand === 'left' || hand === 'right' ? hand : null,
  };
}
