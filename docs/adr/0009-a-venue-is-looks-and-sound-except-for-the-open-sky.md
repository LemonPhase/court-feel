# A venue is looks and sound, except for the open sky

The court can stand in five places (`VENUES` in `src/config.ts`). A venue
changes how the place is drawn and lit and how its crowd sounds. It never
changes the court, the net, the lines, the free zone, the walls where a ball
goes dead, the athletes or the AI: a drill plays the same contacts at the
same times in every venue. The one exception is `openSky`. Under a roof the
ball is stopped at 12.5 m, the free playing space the rules ask for over an
international court, and a ball that hits it is out. At the seaside and on
the rooftop there is nothing up there, so the ball keeps flying and is
judged where it comes down. Keeping an invisible ceiling outdoors was turned
down because a sky ball whistled dead by nothing is wrong on a real outdoor
court.

## Consequences

- The open sky reaches the ball through `BallEnv.ceiling`, set by the game.
  `src/physics/` still reads only `config` and what it is handed.
- The side and end limits (15 m and 21 m from the centre) stay in every
  venue. Outdoors they stand where the bleachers and the rooftop's ball
  fence are. Past the open ends of the seaside court the ball still goes
  dead at 21 m with nothing drawn there. That only matters for a ball that
  was already going out.
- A beach venue has a hard court. Sand under a ball that bounces and players
  who run and jump as they do on a hard floor would be wrong, and a real
  sand game is another sport with other numbers.
