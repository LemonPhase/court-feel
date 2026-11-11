import * as THREE from 'three';
import { makeBodyMaterial, type BodyMaterial } from './bodyMaterial';
import { makeKitTexture } from './kitTexture';
import { sculptBody } from './sculpt';

/**
 * Procedurally built athlete: a 21-bone skeleton and one skinned mesh
 * (sculpt.ts) with a decal atlas for the face and the jersey number
 * (kitTexture.ts). Every bone has identity rest rotation, so local rotations
 * read in athlete space (x right, y up, -z fwd).
 */

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'clavL'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'fingersL'
  | 'clavR'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'fingersR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR';

export const BONE_ORDER: BoneName[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'clavL',
  'upperArmL',
  'lowerArmL',
  'handL',
  'fingersL',
  'clavR',
  'upperArmR',
  'lowerArmR',
  'handR',
  'fingersR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
];

export interface Kit {
  jersey: number;
  jerseyTrim: number;
  shorts: number;
  skin: number;
  hair: number;
  shoes: number;
  socks: number;
  pads: number;
  /** shoe sole, and the toe cap / heel / side flash */
  sole: number;
  shoeAccent: number;
  /** iris colour */
  eyes: number;
  /** short crop, buzz cut, bun, ponytail, curls */
  hairStyle: 0 | 1 | 2 | 3 | 4;
  /** brow weight (1 = average) */
  brow: number;
  /** how solidly built (scales every girth; 1 = average) */
  build: number;
  /** jersey number */
  number: number;
  /** taped fingers on each hand (0 to 2) */
  tape: 0 | 1 | 2;
}

export interface RigDims {
  H: number;
  hipY: number;
  hipJointY: number;
  hipJointX: number;
  spineLen: number;
  chestLen: number;
  neckLen: number;
  headLen: number;
  clavX: number;
  clavY: number;
  shoulderX: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  /** wrist to the knuckle line (where the fingers bend) */
  knuckle: number;
  /** wrist to the middle of the palm, and from the hand's centre plane to the palm's surface */
  palm: number;
  palmThick: number;
  thigh: number;
  shin: number;
  ankleY: number;
  footLen: number;
  heel: number;
}

export function dimsFor(H: number): RigDims {
  // anatomical proportions (fractions of standing height)
  return {
    H,
    hipY: 0.55 * H,
    hipJointY: 0.53 * H,
    hipJointX: 0.05 * H,
    spineLen: 0.12 * H, // spine bone (0.58H) -> chest (0.70H)
    chestLen: 0.135 * H, // chest -> neck base (0.835H)
    neckLen: 0.055 * H,
    headLen: 0.055 * H, // neck -> skull base (0.89H)
    clavX: 0.02 * H,
    clavY: 0.115 * H, // shoulder line at 0.815H
    shoulderX: 0.105 * H,
    upperArm: 0.186 * H,
    foreArm: 0.146 * H,
    hand: 0.108 * H,
    knuckle: 0.053 * H,
    palm: 0.034 * H,
    palmThick: 0.012 * H,
    thigh: 0.245 * H,
    shin: 0.246 * H,
    ankleY: 0.039 * H,
    footLen: 0.14 * H,
    heel: 0.035 * H,
  };
}

/** standing reach implied by the rig (shoulder + arm + a little shrug) */
export function standingReach(H: number): number {
  const d = dimsFor(H);
  return d.hipY + 0.03 * H + d.spineLen + d.clavY + 0.003 * H + d.upperArm + d.foreArm + d.hand * 0.85 + 0.025 * H;
}

export interface Rig {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: Record<BoneName, THREE.Bone>;
  dims: RigDims;
  material: BodyMaterial;
  /** fade the whole figure (1 = solid). Faded, only its outer surface shows: no limbs seen through the torso. */
  setOpacity(o: number): void;
  dispose(): void;
}

export function buildRig(H: number, kit: Kit): Rig {
  const d = dimsFor(H);
  const bones = {} as Record<BoneName, THREE.Bone>;
  const mk = (name: BoneName, parent: THREE.Bone | null, x: number, y: number, z: number) => {
    const bn = new THREE.Bone();
    bn.name = name;
    bn.position.set(x, y, z);
    if (parent) parent.add(bn);
    bones[name] = bn;
    return bn;
  };
  const hips = mk('hips', null, 0, d.hipY, 0);
  const spine = mk('spine', hips, 0, 0.03 * H, 0);
  const chest = mk('chest', spine, 0, d.spineLen, 0);
  const neck = mk('neck', chest, 0, d.chestLen, 0.008 * H);
  mk('head', neck, 0, d.headLen, -0.004 * H);
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const clav = mk(`clav${L}` as BoneName, chest, s * d.clavX, d.clavY, 0);
    const ua = mk(`upperArm${L}` as BoneName, clav, s * (d.shoulderX - d.clavX), 0.003 * H, 0.004 * H);
    const la = mk(`lowerArm${L}` as BoneName, ua, 0, -d.upperArm, 0);
    const ha = mk(`hand${L}` as BoneName, la, 0, -d.foreArm, 0);
    mk(`fingers${L}` as BoneName, ha, 0, -d.knuckle, 0);
    const th = mk(`thigh${L}` as BoneName, hips, s * d.hipJointX, d.hipJointY - d.hipY, 0);
    const sh = mk(`shin${L}` as BoneName, th, 0, -d.thigh, 0);
    mk(`foot${L}` as BoneName, sh, 0, -d.shin, 0);
  }
  const idx = (n: BoneName) => BONE_ORDER.indexOf(n);
  hips.updateMatrixWorld(true);
  const wp = (n: BoneName) => bones[n].getWorldPosition(new THREE.Vector3());

  const geo = sculptBody(d, kit, idx, wp);
  const atlas = makeKitTexture(kit);
  const material = makeBodyMaterial(atlas);
  const mesh = new THREE.SkinnedMesh(geo, material);
  const skeleton = new THREE.Skeleton(BONE_ORDER.map((n) => bones[n]));
  mesh.add(hips);
  hips.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.add(mesh);

  // Fading: a depth-only copy is drawn first, so the see-through figure shows its outer
  // surface only (an arm behind the chest stays hidden, as it would in frosted glass).
  let depthMesh: THREE.SkinnedMesh | null = null;
  let depthMat: THREE.MeshBasicMaterial | null = null;
  let opacity = 1;
  const setOpacity = (o: number) => {
    if (Math.abs(o - opacity) < 0.01) return;
    opacity = o;
    const ghost = o < 0.99;
    material.transparent = ghost;
    material.opacity = o;
    material.depthWrite = !ghost;
    if (ghost && !depthMesh) {
      depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
      depthMesh = new THREE.SkinnedMesh(geo, depthMat);
      depthMesh.bind(skeleton, mesh.bindMatrix);
      depthMesh.frustumCulled = false;
      depthMesh.renderOrder = GHOST_ORDER;
      root.add(depthMesh);
    }
    if (depthMesh) depthMesh.visible = ghost;
    mesh.renderOrder = ghost ? GHOST_ORDER + 1 : 0;
  };
  const dispose = () => {
    geo.dispose();
    material.dispose();
    depthMat?.dispose();
    atlas?.dispose();
    skeleton.dispose();
  };
  return { root, mesh, bones, dims: d, material, setOpacity, dispose };
}

/** a faded athlete draws after the floor decals (their render orders are below this) */
const GHOST_ORDER = 10;
