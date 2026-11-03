import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CAMERA, CONTACT, COURT, PLAYER, POSITIONS, SIM, TIMING, type PositionId } from '../src/config';
import { CameraRig } from '../src/camera/cameraRig';
import { Athlete } from '../src/game/athlete';
import { aimPitchRange, aimTargetFromLook, AIM_DEPTH, ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import { Judge } from '../src/game/judge';
import { copyBall, makeBall, R, stepBall, type BallState, type CollisionEvent } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { flyFor, solveApex, solveFixedTime } from '../src/physics/solve';
import { planQuick } from '../src/ai/approach';
import { laneFor, QUICK, quickSetFor, quickSpot, SET_PLAYS, SETTER_TARGET } from '../src/game/plays';
import { HitterBrain } from '../src/ai/hitter';
import { AudioEngine } from '../src/audio/audio';

const DT = 1 / SIM.hz;

/** run an athlete's full approach jump and return peak height and hang time */
function jump(role: PositionId, approach: boolean, load: number) {
  const a = new Athlete(role, 1);
  a.place(0, 8.8, 0);
  let t = 0;
  if (approach) {
    a.cmd = { moveX: 0, moveZ: -1, sprint: true, faceYaw: 0 };
    for (let i = 0; i < SIM.hz * 0.9; i++) a.step(DT, (t += DT));
  }
  a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: 0 };
  a.jumpPress();
  let peak = 0;
  let airT = 0;
  let released = false;
  for (let i = 0; i < SIM.hz * 3; i++) {
    if (!released && a.loadT >= load) {
      a.jumpRelease();
      released = true;
    }
    a.step(DT, (t += DT));
    if (a.state === 'air') airT += DT;
    peak = Math.max(peak, a.pos.y);
    if (a.state === 'land') break;
  }
  return { peak, airT };
}

describe('athlete jumps', () => {
  for (const role of Object.keys(POSITIONS) as PositionId[]) {
    it(`${role}: approach jump 0.65-0.92 m, believable hang time`, () => {
      const full = jump(role, true, PLAYER.loadMax);
      expect(full.peak).toBeGreaterThan(0.64);
      expect(full.peak).toBeLessThan(0.93);
      expect(Math.abs(full.peak - POSITIONS[role].jump)).toBeLessThan(0.03);
      expect(full.airT).toBeGreaterThan(0.7);
      expect(full.airT).toBeLessThan(0.95);
      const tap = jump(role, false, 0);
      expect(tap.peak).toBeLessThan(full.peak * 0.8);
      expect(tap.peak).toBeGreaterThan(0.4);
    });
  }

  it('standing reach is about 2.45 m for a 1.95 m athlete', () => {
    const a = new Athlete('OH', 1);
    expect(a.standReach).toBeGreaterThan(2.4);
    expect(a.standReach).toBeLessThan(2.55);
  });

  it('predictAir matches the real airborne integration', () => {
    const a = new Athlete('OPP', 1);
    a.place(0, 4, 0);
    a.jumpPress();
    let t = 0;
    for (let i = 0; i < 20; i++) a.step(DT, (t += DT));
    a.jumpRelease();
    while (a.state !== 'air') a.step(DT, (t += DT));
    const predicted = a.predictAir(0.3, new THREE.Vector3());
    for (let i = 0; i < Math.round(0.3 / DT); i++) a.step(DT, (t += DT));
    expect(Math.abs(predicted.y - a.pos.y)).toBeLessThan(0.02);
    expect(Math.abs(predicted.z - a.pos.z)).toBeLessThan(0.02);
  });
});

describe('movement feel', () => {
  it('accelerates and decelerates instead of snapping', () => {
    const a = new Athlete('OH', 1);
    a.place(0, 6, 0);
    a.cmd = { moveX: 0, moveZ: -1, sprint: true, faceYaw: 0 };
    a.step(DT, DT);
    expect(a.speed).toBeLessThan(POSITIONS.OH.accel * DT * 1.01);
    let t = DT;
    let reach = 0;
    while (a.speed < POSITIONS.OH.approachSpeed * 0.98 && t < 2) {
      a.step(DT, (t += DT));
      reach = t;
    }
    expect(reach).toBeGreaterThan(0.25);
    expect(reach).toBeLessThan(0.5);
    a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: 0 };
    let stopT = 0;
    while (a.speed > 0.01 && stopT < 2) {
      a.step(DT, (t += DT));
      stopT += DT;
    }
    expect(stopT).toBeGreaterThan(0.15);
    expect(stopT).toBeLessThan(0.35);
  });

  it('cannot cross the centre line', () => {
    const a = new Athlete('MB', 1);
    a.place(0, 1, 0);
    a.cmd = { moveX: 0, moveZ: -1, sprint: true, faceYaw: 0 };
    let t = 0;
    for (let i = 0; i < SIM.hz * 2; i++) a.step(DT, (t += DT));
    expect(a.pos.z).toBeGreaterThan(0);
  });
});

describe('aim mapping', () => {
  it('always targets the opponent half when facing the net, from the net or the end line', () => {
    for (const fp of [false, true]) {
      const [lo, hi] = aimPitchRange(fp);
      for (const fromZ of [0.8, 3, 9.5]) {
        for (const pitch of [lo, (lo + hi) / 2, hi]) {
          const out = aimTargetFromLook(0, fromZ, 0.1, pitch, fp, 1, new THREE.Vector3());
          expect(out.z).toBeLessThan(0);
          expect(-out.z).toBeGreaterThanOrEqual(AIM_DEPTH[0] - 1e-6);
          expect(-out.z).toBeLessThanOrEqual(AIM_DEPTH[1] + 1e-6);
        }
      }
    }
  });

  it('looking higher hits deeper', () => {
    const a = aimTargetFromLook(0, 1, 0, -0.5, false, 1, new THREE.Vector3());
    const b = aimTargetFromLook(0, 1, 0, -0.1, false, 1, new THREE.Vector3());
    expect(-b.z).toBeGreaterThan(-a.z);
  });
});

// ------------------------------------------------------------------ fake ball for the contact system
class FakeBall {
  state: BallState = makeBall();
  predictor = new BallPredictor(DT, SIM.predictHorizon);
  version = 0;
  private pv = -1;
  lastTouch: any = null;
  active = true;
  get pos() {
    return this.state.p;
  }
  get vel() {
    return this.state.v;
  }
  speed() {
    const v = this.state.v;
    return Math.hypot(v.x, v.y, v.z);
  }
  ensurePrediction(env: { netTop: number }, t: number) {
    if (this.pv !== this.version) {
      this.predictor.compute(this.state, env, t);
      this.pv = this.version;
    }
    return this.predictor;
  }
  hit(v: any, w: any) {
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.version++;
  }
}

function makeHost(ball: FakeBall, events: ContactEvent[]) {
  const host = {
    ball: ball as any,
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out.set(1, 0.105, -6),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => 0.5,
    passTarget: () => ({ x: 1, y: 2.35, z: 0.9, apex: 4 }),
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  return host;
}

/**
 * Put a hitter in the air under a set, wind up for `hold` seconds and release
 * `offset` seconds from the ideal moment; returns the graded contact.
 */
function spikeWithOffset(offset: number, hold = 0.45) {
  const ball = new FakeBall();
  const events: ContactEvent[] = [];
  const host = makeHost(ball, events);
  const cs = new ContactSystem(host);
  const a = new Athlete('OH', 1);
  a.place(-3.4, 1.4, 0);
  // jump straight up with a full load
  a.jumpPress();
  let t = 0;
  for (let i = 0; i < Math.round(PLAYER.loadMax / DT) + 1; i++) a.step(DT, (t += DT));
  // ball: a set that peaks and falls through the hitter's ideal point at the jump apex
  const tApex = t + a.timeToApex();
  const ideal = new THREE.Vector3();
  a.idealContact(ideal, a.predictAir(tApex - t, new THREE.Vector3()));
  const p0 = { x: 1, y: 2.4, z: 0.8 };
  const v = { x: 0, y: 0, z: 0 };
  const res = solveApex(p0, { x: ideal.x, y: ideal.y, z: ideal.z }, ideal.y + 1.2, { x: 0, y: 0, z: 0 }, v);
  // launch so that it arrives exactly at the apex
  const launchT = tApex - res.T;
  // rewind: simulate from launch by stepping the ball before the jump begins
  Object.assign(ball.state.p, p0);
  Object.assign(ball.state.v, v);
  const sim = copyBall(ball.state, makeBall());
  const steps = Math.round((t - launchT) / DT);
  for (let i = 0; i < steps; i++) stepBall(sim, DT, host.env);
  copyBall(sim, ball.state);
  ball.version++;
  host.simTime = t;
  // press (wind-up) `hold` before the release, release on the timing
  const info = cs.ideal(a, t, 0.9)!;
  const releaseAt = info.t - ContactSystem.swingLead(ContactSystem.chargeFor(hold)) + offset;
  const pressAt = releaseAt - hold;
  // rewind the clock for early presses (the hitter stands in the plant until then)
  let pressed = pressAt < host.simTime;
  if (pressed) {
    cs.beginWindup(a);
    a.action!.t0 = pressAt;
  }
  let act: any = null;
  const evs: CollisionEvent[] = [];
  for (let i = 0; i < SIM.hz * 1.5; i++) {
    if (!pressed && host.simTime >= pressAt - 1e-9) {
      cs.beginWindup(a);
      pressed = true;
    }
    if (!act && host.simTime >= releaseAt - 1e-9) act = cs.releaseWindup(a);
    host.simTime += DT;
    a.step(DT, host.simTime);
    cs.step([a]);
    stepBall(ball.state, DT, host.env, evs);
    if (events.length) break;
  }
  return events[0];
}

describe('spike timing grades (real contact system)', () => {
  it('a click on the ideal moment is Perfect and fast', () => {
    const e = spikeWithOffset(0);
    expect(e.grade).toBe('Perfect');
    expect(e.speed).toBeGreaterThan(26);
    expect(e.tip).toBe(false);
  });
  it('the window is more forgiving on the late side', () => {
    // 50 ms early is Good, 50 ms late is still Perfect
    expect(spikeWithOffset(-0.05).grade).toBe('Good');
    expect(spikeWithOffset(0.05).grade).toBe('Perfect');
    expect(spikeWithOffset(0.09).grade).toBe('Good');
  });
  it('releasing as the ball reaches the hand is still a Good contact', () => {
    // offset = the whole swing time: the release happens at the ideal contact moment
    const e = spikeWithOffset(ContactSystem.swingLead(1));
    expect(e.grade).toBe('Good');
  });
  it('100 ms early / 130 ms late are Early / Late and slower', () => {
    const early = spikeWithOffset(-0.1);
    const late = spikeWithOffset(0.13);
    expect(early.grade).toBe('Early');
    expect(late.grade).toBe('Late');
    expect(early.speed).toBeLessThan(spikeWithOffset(0).speed);
    expect(late.speed).toBeLessThan(spikeWithOffset(0).speed);
  });
  it('a wild click whiffs', () => {
    expect(spikeWithOffset(-0.4).grade).toBe('Miss');
  });
  it('a quick tap is a tip', () => {
    const e = spikeWithOffset(0, 0.03);
    expect(e.tip).toBe(true);
    expect(e.speed).toBeLessThan(12);
  });
});

describe('hold-to-charge spike power', () => {
  it('the longer the wind-up, the harder the spike, up to full charge', () => {
    const short = spikeWithOffset(0, TIMING.tapThreshold + 0.02);
    const mid = spikeWithOffset(0, (TIMING.tapThreshold + TIMING.chargeFull) / 2);
    const full = spikeWithOffset(0, TIMING.chargeFull + 0.01);
    const long = spikeWithOffset(0, 0.9);
    for (const e of [short, mid, full, long]) {
      expect(e.tip).toBe(false);
      expect(e.grade).toBe('Perfect');
    }
    expect(mid.speed).toBeGreaterThan(short.speed + 1);
    expect(full.speed).toBeGreaterThan(mid.speed + 0.5);
    // full charge is the cap: holding longer adds nothing
    expect(Math.abs(long.speed - full.speed)).toBeLessThan(0.3);
    expect(short.power!).toBeLessThan(0.15);
    expect(full.power).toBeCloseTo(1, 5);
  });

  it('a barely held swing keeps the timing grade but only ~70% of the power', () => {
    const weak = spikeWithOffset(0, TIMING.tapThreshold + 0.005);
    const full = spikeWithOffset(0, 0.5);
    expect(weak.speed / full.speed).toBeGreaterThan(CONTACT.chargePowerMin - 0.03);
    expect(weak.speed / full.speed).toBeLessThan(CONTACT.chargePowerMin + 0.08);
    // the full Perfect effects package needs a real wind-up
    expect(weak.perfect).toBe(false);
    expect(full.perfect).toBe(true);
  });

  it('timing is graded on the release, whatever the hold', () => {
    expect(spikeWithOffset(0.09, 0.2).grade).toBe('Good');
    expect(spikeWithOffset(-0.1, 0.5).grade).toBe('Early');
  });

  it('a fully drawn arm comes through faster: its ideal release is later', () => {
    expect(ContactSystem.swingLead(1)).toBeLessThan(ContactSystem.swingLead(0));
  });
});

describe('line judge', () => {
  function judgeFloor(x: number, z: number, side: 1 | -1) {
    const j = new Judge();
    const ball = { pos: { x, y: 1, z }, active: true, lastTouch: { side } } as any;
    j.arm(ball);
    return j.step(ball, [{ kind: 'floor', x, y: 0.105, z, impact: 10 }], COURT.netHeightMen)!;
  }
  it('ball on the line is in', () => {
    const o = judgeFloor(4.5, -6, 1);
    expect(o.kind).toBe('in');
    expect(o.winner).toBe(1);
  });
  it('ball out gives the point to the other side', () => {
    const o = judgeFloor(4.7, -6, 1);
    expect(o.kind).toBe('out');
    expect(o.winner).toBe(-1);
  });
  it('crossing outside the antennae is a fault', () => {
    const j = new Judge();
    const ball = { pos: { x: 5.2, y: 3, z: 0.3 }, active: true, lastTouch: { side: 1 } } as any;
    j.arm(ball);
    ball.pos = { x: 5.25, y: 3, z: -0.3 };
    const o = j.step(ball, [], COURT.netHeightMen)!;
    expect(o.kind).toBe('outside-antenna');
    expect(o.winner).toBe(-1);
  });
});

describe('set plays', () => {
  it('outside and opposite sets go to the pins, inside the antennae', () => {
    for (const pos of ['OH', 'OPP'] as const) {
      const l = laneFor(pos, 1);
      expect(Math.abs(l.x)).toBeGreaterThan(3.9);
      // ball edge stays well inside the antenna
      expect(Math.abs(l.x) + R).toBeLessThan(COURT.antennaX - 0.3);
      // the approach starts wider than the contact (out by the sideline)
      expect(Math.abs(l.sx)).toBeGreaterThan(Math.abs(l.x));
    }
  });

  it('a middle planning a quick leaves the floor as the setter touches the ball', () => {
    const a = new Athlete('MB', 1);
    const lane = laneFor('MB', 1);
    a.place(lane.sx, lane.sz, 0);
    const tTouch = 1.4;
    const spot = quickSpot(1.0, 1);
    const plan = planQuick(a, 0, spot, tTouch, 0, 0)!;
    expect(plan).not.toBeNull();
    expect(plan.error).toBeLessThan(0.25);
    // run the plan with the real kinematics
    let t = 0;
    let takeoff = -1;
    a.onTakeoff = () => (takeoff = t);
    let pressed = false;
    let released = false;
    while (t < plan.tc) {
      const run = t >= plan.tStart && !pressed;
      a.cmd = { moveX: run ? plan.dir.x : 0, moveZ: run ? plan.dir.z : 0, sprint: run, faceYaw: 0 };
      if (!pressed && t >= plan.tPress - 1e-9) pressed = a.jumpPress();
      if (pressed && !released && t >= plan.tPress + plan.hold - 1e-9) {
        a.jumpRelease();
        released = true;
      }
      t += DT;
      a.step(DT, t);
    }
    expect(Math.abs(takeoff - tTouch)).toBeLessThan(0.03);
  });

  it('a quick to a hitter already in the air arrives at their hand at the top of the jump', () => {
    const a = new Athlete('MB', 1);
    a.place(0.2, 1.0, 0);
    a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: 0 };
    let t = 0;
    a.jumpPress();
    for (let i = 0; i < SIM.hz * PLAYER.loadMax; i++) a.step(DT, (t += DT));
    a.jumpRelease();
    while (a.state !== 'air') a.step(DT, (t += DT));
    // the setter touches it now, from just behind
    const from = { x: 1.05, y: 2.5, z: 0.85 };
    const q = quickSetFor(a, t, from);
    expect(q.onTime).toBe(true);
    expect(q.time).toBeGreaterThan(0.25);
    expect(q.time).toBeLessThan(0.55);
    // the ball, solved for that flight time, is at the target then
    const v = { x: 0, y: 0, z: 0 };
    solveFixedTime(from, q.target, q.time, { x: 0, y: 0, z: 0 }, v);
    const end = { x: 0, y: 0, z: 0 };
    flyFor(from, v, { x: 0, y: 0, z: 0 }, q.time, end);
    expect(Math.hypot(end.x - q.target.x, end.y - q.target.y, end.z - q.target.z)).toBeLessThan(0.02);
    // and the hitter's ideal contact point is there at the same moment
    const t1 = t + q.time;
    while (t < t1 - 1e-9) a.step(DT, (t += DT));
    const p = a.idealContact(new THREE.Vector3());
    expect(Math.hypot(p.x - q.target.x, p.y - q.target.y, p.z - q.target.z)).toBeLessThan(0.04);
    expect(a.vel.y).toBeLessThan(0.3);
  });

  it('a middle still on the floor gets the late default quick', () => {
    const a = new Athlete('MB', 1);
    a.place(0.3, 2.5, 0);
    const q = quickSetFor(a, 0, { x: 1.0, y: 2.5, z: 0.9 });
    expect(q.onTime).toBe(false);
    expect(q.time).toBeCloseTo(QUICK.lateT);
  });
});

describe('spike drill set calls', () => {
  it('every outside / opposite call is met inside the antennae', () => {
    for (const pos of ['OH', 'OPP'] as const) {
      const plays = SET_PLAYS[pos]!;
      expect(plays.length).toBe(3);
      for (const p of plays) {
        expect(Math.abs(p.lane.x) + R).toBeLessThan(COURT.antennaX - 0.3);
        expect(p.lane.z).toBeGreaterThan(0.5);
        expect(p.inFront).toBeUndefined();
      }
    }
    // fast sets are flatter than the high ball
    expect(SET_PLAYS.OH![1].lane.apexAbove).toBeLessThan(SET_PLAYS.OH![0].lane.apexAbove);
    expect(SET_PLAYS.OPP![1].lane.apexAbove).toBeLessThan(SET_PLAYS.OPP![0].lane.apexAbove);
  });

  it('middle calls: 1 in front of the setter, shoot further out, back quick behind', () => {
    const [one, shoot, back] = SET_PLAYS.MB!;
    const sx = SETTER_TARGET.x;
    // home setter faces -x (towards the outside): in front = smaller x
    expect(quickSpot(sx, 1, one.inFront).x).toBeLessThan(sx);
    expect(sx - quickSpot(sx, 1, shoot.inFront).x).toBeGreaterThan(2);
    expect(quickSpot(sx, 1, back.inFront).x).toBeGreaterThan(sx + 0.9);
    // mirrored for the far side
    expect(quickSpot(-sx, -1, back.inFront).x).toBeLessThan(-sx - 0.9);
  });

  it('a back quick set over the setter\'s head still meets the hitter at the top of the jump', () => {
    const a = new Athlete('MB', 1);
    a.place(2.1, 1.0, 0);
    a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: 0 };
    let t = 0;
    a.jumpPress();
    for (let i = 0; i < SIM.hz * PLAYER.loadMax; i++) a.step(DT, (t += DT));
    a.jumpRelease();
    while (a.state !== 'air') a.step(DT, (t += DT));
    const from = { x: 1.05, y: 2.5, z: 0.85 };
    const q = quickSetFor(a, t, from, undefined, SET_PLAYS.MB![2].inFront);
    expect(q.onTime).toBe(true);
    expect(q.target.x).toBeGreaterThan(from.x + 0.8);
    const t1 = t + q.time;
    while (t < t1 - 1e-9) a.step(DT, (t += DT));
    const p = a.idealContact(new THREE.Vector3());
    expect(Math.hypot(p.x - q.target.x, p.y - q.target.y, p.z - q.target.z)).toBeLessThan(0.04);
  });
});

describe('middle shot choice', () => {
  it('a middle only hits the deep corners, zone 1 or zone 5', () => {
    for (const side of [1, -1] as const) {
      const a = new Athlete('MB', side);
      const brain = new HitterBrain(a, laneFor('MB', side));
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const r = (i + 0.5) / 40;
        const g = { rng: { next: () => r, gauss: () => 0 } } as any;
        const aim = brain.chooseAim(g, 0.2 * side);
        seen.add(brain.lastShot);
        expect(Math.abs(aim.x)).toBeGreaterThan(2.8);
        expect(aim.z * side).toBeLessThan(-6.5);
      }
      expect([...seen].sort()).toEqual(['zone 1', 'zone 5']);
      // zone 1 is the receiving team's right back: x < 0 when the home team attacks
      const g1 = { rng: { next: () => 0.1, gauss: () => 0 } } as any;
      const z1 = brain.chooseAim(g1, 0);
      expect(brain.lastShot).toBe('zone 1');
      expect(Math.sign(z1.x)).toBe(-side);
    }
  });
});

describe('hit sound power', () => {
  it('grows with the ball speed: a float serve is soft, a full spike is the full boom', () => {
    expect(AudioEngine.powerFromSpeed(17)).toBeLessThan(0.35);
    expect(AudioEngine.powerFromSpeed(22)).toBeGreaterThan(AudioEngine.powerFromSpeed(17));
    expect(AudioEngine.powerFromSpeed(30)).toBe(1);
    expect(AudioEngine.powerFromSpeed(5)).toBe(0);
  });
});

describe('first-person camera at the net', () => {
  it('the lens stays far enough back that the net is never clipped by the near plane', () => {
    for (const side of [1, -1] as const) {
      const rig = new CameraRig(16 / 9);
      rig.mode = 'fp';
      rig.yaw = side === 1 ? 0 : Math.PI;
      rig.pitch = 0.1;
      // feet on the closest allowed spot to the centre line, eye at head height
      const z = side * 0.22;
      const t = { root: new THREE.Vector3(0, 0, z), eye: new THREE.Vector3(0, 1.82, z), sprint: 0, height: 1.95, side };
      rig.update(1 / 60, t);
      const cz = rig.camera.position.z * side;
      expect(cz).toBeGreaterThanOrEqual(CAMERA.fpNear + 0.05);
      // and it never crosses to the other side
      expect(Math.sign(rig.camera.position.z)).toBe(side);
    }
  });
});
