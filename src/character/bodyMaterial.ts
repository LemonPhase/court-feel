import * as THREE from 'three';
import { CHARACTER } from '../config';

/**
 * The athlete's surface: a standard PBR material with three additions.
 *  - roughness per vertex (skin, cloth, shoes and hair differ),
 *  - a decal atlas laid over the vertex colours (face, jersey number),
 *  - a soft rim from above, which lifts the figure off the dark stands,
 *  - fill light from the sides of the hall on upright surfaces (faces),
 *  - for your own body in first person, a dissolve close to the lens (`nearFade`): the lens clips an
 *    arm that passes it, and a clean cut would show the inside of the sleeve.
 */
export interface BodyMaterial extends THREE.MeshStandardMaterial {
  /** distance from the lens (m) where the surface starts to show, and where it is whole; (0, 0) = no dissolve */
  nearFade: THREE.Vector2;
}

export function makeBodyMaterial(atlas: THREE.Texture | null): BodyMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    envMapIntensity: CHARACTER.envIntensity,
    map: atlas,
  }) as BodyMaterial;
  mat.nearFade = new THREE.Vector2(0, 0);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: CHARACTER.rim };
    shader.uniforms.uSide = { value: CHARACTER.sideFill };
    shader.uniforms.uNearFade = { value: mat.nearFade };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRough;\nvarying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vRough;\nuniform float uRim;\nuniform float uSide;\nuniform vec2 uNearFade;',
      )
      // the atlas is premultiplied: lay it over the vertex colour
      .replace(
        '#include <map_fragment>',
        /* glsl */ `if ( uNearFade.y > 0.0 ) {
          // screen-door dissolve towards the lens (no blending: the surface stays opaque where it shows)
          float shown = smoothstep( uNearFade.x, uNearFade.y, length( vViewPosition ) );
          float noise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
          if ( shown <= noise ) discard;
        }`,
      )
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
          float upness = inverseTransformDirection( normal, viewMatrix ).y;
          float rimUp = 0.35 + 0.65 * saturate( upness * 0.5 + 0.5 );
          totalEmissiveRadiance += diffuseColor.rgb * ( rimF * rimUp * uRim + ( 1.0 - abs( upness ) ) * uSide );
        }`,
      );
  };
  // one program for every athlete
  mat.customProgramCacheKey = () => 'court-feel-body';
  return mat;
}
