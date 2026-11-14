import { VENUES, type VenueId, type VenueSpec } from '../config';

/**
 * The venue the court is drawn in right now. The game sets it (from the saved setting, or a link) before it
 * builds the arena. Everything that draws reads it. Physics, contacts, AI and input never do: the one thing
 * a venue changes about play, the open sky, reaches the ball through `BallEnv`.
 */
export let VENUE_ID: VenueId = 'hall';
export let VENUE: VenueSpec = VENUES.hall;

export function setVenue(id: VenueId): void {
  VENUE_ID = id;
  VENUE = VENUES[id];
}
