import * as THREE from 'three';

const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _cur = new THREE.Vector3();
const _des = new THREE.Vector3();
const _delta = new THREE.Quaternion();
const _ws = new THREE.Vector3();

/** world quaternion of a bone's parent (identity if none) */
function parentWorldQuat(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  if (bone.parent) bone.parent.matrixWorld.decompose(_ws, out, _ws);
  else out.identity();
  return out;
}

/**
 * Rotate `bone` (minimal rotation from its current pose) so that the point
 * `childOffset` (in bone-local space) points at `target` (world).
 * Assumes matrixWorld of the bone and its ancestors is current.
 */
export function aimBone(bone: THREE.Bone, childOffset: THREE.Vector3, target: THREE.Vector3, weight = 1): void {
  bone.matrixWorld.decompose(_wp, _wq, _ws);
  _cur.copy(childOffset).normalize().applyQuaternion(_wq);
  _des.subVectors(target, _wp);
  if (_des.lengthSq() < 1e-10) return;
  _des.normalize();
  _delta.setFromUnitVectors(_cur, _des);
  if (weight < 1) _delta.slerp(IDENTITY, 1 - weight);
  _wq.premultiply(_delta);
  parentWorldQuat(bone, _pq).invert();
  bone.quaternion.copy(_pq.multiply(_wq));
  bone.updateMatrixWorld(true);
}
const IDENTITY = new THREE.Quaternion();

const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();

/**
 * Analytic two-bone IK. `upper` -> `lower` -> end (end is at `endOffset` in
 * lower's space). `pole` is a world-space direction the middle joint bends
 * towards. Returns the distance by which the target was out of reach.
 */
export function twoBoneIK(
  upper: THREE.Bone,
  lower: THREE.Bone,
  endOffset: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  weight = 1,
): number {
  const a = lower.position.length();
  const b = endOffset.length();
  upper.matrixWorld.decompose(_s, _wq, _ws);
  _t.copy(target);
  _dir.subVectors(_t, _s);
  let d = _dir.length();
  const maxD = (a + b) * 0.9995;
  const minD = Math.abs(a - b) + 1e-3;
  let over = 0;
  if (d > maxD) {
    over = d - maxD;
    d = maxD;
  }
  if (d < minD) d = minD;
  if (_dir.lengthSq() < 1e-10) _dir.set(0, -1, 0);
  _dir.normalize();
  const along = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - along * along));
  _pole.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) {
    // pole parallel to the reach direction: pick any perpendicular
    _pole.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
  }
  _pole.normalize();
  _elbow.copy(_s).addScaledVector(_dir, along).addScaledVector(_pole, h);
  const end = _t.copy(_s).addScaledVector(_dir, d);
  aimBone(upper, lower.position, _elbow, weight);
  aimBone(lower, endOffset, end, weight);
  return over;
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _target = new THREE.Quaternion();

/**
 * Orient a bone in world space from a basis: local -Y maps to `down`, and
 * local `side` axis (x) maps as close as possible to `sideDir`.
 */
export function orientBone(bone: THREE.Bone, down: THREE.Vector3, sideDir: THREE.Vector3, weight = 1): void {
  _y.copy(down).normalize().negate(); // local +Y = -down
  _x.copy(sideDir).addScaledVector(_y, -sideDir.dot(_y));
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  _target.setFromRotationMatrix(_m);
  parentWorldQuat(bone, _pq).invert();
  const local = _pq.multiply(_target);
  if (weight >= 1) bone.quaternion.copy(local);
  else bone.quaternion.slerp(local, weight);
  bone.updateMatrixWorld(true);
}

/** set a bone's world orientation directly */
export function setWorldQuat(bone: THREE.Bone, q: THREE.Quaternion): void {
  parentWorldQuat(bone, _pq).invert();
  bone.quaternion.copy(_pq.multiply(q));
  bone.updateMatrixWorld(true);
}
