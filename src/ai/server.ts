import * as THREE from 'three';
import { AI, COURT } from '../config';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { ContactSystem } from '../game/contact';
import { moveTo, netYaw, stop, type Brain } from './brain';

/**
 * AI server: walks behind the end line, tosses, and hits a float serve at a
 * target through the normal contact system.
 */
export class ServerBrain implements Brain {
  phase: 'idle' | 'walk' | 'wait' | 'toss' | 'done' = 'idle';
  private t = 0;
  private err = 0;
  target = new THREE.Vector3();
  spotX = 0;
  skill = AI.hitterSkill;

  constructor(public athlete: Athlete) {}

  /** begin a serve sequence aimed at `target` (floor point) */
  serve(target: THREE.Vector3, spotX = this.spotX): void {
    this.target.copy(target);
    this.spotX = spotX;
    this.phase = 'walk';
    this.t = 0;
  }

  get spot() {
    return { x: this.spotX, z: this.athlete.side * (COURT.halfLength + 1.1) };
  }

  step(dt: number, g: Game): void {
    const a = this.athlete;
    const face = netYaw(a.side);
    this.t += dt;
    switch (this.phase) {
      case 'idle':
        stop(a, face);
        break;
      case 'walk': {
        const s = this.spot;
        const d = moveTo(a, s.x, s.z, { face, arrive: 0.4 });
        if (d < 0.15 && a.speed < 0.3) {
          this.phase = 'wait';
          this.t = 0;
        }
        break;
      }
      case 'wait':
        stop(a, face);
        if (this.t > 0.7) {
          if (g.contact.serveToss(a)) {
            this.phase = 'toss';
            this.err = g.rng.gauss() * (0.01 + (1 - this.skill) * 0.04);
          }
        }
        break;
      case 'toss': {
        stop(a, face);
        if (a.action?.kind === 'toss') {
          const info = g.contact.ideal(a, g.simTime, 0.8);
          if (info && g.simTime >= info.t - ContactSystem.swingLead(1) + this.err) {
            a.aiAim.copy(this.target);
            g.contact.startSwing(a, { aiErr: this.err });
            this.phase = 'done';
          }
        }
        break;
      }
      case 'done':
        stop(a, face);
        if (a.action?.kind === 'swing' && a.action.resolved && g.simTime - a.action.contactT > 0.4) a.endAction();
        break;
    }
  }
}
