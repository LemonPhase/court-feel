import * as THREE from 'three';
import { ARENA } from '../config';

/** objects on this layer are mirrored in the floor (athletes, ball, net, boards, crowd) */
export const REFLECT_LAYER = 1;

/**
 * The varnished floor mirrors what stands on it. Each frame the scene's
 * mirrored objects are drawn once more from below the floor into a small
 * HDR target; the floor materials look that image up at their own screen
 * position and add it, stronger at grazing angles and on glossier boards.
 */
export class FloorReflection {
  readonly target: THREE.WebGLRenderTarget;
  private cam = new THREE.PerspectiveCamera();
  /** world position -> coordinates in the mirror image */
  private matrix = { value: new THREE.Matrix4() };
  private map: { value: THREE.Texture | null };
  private strength = { value: ARENA.reflection.strength };
  private black: THREE.Texture;
  enabled = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cam.layers.set(REFLECT_LAYER);
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
    this.map = { value: this.target.texture };
  }

  /** `w`, `h`: drawing-buffer size of the main view in pixels */
  setSize(w: number, h: number): void {
    const s = ARENA.reflection.scale;
    this.target.setSize(Math.max(4, Math.round(w * s)), Math.max(4, Math.round(h * s)));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.map.value = on ? this.target.texture : this.black;
    this.strength.value = on ? ARENA.reflection.strength : 0;
  }

  /** draw the mirror image for this camera (call before the main view is drawn) */
  render(camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) return;
    const v = this.cam;
    // the camera's twin below the floor: position, aim and up mirrored in the plane y = 0
    camera.updateMatrixWorld();
    _pos.setFromMatrixPosition(camera.matrixWorld);
    _dir.set(0, 0, -1).transformDirection(camera.matrixWorld);
    _upv.set(0, 1, 0).transformDirection(camera.matrixWorld);
    v.position.set(_pos.x, -_pos.y, _pos.z);
    v.up.set(_upv.x, -_upv.y, _upv.z);
    v.lookAt(_pos.x + _dir.x, -(_pos.y + _dir.y), _pos.z + _dir.z);
    v.near = camera.near;
    v.far = camera.far;
    v.updateMatrixWorld();
    v.projectionMatrix.copy(camera.projectionMatrix);
    v.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    this.matrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.matrix.value.multiply(v.projectionMatrix).multiply(v.matrixWorldInverse);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevShadows = r.shadowMap.autoUpdate;
    // the shadow maps of the main view serve this pass too
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(this.scene, v);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadows;
  }

  /** make a floor material show the mirror image */
  apply(mat: THREE.MeshStandardMaterial): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tRefl = this.map;
      shader.uniforms.uReflMatrix = this.matrix;
      shader.uniforms.uReflStrength = this.strength;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uReflMatrix;\nvarying vec4 vRefl;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRefl = uReflMatrix * modelMatrix * vec4( transformed, 1.0 );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tRefl;\nuniform float uReflStrength;\nvarying vec4 vRefl;')
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `{
            // rougher boards blur the mirror and dim it; it is strongest seen along the floor
            vec2 ruv = vRefl.xy / vRefl.w;
            float blur = ${ARENA.reflection.blur.toFixed(2)} + roughnessFactor * ${ARENA.reflection.blurRough.toFixed(2)};
            vec3 mirror = min( textureLod( tRefl, ruv, blur ).rgb, vec3( ${ARENA.reflection.max.toFixed(2)} ) );
            float nv = saturate( dot( normal, normalize( vViewPosition ) ) );
            float fres = ${ARENA.reflection.facing.toFixed(3)} + ( 1.0 - ${ARENA.reflection.facing.toFixed(3)} ) * pow( 1.0 - nv, 4.0 );
            outgoingLight += mirror * fres * uReflStrength * saturate( 1.0 - roughnessFactor * ${ARENA.reflection.roughFade.toFixed(2)} );
          }
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'court-feel-floor';
  }
}

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _upv = new THREE.Vector3();
