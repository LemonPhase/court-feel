# Serve lessons

Learn has a lesson for each serve: standing float, jump float, jump serve. Each is the spike tutorial's three balls on the Serve Drill: together (the ball waits for you at each moment), slow motion, full speed. The toss comes first. The strip reads `TOSS › RUN › JUMP › DRAW › HIT`, and `TOSS › DRAW › HIT` for the standing float, which is hit from the floor. The toss ring shows a white mark at the serve's own toss. A finished lesson is ticked under Learn.

## Sub-features

- `serve-lesson-learn` the card `The serve, in three balls` under Learn, with one button per serve, ticked once finished.
- `serve-lesson-toss` the together ball lets go of a held `q` at the serve's own toss; slow motion and full speed leave it to you, with the white mark on the ring.
- `serve-lesson-float` the standing float: time stops as the toss tops out until the left button is held, then at the gold until it is let go.
- `serve-lesson-jump` the jump float and the jump serve: the server stays behind the line until GO, then run, jump, draw, hit as in the spike tutorial.
- `serve-lesson-verdict` after each serve the coach says one thing; out, in the net and foot faults are not clean serves.
- `serve-lesson-end` the end dialog: `KEEP SERVING`, `Choose another drill`.

## How to get to it (user POV)

- On the start screen open Learn and click `Standing float`, `Jump float` or `Jump serve` on the card `The serve, in three balls`.
- Open a quick-start link: `?tutorial=N&lesson=float`, `jumpFloat` or `jump` (N: 0 welcome, 1 together, 2 slow motion, 3 full speed).
- In the pause menu of a running lesson choose `Restart drill`: the ball the lesson is on starts again.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipes use the manual clock, a test hook: name it in the proof.
- Let go of every key and button before `court open`: Playwright keeps a key held across pages, and the next `keydown` of it is then a key repeat the game ignores.

- **Enter from Learn.** Run `court open --fresh`, `court click 'role=button[name="Skip to the drills"]'`, `court click 'role=button[name="Learn"]'` and `court click 'role=button[name="Standing float"]'`. The state line shows `"tutorial":{"step":0,...}`, the title `Serve Drill · Standing float`, the score `Standing float · rep 1` and the banner `Serve it yourself.`
- **Standing float, together.** Run `court open '?tutorial=1&lesson=float' --fresh --manual`, `court step 2`. The cue is `QHold to toss`. Run `court keydown q`, `court step 0.5`, `court keyup q`: the toss went up at 0.36 s (the white mark) and the cue is `Left mouseHold to draw your arm back`. Run `court step 1` and `court eval 'g.tutorial.waiting'`: `true`, the ball waits near the top of the toss. Run `court mouse down left`, `court step 2`: the cue is `Left mouseLet go!` and time is stopped at the gold. Run `court mouse up left`, `court step 0.3`: the grade is `PERFECT` with `62 km/h · full power`. Run `court step 8 --until 'g.tutorial.director.beat==="result"'` and `court eval 'g.tutorial.director.line'`: `Perfect. That is the whole standing float: toss, draw, hit.`
- **The white mark.** Run `court open '?tutorial=2&lesson=jumpFloat' --fresh --manual`, `court step 2`, `court keydown q`, `court step 0.2` and `court shot toss-mark`: the ring around the crosshair a quarter full and a white tick on it a little left of the top. Release with `court keyup q`.
- **Jump serve, together.** Run `court open '?tutorial=1&lesson=jump' --fresh --manual`, `court step 2`, `court keydown q`, `court step 0.5`, `court keyup q`. Run `court step 1`: the cue is `Shift+WHold to run in` and `court eval 'g.tutorial.waiting'` is `true` (GO). Run `court keydown Shift`, `court keydown w`, `court step 1`: the cue is `SpaceHold at the line to jump`. Run `court keydown Space`, `court step 1`: the cue is `Left mouseHold to draw your arm back`, the server in the air. Run `court mouse down left`, `court step 2`, `court mouse up left`, then let go of Space, w and Shift, and `court step 0.2`: the grade is `PERFECT` with `95 km/h · full power`. Run `court step 8 --until 'g.tutorial.director.beat==="result"'` and `court eval 'g.tutorial.director.line'`: `Perfect. That is the whole jump serve: toss, run, jump, draw, hit.` Run `court eval '(g.me.takeoffPos.z - 9).toFixed(2)'`: about `1.07`, the take-off behind the line.
- **The jump float, together.** The jump serve bullet with `lesson=jumpFloat`: `PERFECT` with `73 km/h · full power`.
- **Full speed to the end.** Run `court open '?tutorial=3&lesson=float' --fresh --manual`, `court step 20 --until 'g.mode.canServe(g.me)'`, `court keydown q`, `court step 0.36`, `court keyup q`, `court step 3 --until 'g.ball.active && g.ball.vel.y < 1.8'`, `court mouse down left`, `court step 2 --until '(()=>{const i=g.contact.ideal(g.me,g.simTime,1.5); return !!i && i.t - g.simTime <= g.contact.constructor.swingLead(1)})()'`, `court mouse up left`, `court step 8 --until '!g.tutorial.active'`. A clean serve in their court ends the lesson: the state line shows `"dialog":"Tutorial complete"`, and `court state` lists the buttons `KEEP SERVING` and `Choose another drill` and the text `That is the standing float: toss, draw, hit. The tutorial is done.` Run `court eval 'localStorage.getItem("courtFeel.serveLessons.v1")'`: `["float"]`. In Learn, `court eval '[...document.querySelectorAll(".lesson-picks button")].map(b=>b.textContent).join(" / ")'` reads `✓ Standing float / Jump float / Jump serve`.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- The lesson reads held buttons in the together ball: `q`, Shift + `w`, Space and the left button may go down before their moment and still count.
- A serve that is not clean (out, in the net, a foot fault, a toss not hit) is taken once more, then the lesson moves on anyway, as in the spike tutorial. A by-hand run that misses shows `One more.` at the end of the coach's line.
- The hold times are for an Outside Hitter from where the drill stands them; step and read `g.contact.ideal(g.me, g.simTime, 1.5)` for the contact.
- `1`, `2`, `3` do nothing during a lesson, and the touch layout hides the `SERVE` chips: one lesson, one serve.
- A link opened in a fresh browser has no spike tutorial flag, so `Choose another drill` lands on the first-visit welcome, not Train.
