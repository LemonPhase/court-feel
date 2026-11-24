import { COURT, type AiTuning } from '../config';
import type { Athlete } from '../game/athlete';
import type { Touch } from '../game/ballEntity';
import type { AiHost } from '../game/brains';
import { attackKind } from './defence';

/**
 * A team's scouting report on the other side's hitters (AI.wing.scout): how often each one hits
 * cross rather than line off a pin attack. On a real court the whole team scouts, not the one
 * blocker in front: so it watches every pin spike of theirs whoever is at the net, the user
 * blocking there too. Both our wings, our middle and our perimeter defence read it.
 */
export class Scout {
  /** each of their hitters: 0 always line, 1 always cross */
  readonly cross = new Map<Athlete, number>();
  /** the last spike of theirs it noted: each one counts once */
  private shotRef: Touch | null = null;
  /** each of their passers in serve receive: passes seen, and how far off their setter's spot they went in all (m) */
  readonly passes = new Map<Athlete, { n: number; off: number }>();
  private passRef: Touch | null = null;

  /** `ai`: the scouting team's level (how fast it learns, `AI.wing.scout`) */
  constructor(private readonly ai: AiTuning) {}

  /**
   * Note their serve-receive pass `t`: how far off their setter's spot it came down (m; one nobody
   * could set counts as `AI.serve.worstPass`). Anyone watching sees it; each pass counts once.
   */
  notePass(t: Touch, off: number): void {
    if (t === this.passRef || !t.athlete) return;
    this.passRef = t;
    const p = this.passes.get(t.athlete) ?? { n: 0, off: 0 };
    p.n++;
    p.off += Math.min(this.ai.serve.worstPass, off);
    this.passes.set(t.athlete, p);
  }

  /** of `passers`, the one whose passes have come down furthest off on average; null until two passes are seen */
  weakest<T extends Athlete>(passers: readonly T[]): T | null {
    let seen = 0;
    for (const a of passers) seen += this.passes.get(a)?.n ?? 0;
    if (seen < 2) return null;
    let worst: T | null = null;
    let worstOff = -1;
    for (const a of passers) {
      const p = this.passes.get(a);
      if (!p) continue;
      const mean = p.off / p.n;
      if (mean > worstOff) {
        worstOff = mean;
        worst = a;
      }
    }
    return worst;
  }

  /** our read of their hitter `h`; one we have not seen yet (or nobody), `scoutStart` */
  crossOf(h: Athlete | null): number {
    return (h && this.cross.get(h)) ?? this.ai.wing.scoutStart;
  }

  /**
   * Watch their spike, for team `side` (once a step will do: each spike counts once). A pin attack
   * (a tip is not a shot to read) moves our read of its hitter `scout` of the way to line (0), when
   * it would land in our line digger's lane (`AI.defence.lineLane`, out wide too), or to cross (1),
   * anywhere inside that. One that does not come down on our side (into the net) shows nothing.
   */
  watch(g: AiHost, side: 1 | -1): void {
    const lt = g.ball.lastTouch;
    if (!lt || lt === this.shotRef || lt.kind !== 'spike' || lt.side === side) return;
    this.shotRef = lt;
    const h = lt.athlete;
    const { pos } = g.ball;
    if (!h || attackKind(this.ai, pos.x, Math.abs(pos.z)) !== 'pin') return;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    if (pred.landT < 0 || Math.sign(pred.land.z) !== side) return;
    const line = Math.sign(pos.x) * pred.land.x > COURT.halfWidth - this.ai.defence.lineLane;
    const seen = this.crossOf(h);
    this.cross.set(h, seen + this.ai.wing.scout * ((line ? 0 : 1) - seen));
  }
}
