import * as THREE from 'three';
import { CHARACTER } from '../config';

/**
 * The athlete's surface: a standard PBR material with three additions.
 *  - roughness per vertex (skin, cloth, shoes and hair differ),
 *  - a decal atlas laid over the vertex colours (face, jersey number),
 *  - a soft rim from above, which lifts the figure off the dark stands.
 */
export function makeBodyMaterial(atlas: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    envMapIntensity: CHARACTER.envIntensity,
    map: atlas,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: CHARACTER.rim };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRough;\nvarying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRough;\nuniform float uRim;')
      // the atlas is premultiplied: lay it over the vertex colour
      .replace('#include <map_fragment>', '')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        #ifdef USE_MAP
          vec4 decal = texture2D( map, vMapUv );
          diffuseColor.rgb = diffuseColor.rgb * ( 1.0 - decal.a ) + decal.rgb;
        #endif`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vRough;')
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          vec3 rimV = normalize( vViewPosition );
          float rimF = pow( 1.0 - saturate( dot( normal, rimV ) ), 3.0 );
          float rimUp = 0.35 + 0.65 * saturate( inverseTransformDirection( normal, viewMatrix ).y * 0.5 + 0.5 );
          totalEmissiveRadiance += diffuseColor.rgb * rimF * rimUp * uRim;
        }`,
      );
  };
  // one program for every athlete
  mat.customProgramCacheKey = () => 'court-feel-body';
  return mat;
}
