// What still breaks the layering of docs/adr/0010, by name. tests/architecture.test.ts fails when
// the code and these lists disagree, in either direction: a new entry has to be written here on
// purpose, and a fixed one has to be taken out.
//
// The lists only get shorter. A pull request that was open before this file existed adds its own
// entries when it rebases; nothing else adds to them. One thing can look like an addition and is
// not: a refactor step that takes a breach out of the simulation can leave it with `Game`, the
// shell that still builds the display (the ball's meshes became `game.ts -> world/ballView.ts`).
// That is the same breach, one step nearer to where it ends. Keep each list sorted, one entry per line.

/** imports that reach a layer the importing file may not see, as 'importer -> imported' (type-only imports count) */
export const KNOWN_IMPORTS: readonly string[] = [
  'src/game/athlete.ts -> src/character/rig.ts',
  'src/game/body.ts -> src/character/rig.ts',
  'src/game/game.ts -> src/camera/cameraRig.ts',
  'src/game/game.ts -> src/character/athleteView.ts',
  'src/game/game.ts -> src/character/bodyMaterial.ts',
  'src/game/game.ts -> src/character/kits.ts',
  'src/game/game.ts -> src/character/rig.ts',
  'src/game/game.ts -> src/fx/effects.ts',
  'src/game/game.ts -> src/fx/post.ts',
  'src/game/game.ts -> src/fx/setGuide.ts',
  'src/game/game.ts -> src/fx/setRing.ts',
  'src/game/game.ts -> src/fx/setSpot.ts',
  'src/game/game.ts -> src/game/modes/mode.ts',
  'src/game/game.ts -> src/game/modes/registry.ts',
  'src/game/game.ts -> src/ui/debug.ts',
  'src/game/game.ts -> src/ui/hud.ts',
  'src/game/game.ts -> src/ui/playWheel.ts',
  'src/game/game.ts -> src/ui/setBar.ts',
  'src/game/game.ts -> src/ui/setRadar.ts',
  'src/game/game.ts -> src/world/arena.ts',
  'src/game/game.ts -> src/world/ballView.ts',
  'src/game/game.ts -> src/world/floorReflection.ts',
  'src/game/game.ts -> src/world/textures.ts',
  'src/game/game.ts -> src/world/venue.ts',
  'src/game/modes/mode.ts -> src/world/textures.ts',
  'src/game/modes/serveDrill.ts -> src/fx/approachGuide.ts',
  'src/game/modes/spikeDrill.ts -> src/fx/approachGuide.ts',
  'src/game/tutorial.ts -> src/game/modes/mode.ts',
  'src/game/userController.ts -> src/camera/cameraRig.ts',
];

/** simulation files that touch the DOM (window, document, storage) */
export const KNOWN_DOM: readonly string[] = ['src/game/game.ts', 'src/game/tutorial.ts'];

/** simulation files that build scene objects: three.js classes that are not maths */
export const KNOWN_SCENE: readonly string[] = [
  'src/game/debugGizmos.ts',
  'src/game/game.ts',
  'src/game/modes/freePlay.ts',
  'src/game/modes/miniRally.ts',
  'src/game/modes/mode.ts',
  'src/game/modes/receiveDrill.ts',
  'src/game/modes/setterDrill.ts',
  'src/game/modes/spikeDrill.ts',
];

/** tests that fake the game with a cast (to `Game`, or to the `AiHost` the brains see), because a real one cannot be built without a browser */
export const KNOWN_FAKE_GAME: readonly string[] = [
  'tests/greenBite.test.ts',
  'tests/greenSet.test.ts',
  'tests/jumpSet.test.ts',
  'tests/middleBlock.test.ts',
  'tests/serve.test.ts',
  'tests/serveRun.ts',
  'tests/setterCall.test.ts',
  'tests/teamDefence.test.ts',
];
