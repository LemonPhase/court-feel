# Multiplayer: research and proposal

Status: **proposal, not started** (researched November 2026). Prerequisite: the full match
cycle (rotations, serving order, scoring to 25, side-outs, libero), which goes beyond the
current Mini Rally.

## Summary

- **Goal:** a 6 v 6 match with any number of humans (1 to 12) and AI in every other slot.
  Players can drop in and out (the AI takes over their athlete), and the timing feel is the
  same as single player.
- **You need one long-running process per match** that runs the simulation and the AI for
  everyone in it (a "room"). That is the only new piece of infrastructure the first versions
  need. The static game stays on Vercel.
- **Vercel alone cannot host that room.** Its WebSockets live inside Functions that close at
  the function's maximum duration, and players of one match are not guaranteed to share an
  instance. Its new Daemons run long-lived containers but don't accept inbound traffic. See
  [Can it run on Vercel alone?](#can-it-run-on-vercel-alone).
- **Cheapest path ($0 on Vercel Hobby):** the host player's browser runs the match and the
  others connect to it peer to peer (WebRTC); Vercel only serves the game and the lobby.
  Good for friends; it gives the host an advantage and the match ends if they leave.
- **Recommended path for fair, public matches:** a small Node.js room server that shares
  `src/` with the client, on a small VM (Fly.io or similar, a few dollars a month) or on
  Cloudflare Durable Objects. Vercel keeps the site and the lobby.
- **Most of the work is in the codebase, not the infrastructure:** split the simulation from
  rendering, replace the single "user" with per-player controllers, and make hit-stop,
  slow-mo, pause and replays local-only. Do this while building rotations and serving, not
  after.

## Goals and non-goals

Goals for the first online version:

- Private rooms by invite code or link (`?room=ABCD`), a lobby to pick team and position.
- 1 to 12 humans; empty slots are AI (the existing `TeamAI` / `TeamPlayer` brains).
- A player who disconnects is replaced by the AI on the spot; someone joining mid-match takes
  over an AI player at the next dead ball. Reconnecting gives the slot back.
- Timing grades online match single player: a release that is Perfect on your screen is
  Perfect on the server.

Not in the first version: public matchmaking, accounts, ranked play, voice chat, anti-cheat
beyond server validation.

## What the codebase already gives us

- **A fixed-step, seeded simulation.** 120 Hz with a seeded random generator
  (`src/game/game.ts:65`); tests check determinism and that the predictor matches the live
  simulation. A ball in flight changes only at a contact or a bounce, so the server can send
  "contact at tick T, ball state X" and every client re-simulates the flight itself instead
  of receiving a stream of ball positions.
- **The core runs in Node already.** `Athlete`, `ContactSystem` (through its `ContactHost`
  interface), `Judge`, the physics and `HitterBrain` all run in the Vitest suite, so a
  server can be TypeScript that shares `src/` with the client.
- **AI fill-in is nearly free.** `TeamAI.add(slot, athlete, isUser)` already treats the user
  as one slot among AI team-mates. Generalising that flag to "this slot belongs to player X"
  gives drop-in, drop-out and AI takeover.
- **The swing delay hides latency.** A swing's contact is scheduled 45 to 170 ms after the
  release. On a nearby server (one-way latency 10 to 40 ms) the release usually arrives
  before the contact happens.

## What has to change first

1. **Split `Game` into a headless `Match` and a client view.** Today `Game` owns both the
   WebGL renderer and the simulation, and `BallEntity` mixes ball physics with its meshes.
   - `Match` (no DOM, no three.js rendering): athletes, ball state, contacts, judge, AI
     brains, the mode's rules (rotation, serve order, score).
   - Client view: renderer, `AthleteView`s, effects, HUD, camera, audio, touch controls.
   - The Mini Rally rules (`src/game/modes/miniRally.ts`) and the AI teams
     (`src/ai/team.ts`, which takes a `Game` today) move onto `Match`.
2. **Replace the single user with per-player controllers.** `isUser` and `g.me` are checked
   across `team.ts`, `contact.ts` and `miniRally.ts`. Examples: aim comes from the local
   camera (`src/game/game.ts:166`), only the user gets aim assist and the user's stuff odds
   (`src/game/contact.ts`), the setter favours "the user" (`src/ai/team.ts:220`). Each player
   instead sends inputs (move, yaw, pitch, sprint, and press/release of jump, attack, block,
   pass, toss), stamped with the simulation tick. `UserController` keeps buffering, but on
   ticks rather than real time.
3. **Make time effects local-only.** Hit-stop (`src/fx/effects.ts:235`, `:262`, `:353`),
   slow-mo assist (`src/game/game.ts:608`), Esc pause and replays all freeze the simulation
   itself today. Online, the match never stops: hit-stop freezes only the local picture and
   catches up, slow-mo assist is off, pause opens the menu without pausing, and replays play
   at dead balls between points.
4. **Give each contact its own random seed.** Contacts draw from one shared generator. A seed
   per contact (for example, match seed plus touch number) lets the hitter's client predict
   its own contact and get the same result as the server.
5. **Settings that change the game become room settings.** Custom bodies (height, vert,
   spike power) and aim assist are per-player settings today; a room decides whether they are
   allowed, and the server clamps them (the ranges are in `BODY` in `src/config.ts`).

## How the networking works

The match runs in one place (the server, or the host's browser) and is the authority. The
main rule is to **grade every contact on the player's own timeline**: the Perfect window is
only about 100 ms wide (30 ms early to 70 ms late), so without compensating for latency a
50 ms delay would turn most Perfects into Late.

| What | Authority | What the client does |
|---|---|---|
| Your athlete's movement | Match | Predicts it locally, so it is instant; corrects if the match disagrees |
| Other athletes (human and AI) | Match | Shows them about 100 ms behind, from 20 to 30 snapshots a second |
| Ball in flight | Match, via contact and bounce events | Re-simulates the flight locally, shown at the present moment |
| Spikes, passes, sets, blocks | Match, using the player's input tick, accepted up to about 150 ms back | The hitter sees the result at once with full effects; others get the event |
| Rotation, score, serve order | Match | Receives events |
| Hit-stop, replays, camera | Local only | — |

- **Bandwidth is small.** A compact snapshot of 12 athletes (position, velocity, yaw, state,
  action) is about 250 bytes; at 30 a second that is under 10 KB/s per player. Inputs going
  up are under 1 KB/s. Plain JSON is fine to start with.
- **The hard part is the defender's view.** A hard spike (25 to 30 m/s) crosses the court in
  roughly 0.3 to 0.4 s, and a remote contact arrives 20 to 60 ms late. Showing the ball at
  the present moment while other athletes are shown slightly in the past needs care around
  the contact (the hitter's hand and the ball). This is what Phase 1 prototypes.
- **Why not peer-to-peer lockstep or rollback:** math functions like `sin` and `exp` can
  differ in the last bit between browsers, so 12 athletes would drift apart; and the AI's
  planning is heavy (it causes the ~12 ms slowest frames), so re-running several frames on
  every correction is not realistic. One authority is simpler and robust.

## Infrastructure

### What runs where

```
Browser (Vercel: static game)
  │ HTTPS ─▶ Lobby API (Vercel Function): create/join room → room address + token
  │ WSS   ─▶ Room server: Match @120 Hz + AI, authoritative      (recommended path)
  │   or
  │ WebRTC ─▶ host player's browser runs the Match               (free path)
  │                 └─ (later) Postgres (Supabase or Neon): accounts, results
```

### Can it run on Vercel alone?

Short answer: **not as a real-time game server, and not on Hobby.** Vercel has four kinds of
compute; none fits a room that runs a 120 Hz match for 20 to 60 minutes and that every player
connects to.

| Vercel product | Can it host the match? | Why |
|---|---|---|
| **Functions with WebSockets** (beta June 2026, reported GA October 2026) | No | Connections close when the function reaches its maximum duration (testers saw disconnects at about 5 minutes; Vercel's docs tell you to build reconnects). Each connection lives in its own function invocation and players of one match are not guaranteed to share an instance, so there is no single place to run the match. |
| **Daemons** (beta, October 2026) | No | Long-running containers, but they accept no inbound traffic: Vercel says to use Functions or Services for anything that answers HTTP or TCP. On Hobby, one 1-vCPU daemon uses the monthly allowance in about 10 hours. |
| **Sandbox** | Technically, as a hack | A microVM can expose a port on a public URL, so one sandbox per match could run a room server. But Hobby caps a session at 45 minutes and 10 at once, every match pays a boot, it's built for running untrusted code and agents, and a match uses the same small compute allowance. |
| **Functions (HTTP)** | Lobby only | Fine for "create room, join room, get address", and later accounts and results. |

What **does** work with Vercel as the only paid service is the **peer-to-peer host** setup:

- The host player's browser runs the `Match` (in a Web Worker, so rendering can't stall it).
  The simulation already runs in the browser, so this is the same code.
- Other players connect to the host over WebRTC data channels (which can be unreliable and
  unordered, like UDP). Game traffic never touches Vercel.
- Vercel serves the game and a small signaling API that passes the WebRTC connection offers
  between players: a handful of requests per player per match. It needs a small shared store
  between function calls (for example Upstash Redis from the Vercel Marketplace, which has a
  free tier).
- Public STUN servers are free. Some networks (strict NATs, some campus and corporate
  networks) block direct connections and need a TURN relay, which is the one piece Vercel
  doesn't offer; several TURN services have free tiers.
- Trade-offs: the host has zero latency (an advantage), the host's computer runs the match
  and renders, the match ends if the host leaves (unless we build host migration), and a host
  could cheat. Fine for friends, not for public play.
- It's a stepping stone, not a dead end: the same `Match` and the same messages move to a
  dedicated server later; only the transport changes.

### Hosting options for a dedicated room server

| Option | Fit | Notes |
|---|---|---|
| **Node.js on a small VM (Fly.io London region, or a VPS), plain `ws` or Colyseus** | **Recommended** | Same TypeScript; predictable CPU for a steady 120 Hz loop; easy to measure. Colyseus (open source; managed hosting from $15/month) adds rooms, matchmaking and reconnects. A plain Node process can move to Colyseus Cloud, Edgegap or another host later. |
| Cloudflare Durable Objects / PartyServer | Strong runner-up | One object per room code; no servers to manage; global. WebSocket messages are billed as requests, and hibernation saves nothing while a match is playing. Unknown: whether its CPU limits suit a 120 Hz loop with 12 AI players, so prototype before committing. |
| Supabase Realtime, Ably or another message service | No | Relays messages only, so a browser still has to run the match (the peer-to-peer setup with an extra hop and per-message costs). |
| Dedicated game-server platforms (Edgegap, GameFabric, Gameye) | Later, if it scales | Hathora's hosting shut down in May 2026: a reason to keep the server a plain, portable process. |

## Costs

Vercel Hobby (free) includes, per month: 4 hours of Active CPU, 360 GB-hours of provisioned
memory and 1 million function invocations. Hobby functions always run at 2 GB / 1 vCPU.
Hobby has no pay-as-you-go overage: past the cap, usage stops until the month resets or you
upgrade (third-party guides report the whole project stops serving, which would take the
game's website down too). Hobby is also for non-commercial, personal use only; Pro is $20 per
member per month (1,440 GB-hours and 16 Active CPU-hours included, then from $0.0106 per
GB-hour and $0.128 per CPU-hour).

| Setup | Extra cost per month | Notes |
|---|---|---|
| Vercel Hobby + peer-to-peer host | **$0** | Plus a TURN relay for blocked networks (free tiers exist). |
| Vercel Hobby + Node room server on a small VM | **about $2 to $5** | One small machine should host several matches; Phase 0 measures how many. |
| Vercel Hobby + Cloudflare Durable Objects | **$0 to test, $5** on Workers Paid | Free plan has daily limits. |
| Vercel Hobby + Colyseus Cloud | **from $15** | Managed rooms, matchmaking, reconnects. |
| Vercel Pro (only if the project goes commercial) | **$20 per member** | Not needed for multiplayer itself. |

If game traffic went through Vercel Functions anyway (as a relay between the host and the
other players), memory is billed for as long as connections are open: a 30-minute, 12-player
match costs between about 1 GB-hour (all connections share one instance) and 12 GB-hours
(each on its own), so Hobby's 360 GB-hours would cover roughly 30 to 360 such matches a
month, with a reconnect every ~5 minutes. Running the match itself on Vercel compute is
limited by CPU: if the simulation keeps one core busy, Hobby's 4 Active CPU-hours are about 8
half-hour matches a month. Neither is worth it next to a few dollars for a VM.

## Proposed plan

0. **Groundwork (no infrastructure; alongside rotations and serving).** The `Match` / view
   split, per-player controllers, local-only time effects, per-contact seeds, room settings.
   A Vitest test plays a full rally headless in Node. **Measure the CPU cost of one match** in
   Node: it decides how many matches fit on a machine and whether Durable Objects are viable.
1. **Simulated network.** Run the `Match` in a Web Worker or a second tab with injected delay
   and jitter (50 to 150 ms). Build prediction, interpolation, lag compensation and the
   defender's ball timeline here, where it is cheap to iterate.
2. **Online with friends, $0.** Peer-to-peer host mode: lobby and signaling on Vercel
   Functions, WebRTC data channels, invite links, 1 to 12 humans with AI in every other slot,
   AI takeover on disconnect, reconnects.
3. **Dedicated room server.** Same protocol over WebSockets to a Node room server (Fly.io
   London to start), so matches are fair and survive any player leaving. Deploy it from CI
   next to the existing Vercel deployments.
4. **Polish and scale.** Quick-play matchmaking, accounts and stats (Postgres), spectators,
   more regions, quick calls ("Mine!", "HIGH!"), WebTransport or WebRTC to the server if
   latency needs it.

## Open questions

- CPU cost of one 12-athlete match at 120 Hz in Node (Phase 0).
- How the defender's view should look in the ~50 ms after a remote spike (Phase 1).
- Room rules for custom bodies and aim assist (allowed, capped, or off).
- Can a 120 Hz loop with full AI run inside a Durable Object within its CPU limits?

## Sources

- Vercel: [WebSockets on Functions](https://vercel.com/docs/functions/websockets),
  [Fluid compute pricing](https://vercel.com/docs/fluid-compute/pricing),
  [Hobby plan](https://vercel.com/docs/plans/hobby-plan),
  [Daemons limits](https://vercel.com/docs/daemons/limits),
  [Functions, containers and daemons](https://vercel.com/kb/guide/vercel-functions-containers-daemons),
  [Sandbox SDK reference](https://vercel.com/docs/sandbox/sdk-reference)
- [WebSocket public beta (releases.sh)](https://releases.sh/release/rel_yNUn74KGsQqbJOSpgMBnY-vercel-launches-websocket-support-in-public-beta-for-functions),
  [WebSocket GA report (Create With)](https://createwith.com/tool/vercel/updates/vercel-makes-websocket-support-generally-available),
  [hands-on test (Classmethod)](https://dev.classmethod.jp/en/articles/vercel-functions-websocket-public-beta-verification/),
  [Ably on WebSockets on Vercel](https://ably.com/topic/ai-stack/websockets-on-vercel-why-serverless-functions-cant-host-them)
- [Vercel daemons and containers overview (buildmvpfast)](https://www.buildmvpfast.com/blog/vercel-python-backend-containers-daemons-2026),
  [Daemons private networking thread](https://community.vercel.com/t/private-networking-for-vercel-daemons/51441)
- Cloudflare: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing),
  [WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/index.md),
  [How PartyKit works](https://docs.partykit.io/how-partykit-works/)
- Colyseus: [pricing](https://www.colyseus.io/pricing),
  [Cloud billing](https://docs.colyseus.io/cloud/pricing-billing)
- Hathora shutdown: [Crux](https://crux.supercraft.host/blog/hathora-shut-down-where-to-go-after-may-2026/),
  [GamesBeat](https://gamesbeat.com/?p=318174)
