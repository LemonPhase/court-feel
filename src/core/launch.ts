import { isLevelId, isPositionId, type Hand, type LevelId, type PositionId } from '../config';
import { isBotQuality, type BotQuality } from '../game/bot';
import { isModeId, type ModeId } from '../game/modes/mode';

/** a quick-start link: ?mode=spike&pos=OH&cam=fp&bot=perfect&hand=left, or ?mode=rally&pos=OH&level=club */
export interface LaunchParams {
  mode: ModeId;
  pos: PositionId;
  /** camera override, or null to keep the saved setting */
  cam: 'fp' | 'tp' | null;
  /** autopilot for automated runs, or null */
  bot: BotQuality | null;
  /** hitting hand override, or null to keep the saved setting */
  hand: Hand | null;
  /** level of play override (the Mini Rally), or null to keep the saved setting */
  level: LevelId | null;
}

/**
 * Quick-start links are shared by hand, so every value is checked: an unknown mode means no
 * quick start (the start menu opens as usual), an unknown position falls back to Outside
 * Hitter, and an unknown camera, bot, hand or level is ignored.
 */
export function parseLaunchParams(search: string): LaunchParams | null {
  const q = new URLSearchParams(search);
  const mode = q.get('mode');
  if (!isModeId(mode)) return null;
  const pos = q.get('pos');
  const cam = q.get('cam');
  const bot = q.get('bot');
  const hand = q.get('hand');
  const level = q.get('level');
  return {
    mode,
    pos: isPositionId(pos) ? pos : 'OH',
    cam: cam === 'fp' || cam === 'tp' ? cam : null,
    bot: isBotQuality(bot) ? bot : null,
    hand: hand === 'left' || hand === 'right' ? hand : null,
    level: isLevelId(level) ? level : null,
  };
}
