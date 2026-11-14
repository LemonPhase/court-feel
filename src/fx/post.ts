import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Guards the HDR buffer before bloom: any NaN/Inf pixel (an overflowing half
 * float, a degenerate vertex on some GPUs) would be blurred across the bloom
 * mips and tone-map to black, flashing the whole screen. Clamp and replace them.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c)) || any(isinf(c));
      gl_FragColor = bad ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(clamp(c.rgb, 0.0, 32.0), clamp(c.a, 0.0, 1.0));
    }`,
};
import { ARENA, FX } from '../config';

/**
 * The last touch, on the finished picture: the corners fall off a little (the eye goes to the
 * court), and contrast and colour get a slight lift. Works on display values.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: ARENA.grade.vignette },
    uContrast: { value: ARENA.grade.contrast },
    uSaturation: { value: ARENA.grade.saturation },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uContrast;
    uniform float uSaturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 rgb = c.rgb;
      float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
      rgb = mix(vec3(l), rgb, uSaturation);
      // an S-curve about mid grey
      rgb = mix(rgb, rgb * rgb * (3.0 - 2.0 * rgb), uContrast);
      vec2 d = vUv - 0.5;
      rgb *= 1.0 - uVignette * smoothstep(0.25, 0.95, dot(d, d) * 2.0);
      gl_FragColor = vec4(rgb, c.a);
    }`,
};

/**
 * HDR pipeline: scene renders linear HDR, bloom only picks up pixels above
 * the threshold (effects are authored with intensities > 1, the arena is kept
 * below), then OutputPass tone-maps (ACES) and converts to sRGB, and a last pass grades the picture.
 */
export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private renderPass: RenderPass;
  private grade: ShaderPass;
  enabled = true;
  /** drawn before the main view each frame (the floor's mirror image) */
  preRender: (() => void) | null = null;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(size.x / 2), Math.floor(size.y / 2)),
      FX.bloomStrength,
      FX.bloomRadius,
      FX.bloomThreshold,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  /** change MSAA on the HDR targets (they are re-created on next use) */
  setSamples(n: number): void {
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples !== n) {
        rt.samples = n;
        rt.dispose();
      }
    }
  }

  /** the venue's grade: darker corners, contrast, saturation */
  setGrade(g: { vignette: number; contrast: number; saturation: number }): void {
    this.grade.uniforms.uVignette.value = g.vignette;
    this.grade.uniforms.uContrast.value = g.contrast;
    this.grade.uniforms.uSaturation.value = g.saturation;
  }

  setCamera(cam: THREE.Camera): void {
    this.renderPass.camera = cam;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
  }

  render(dt: number): void {
    this.preRender?.();
    this.composer.render(dt);
  }
}
