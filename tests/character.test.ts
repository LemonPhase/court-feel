import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BALL, CHARACTER, COURT, PLAYER, SIM } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { AthleteView } from '../src/character/athleteView';
import { FINGER_JOINT, FINGERS } from '../src/character/hand';
import { makeKit } from '../src/character/kits';
import { buildRig } from '../src/character/rig';

const DT = 1 / SIM.hz;

/** an athlete in the air at `z` metres from the net (home side), with the view posed every step */
function airborne(z: number): { a: Athlete; v: AthleteView; t: number; step: () => void } {
  const a = new Athlete('OH', 1);
  a.place(0, z, 0);
  const v = new AthleteView(a, makeKit(0, false, 1));
  const s = { a, v, t: 0, step: () => {} };
  s.step = () => {
    s.t += DT;
    a.step(DT, s.t);
    a.interpolate(1);
    v.update(DT, s.t);
  };
  a.jumpPress();
  while (a.state !== 'air' && s.t < 2) s.step();
  return s;
}

/** start a full swing that meets the ball at the hitter's ideal contact point `lead` seconds from now */
function swing(s: ReturnType<typeof airborne>, lead: number) {
  const act = s.a.startAction('swing', s.t);
  act.contactT = s.t + lead;
  act.charge = 1;
  act.aim.set(0, -0.35, -1).normalize();
  while (s.t < act.contactT - 1e-9) {
    s.a.idealContact(act.contactPoint);
    s.a.ballPos = act.contactPoint;
    s.a.lookAt.copy(act.contactPoint);
    s.step();
  }
  act.resolved = true;
  return act;
}

const world = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

describe('the athlete model', () => {
  it('is one surface that faces outwards (a body is seen from outside, not through its far side)', () => {
    const g = buildRig(1.9, makeKit(0, false, 1)).mesh.geometry;
    const p = g.attributes.position.array;
    const ix = g.index!.array;
    let vol = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const [a, b, c] = [ix[i] * 3, ix[i + 1] * 3, ix[i + 2] * 3];
      vol +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    // a 1.9 m athlete displaces something like 60 to 110 litres (parts overlap, so this is loose)
    expect(vol / 6).toBeGreaterThan(0.04);
    expect(vol / 6).toBeLessThan(0.14);
  });
});

describe('the spike, as the body shows it', () => {
  it('the palm is on the ball at contact, not inside it and not short of it', () => {
    const s = airborne(1.2);
    const act = swing(s, 0.12);
    const d = s.v.rig.dims;
    const B = s.v.rig.bones;
    // the palm's centre: up the hand from the wrist
    const wrist = world(B.handR);
    const knuckles = world(B.fingersR);
    const palm = wrist.clone().addScaledVector(knuckles.clone().sub(wrist).normalize(), d.palm);
    const gap = palm.distanceTo(act.contactPoint) - BALL.radius;
    // the palm's surface is half a hand's thickness from its centre plane
    expect(gap).toBeGreaterThan(d.palmThick - 0.02);
    expect(gap).toBeLessThan(d.palmThick + 0.02);
  });

  it('the fingers are spread over the ball at contact, each one lying on it from knuckle to tip', () => {
    const s = airborne(1.2);
    const act = swing(s, 0.12);
    const B = s.v.rig.bones;
    const H = s.a.height;
    const tips: THREE.Vector3[] = [];
    for (const f of FINGERS) {
      const mid = world(B[`${f.name}TipR`]);
      const tip = B[`${f.name}TipR`].localToWorld(new THREE.Vector3(0, -f.len * (1 - FINGER_JOINT) * H, 0));
      tips.push(tip);
      // the middle of the finger is one finger's radius from the ball's surface when it rests on it
      for (const p of [mid, tip]) {
        const off = p.distanceTo(act.contactPoint) - BALL.radius - f.r * H;
        expect(off).toBeGreaterThan(-0.004);
        expect(off).toBeLessThan(0.008);
      }
    }
    // spread: the index and little fingertips are further apart than their knuckles
    const knuckles = world(B.indexR).distanceTo(world(B.littleR));
    expect(tips[0].distanceTo(tips[3])).toBeGreaterThan(knuckles + 0.02);
  });

  it('the arm comes through and lets go: by the landing the trunk has opened up again', () => {
    const s = airborne(1.2);
    const act = swing(s, 0.12);
    const B = s.v.rig.bones;
    let deepest = 0;
    while (s.a.state === 'air' && s.t < act.contactT + 1) {
      s.step();
      deepest = Math.min(deepest, B.spine.rotation.x + B.chest.rotation.x);
    }
    const atLanding = B.spine.rotation.x + B.chest.rotation.x;
    // a full swing folds the body over the ball...
    expect(deepest).toBeLessThan(-0.45);
    // ...and it is not still folded when the feet come down
    expect(atLanding).toBeGreaterThan(deepest + 0.2);
    // the hitting hand has come down past the shoulder
    expect(world(B.handR).y).toBeLessThan(world(B.upperArmR).y);
  });

  it('a hitter tight to the net keeps hand and fingers on their own side below the tape', () => {
    const s = airborne(0.3);
    const act = swing(s, 0.12);
    const B = s.v.rig.bones;
    const d = s.v.rig.dims;
    let checked = 0;
    for (let i = 0; i < SIM.hz * 0.9; i++) {
      s.step();
      const wrist = world(B.handR);
      const knuckles = world(B.fingersR);
      const tip = wrist.clone().addScaledVector(knuckles.clone().sub(wrist).normalize(), d.hand);
      for (const p of [wrist, knuckles, tip]) {
        if (p.y >= COURT.netHeightMen) continue;
        checked++;
        expect(p.z).toBeGreaterThan(0);
      }
    }
    expect(act.resolved).toBe(true);
    expect(checked).toBeGreaterThan(30);
  });

  it('the feet reach for the floor: they are nearly down when the body lands', () => {
    const s = airborne(1.2);
    swing(s, 0.12);
    let last = 0;
    while (s.a.state === 'air' && s.t < 3) {
      last = Math.min(world(s.v.rig.bones.footL).y, world(s.v.rig.bones.footR).y);
      s.step();
    }
    // ankle height standing is about 7 cm: the last airborne frame has the feet within 10 cm of that
    expect(last).toBeLessThan(s.v.rig.dims.ankleY + 0.1);
    expect(PLAYER.loadMax).toBeGreaterThan(0);
  });
});

/** an athlete standing at `z` metres from the net (home side, facing it), with the view posed every step */
function standing(z: number) {
  const a = new Athlete('OH', 1);
  a.place(0, z, 0);
  const v = new AthleteView(a, makeKit(0, false, 1));
  const s = { a, v, t: 0, step: () => {} };
  s.step = () => {
    s.t += DT;
    a.step(DT, s.t);
    a.interpolate(1);
    v.update(DT, s.t);
  };
  for (let i = 0; i < 20; i++) s.step();
  return s;
}

describe('the jump, as the body shows it', () => {
  it('a blocker loading at the net keeps knees and toes behind the centre line', () => {
    // as close as the game lets you stand
    const s = standing(0.22);
    const B = s.v.rig.bones;
    const d = s.v.rig.dims;
    s.a.jumpPress();
    let frames = 0;
    while (s.t < 1.2) {
      s.step();
      frames++;
      for (const side of ['L', 'R'] as const) {
        // the kneecap and its pad are about 8 cm in front of the middle of the knee
        expect(world(B[`shin${side}`]).z).toBeGreaterThan(0.08);
        // facing the net, the toes are a foot's length in front of the ankle
        expect(world(B[`foot${side}`]).z - (d.footLen - d.heel)).toBeGreaterThan(0);
      }
    }
    expect(frames).toBeGreaterThan(100);
  });

  it('the arms go back on the plant of an approach and are overhead as the hitter leaves the floor', () => {
    const s = standing(4);
    // a run-up at the net
    for (let i = 0; i < SIM.hz * 0.7; i++) {
      s.a.cmd.moveZ = -1;
      s.a.cmd.sprint = true;
      s.step();
    }
    expect(s.a.speed).toBeGreaterThan(3);
    s.a.jumpPress();
    const B = s.v.rig.bones;
    let behind = 0;
    while (s.a.state === 'load') {
      s.step();
      // behind the hips (the hitter faces -z, so behind is +z) and below the shoulders
      if (world(B.handL).z > world(B.hips).z + 0.1 && world(B.handR).z > world(B.hips).z + 0.1 && world(B.handR).y < world(B.upperArmR).y)
        behind++;
    }
    // both hands are back there for a good part of the plant
    expect(behind).toBeGreaterThan(SIM.hz * 0.06);
    // 0.15 s into the air both hands are above the head: the swing carried on up
    for (let i = 0; i < SIM.hz * 0.15; i++) s.step();
    expect(s.a.state).toBe('air');
    expect(world(B.handL).y).toBeGreaterThan(world(B.head).y);
    expect(world(B.handR).y).toBeGreaterThan(world(B.head).y);
  });
});

describe('the touch, as the arms show it', () => {
  it("a setter's hands are at the ball before it gets there (the ball drops into them)", () => {
    const s = standing(2);
    const zone = new THREE.Vector3(0, s.a.height + 0.17, 2 - 0.14);
    s.v.setZone = zone;
    const act = s.a.startAction('set', s.t);
    const ball = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const B = s.v.rig.bones;
    const d = s.v.rig.dims;
    // a pass dropping onto the hands at 4 m/s, followed from 0.6 s out
    const palmGap = () => {
      let worst = 0;
      for (const side of ['L', 'R'] as const) {
        const wrist = world(B[`hand${side}`]);
        const palm = wrist.clone().addScaledVector(world(B[`fingers${side}`]).sub(wrist).normalize(), d.palm);
        worst = Math.max(worst, palm.distanceTo(zone) - BALL.radius);
      }
      return worst;
    };
    let early = 1;
    for (let tau = 0.6; tau > 0; tau -= DT) {
      ball.set(zone.x, zone.y + 4 * tau + 0.5 * BALL.gravity * tau * tau, zone.z);
      vel.set(0, -(4 + BALL.gravity * tau), 0);
      s.a.ballPos = ball;
      s.a.ballVel = vel;
      s.a.lookAt.copy(ball);
      s.step();
      if (Math.abs(tau - 0.1) < DT / 2) early = palmGap();
    }
    expect(act.kind).toBe('set');
    // a tenth of a second before the ball arrives the palms are already on where its surface will be
    expect(early).toBeLessThan(0.05);
    expect(palmGap()).toBeLessThan(0.05);
  });

  it('a passing platform does not carry the ball: it stays where it met a hard-driven one', () => {
    const s = standing(5);
    const zone = new THREE.Vector3(0, s.a.height * 0.34, 5 - 0.45);
    s.v.passZone = zone;
    const act = s.a.startAction('pass', s.t);
    const ball = new THREE.Vector3();
    const vel = new THREE.Vector3(0, -6, 16);
    const B = s.v.rig.bones;
    // a serve at 17 m/s, flat and dropping, followed in to the platform
    for (let tau = 0.5; tau > 0; tau -= DT) {
      ball.set(zone.x - vel.x * tau, zone.y - vel.y * tau, zone.z - vel.z * tau);
      s.a.ballPos = ball;
      s.a.ballVel = vel;
      s.a.lookAt.copy(ball);
      s.step();
    }
    const at = world(B.handR);
    // the touch: the ball leaves up and forward at 8 m/s
    act.resolved = true;
    act.contactT = s.t;
    act.contactPoint.copy(zone);
    const out = new THREE.Vector3(0, 6, -5);
    let moved = 0;
    for (let ts = 0; ts < CHARACTER.pass.hold; ts += DT) {
      ball.copy(zone).addScaledVector(out, ts);
      s.a.ballVel = out;
      s.step();
      moved = Math.max(moved, world(B.handR).distanceTo(at));
    }
    // by then the ball is well over a metre away, and the wrists have given a few centimetres at most
    expect(ball.distanceTo(zone)).toBeGreaterThan(1);
    expect(moved).toBeLessThan(0.07);
  });
});
