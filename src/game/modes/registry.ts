import type { PositionId } from '../../config';
import type { Game } from '../game';
import type { Mode, ModeId } from './mode';
import { SpikeDrill } from './spikeDrill';
import { BlockDrill } from './blockDrill';

export function createMode(id: ModeId, g: Game, pos: PositionId): Mode {
  switch (id) {
    case 'block':
      return new BlockDrill(g, pos);
    case 'spike':
    default:
      return new SpikeDrill(g, pos);
  }
}
