import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BALL, COURT, PLAYER, SIM } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { AthleteView } from '../src/character/athleteView';
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
