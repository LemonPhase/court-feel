# Credits

Court Feel uses no third-party art or audio files. Everything is generated at
runtime by code in this repository and is released with the project (MIT,
see `package.json`); you may treat the generated assets as CC0.

| Asset | Source | License |
|---|---|---|
| Wood floor, net, antenna, ball, crowd, LED boards and ribbon, hall walls, crack textures | Procedural canvas code in `src/world/textures.ts` | Project code (MIT) / output CC0 |
| The hall (stands, seats, roof, referee stand) | Built from boxes and tubes in `src/world/` | Project code (MIT) / output CC0 |
| Athlete character (mesh, skeleton, skin weights, face and jersey number) | Procedurally sculpted and painted in `src/character/` | Project code (MIT) / output CC0 |
| Animations (approach, jump, swing, block, pass, set, land, idle, run) | Procedural pose keys + IK in `src/character/` | Project code (MIT) |
| Sounds (ball contacts, floor, net, squeaks, whistle, crowd) | Synthesised with the Web Audio API in `src/audio/` | Project code (MIT) |

## Libraries

| Library | License |
|---|---|
| [three.js](https://threejs.org) (incl. `examples/jsm` post-processing) | MIT |
| [Vite](https://vitejs.dev) | MIT |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 |
| [Vitest](https://vitest.dev) | MIT |
| [Playwright](https://playwright.dev) (dev tooling only, not bundled) | Apache-2.0 |
