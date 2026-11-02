import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FX } from '../config';

/**
 * HDR pipeline: scene renders linear HDR, bloom only picks up pixels above
 * the threshold (effects are authored with intensities > 1, the arena is kept
 * below), then OutputPass tone-maps (ACES) and converts to sRGB.
 */
export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private renderPass: RenderPass;
  enabled = true;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(size.x / 2), Math.floor(size.y / 2)),
      FX.bloomStrength,
      FX.bloomRadius,
      FX.bloomThreshold,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setCamera(cam: THREE.Camera): void {
    this.renderPass.camera = cam;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
