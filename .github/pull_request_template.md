## What changes for the player

<!-- One or two sentences in the player's words: what do they see, hear or feel differently? -->

## Why

<!-- Link the feel report, bug or idea (for example "Closes #12"). For a change to the feel, say what was reported, the cause, the fix and how you measured it. -->

## The court test

<!-- One question for each rule of the principle (README.md#the-principle). Leave out anything that doesn't apply. -->

- **Real sport:** what does a real court do, and where do the numbers come from (rules, measurement, video, coach, your own play)? Did you bend anything to make it playable, and why?
- **Skill:** is the player still graded on the volleyball skill, with every input going through `Input`?
- **Honest physics:** does the ball still go where the contact sends it?
- **Effects:** do they scale with the touch and keep the ball visible?
- **Played:** how did you play it (drill, position, camera, device)? Who else tried the preview?

## Checklist

- [ ] `npm run check` and `npm run build` pass
- [ ] Unit test for any physics, timing, contact or AI change
- [ ] New tunables are in `src/config.ts`
- [ ] README (and the start screen and in-game hints) updated if controls, modes, settings or config sections changed
- [ ] The reason for a call someone would argue about again is in a doc comment next to the code, or in `docs/adr/` if it has no place there
- [ ] Screenshots or a clip for anything visible, and `docs/screenshots/` retaken if one of those moments changed
- [ ] CREDITS.md updated if an asset or library was added
