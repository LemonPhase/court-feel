import type { PositionId } from '../../config';
import type { Game } from '../game';
import type { Mode, ModeId } from './mode';
import { SpikeDrill } from './spikeDrill';
import { BlockDrill } from './blockDrill';
import { ReceiveDrill } from './receiveDrill';
import { SetterDrill } from './setterDrill';
import { FreePlay } from './freePlay';
import { MiniRally } from './miniRally';

export function createMode(id: ModeId, g: Game, pos: PositionId): Mode {
  switch (id) {
    case 'free':
      return new FreePlay(g, pos);
    case 'rally':
      return new MiniRally(g, pos);
    case 'block':
      return new BlockDrill(g, pos);
    case 'receive':
      return new ReceiveDrill(g, pos);
    case 'setter':
      return new SetterDrill(g, pos);
    case 'spike':
    default:
      return new SpikeDrill(g, pos);
  }
}
