import type { TouchKind } from '../game/ballEntity';

/**
 * What a team is in the middle of, read from the ball: a team is always in exactly one situation,
 * and what its players without the ball do is decided by it (`AI.sit`, AI movement notes section 11).
 *
 * - `dead`: no live ball (before a serve)
 * - `theirServe`: their serve is flying to us
 * - `ourFirstBall`: our pass or dig is up, on its way to whoever sets it
 * - `ourSet`: our set is flying to a hitter
 * - `ourAttack`: our attack (or a ball off our block) is on its way over, or on their side
 * - `ourServe`: our serve is flying to them
 * - `theirFirstBall`: their pass or dig is up, on their side
 * - `theirSet`: their set is flying to a hitter
 * - `theirHit`: their attack is coming at us
 * - `theirFree`: their ball is a free ball: coming over without an attack, or about to
 * - `scramble`: a ball of ours that is no pass to the setter: off a block, or one the setter calls HELP on
 */
export type Situation =
  | 'dead'
  | 'theirServe'
  | 'ourFirstBall'
  | 'ourSet'
  | 'ourAttack'
  | 'ourServe'
  | 'theirFirstBall'
  | 'theirSet'
  | 'theirHit'
  | 'theirFree'
  | 'scramble';

export const SITUATIONS: readonly Situation[] = [
  'dead',
  'theirServe',
  'ourFirstBall',
  'ourSet',
  'ourAttack',
  'ourServe',
  'theirFirstBall',
  'theirSet',
  'theirHit',
  'theirFree',
  'scramble',
];

export interface SituationInput {
  /** a ball is in play */
  live: boolean;
  /** the last touch, and whether it was ours */
  kind: TouchKind | null;
  ours: boolean;
  /** the ball will come down on our side */
  comingToUs: boolean;
  /** we have called their next ball a free ball (their second ball was no set) */
  freeCall: boolean;
  /** the setter has called HELP on our first ball (or nobody can set it) */
  help: boolean;
}

export function situationOf(i: SituationInput): Situation {
  if (!i.live || !i.kind || i.kind === 'feed') return 'dead';
  if (i.kind === 'serve') return i.ours ? 'ourServe' : 'theirServe';
  // a ball off a block (either side's) coming down on our side is ours to keep alive
  if (i.kind === 'block') return i.comingToUs ? 'scramble' : 'ourAttack';
  if (i.ours) {
    if (i.kind === 'spike' || i.kind === 'tip') return 'ourAttack';
    if (i.kind === 'set') return 'ourSet';
    // a first ball going over the net is theirs to play now
    if (!i.comingToUs) return 'ourAttack';
    return i.help ? 'scramble' : 'ourFirstBall';
  }
  if (i.kind === 'spike' || i.kind === 'tip') return 'theirHit';
  if (i.kind === 'set') return i.comingToUs ? 'theirFree' : 'theirSet';
  return i.comingToUs || i.freeCall ? 'theirFree' : 'theirFirstBall';
}
