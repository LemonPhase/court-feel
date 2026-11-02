import { copyBall, makeBall, stepBall, type BallEnv, type BallState, type CollisionEvent, type V3 } from './ball';

/**
 * Deterministic look-ahead of the ball, using exactly the same step function
 * as the live simulation (so the landing marker, AI and timing windows agree
 * with what will actually happen, until someone touches the ball).
 */
export class BallPredictor {
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  count = 0;
  t0 = 0;
  /** time and position of first floor contact (or -1) */
  landT = -1;
  readonly land: V3 = { x: 0, y: 0, z: 0 };
  /** first time the ball crosses z = 0 (or -1), and where */
  netCrossT = -1;
  readonly netCross: V3 = { x: 0, y: 0, z: 0 };
  /** collision events with times */
  readonly events: (CollisionEvent & { t: number })[] = [];
  private sim: BallState = makeBall();
  private evBuf: CollisionEvent[] = [];
  /** version of the ball state this prediction was built from */
  version = -1;

  constructor(readonly dt: number, readonly horizon: number) {
    const n = Math.ceil(horizon / dt) + 1;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
  }

  compute(state: BallState, env: BallEnv, t0: number): void {
    const s = copyBall(state, this.sim);
    const n = this.pos.length / 3;
    this.t0 = t0;
    this.landT = -1;
    this.netCrossT = -1;
    this.events.length = 0;
    let prevZ = s.p.z;
    this.write(0, s);
    let i = 1;
    for (; i < n; i++) {
      this.evBuf.length = 0;
      stepBall(s, this.dt, env, this.evBuf);
      const t = t0 + i * this.dt;
      for (const e of this.evBuf) {
        this.events.push({ ...e, t });
        if (e.kind === 'floor' && this.landT < 0) {
          this.landT = t;
          this.land.x = e.x;
          this.land.y = e.y;
          this.land.z = e.z;
        }
      }
      if (this.netCrossT < 0 && prevZ !== 0 && Math.sign(s.p.z) !== Math.sign(prevZ)) {
        // linear interpolate crossing
        const pz = this.pos[(i - 1) * 3 + 2];
        const f = pz / (pz - s.p.z);
        this.netCrossT = t - this.dt + f * this.dt;
        this.netCross.x = this.pos[(i - 1) * 3] + (s.p.x - this.pos[(i - 1) * 3]) * f;
        this.netCross.y = this.pos[(i - 1) * 3 + 1] + (s.p.y - this.pos[(i - 1) * 3 + 1]) * f;
        this.netCross.z = 0;
      }
      prevZ = s.p.z;
      this.write(i, s);
      if (s.rest) {
        i++;
        break;
      }
    }
    this.count = i;
  }

  private write(i: number, s: BallState): void {
    this.pos[i * 3] = s.p.x;
    this.pos[i * 3 + 1] = s.p.y;
    this.pos[i * 3 + 2] = s.p.z;
    this.vel[i * 3] = s.v.x;
    this.vel[i * 3 + 1] = s.v.y;
    this.vel[i * 3 + 2] = s.v.z;
  }

  get endT(): number {
    return this.t0 + (this.count - 1) * this.dt;
  }

  /** interpolated position at absolute time t (clamped to the horizon) */
  posAt(t: number, out: V3): V3 {
    const f = (t - this.t0) / this.dt;
    let i = Math.floor(f);
    if (i < 0) i = 0;
    if (i >= this.count - 1) {
      const k = (this.count - 1) * 3;
      out.x = this.pos[k];
      out.y = this.pos[k + 1];
      out.z = this.pos[k + 2];
      return out;
    }
    const a = f - i;
    const k = i * 3;
    out.x = this.pos[k] + (this.pos[k + 3] - this.pos[k]) * a;
    out.y = this.pos[k + 1] + (this.pos[k + 4] - this.pos[k + 1]) * a;
    out.z = this.pos[k + 2] + (this.pos[k + 5] - this.pos[k + 2]) * a;
    return out;
  }

  velAt(t: number, out: V3): V3 {
    let i = Math.round((t - this.t0) / this.dt);
    i = Math.max(0, Math.min(this.count - 1, i));
    out.x = this.vel[i * 3];
    out.y = this.vel[i * 3 + 1];
    out.z = this.vel[i * 3 + 2];
    return out;
  }

  /** first time (>= fromT) the ball is descending through height y; -1 if never */
  descendThrough(y: number, fromT = this.t0): number {
    const start = Math.max(1, Math.ceil((fromT - this.t0) / this.dt));
    for (let i = start; i < this.count; i++) {
      const y0 = this.pos[(i - 1) * 3 + 1];
      const y1 = this.pos[i * 3 + 1];
      if (y0 >= y && y1 < y && this.vel[i * 3 + 1] < 0) {
        const f = (y0 - y) / (y0 - y1);
        return this.t0 + (i - 1 + f) * this.dt;
      }
      if (this.landT > 0 && this.t0 + i * this.dt > this.landT) break;
    }
    return -1;
  }

  /** apex time and height before the first floor contact */
  apex(): { t: number; y: number } {
    let best = -1e9;
    let bt = this.t0;
    for (let i = 0; i < this.count; i++) {
      const t = this.t0 + i * this.dt;
      if (this.landT > 0 && t > this.landT) break;
      const y = this.pos[i * 3 + 1];
      if (y > best) {
        best = y;
        bt = t;
      }
    }
    return { t: bt, y: best };
  }

  /** earliest time the ball comes within `radius` of a point, -1 if never (before landing) */
  firstWithin(px: number, py: number, pz: number, radius: number, fromT = this.t0): number {
    const r2 = radius * radius;
    const start = Math.max(0, Math.ceil((fromT - this.t0) / this.dt));
    for (let i = start; i < this.count; i++) {
      const t = this.t0 + i * this.dt;
      if (this.landT > 0 && t > this.landT) break;
      const dx = this.pos[i * 3] - px;
      const dy = this.pos[i * 3 + 1] - py;
      const dz = this.pos[i * 3 + 2] - pz;
      if (dx * dx + dy * dy + dz * dz <= r2) return t;
    }
    return -1;
  }
}
