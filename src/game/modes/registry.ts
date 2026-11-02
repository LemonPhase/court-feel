import type { PositionId } from '../../config';
import type { Game } from '../game';
import type { Mode, ModeId } from './mode';
import { SpikeDrill } from './spikeDrill';

export function createMode(id: ModeId, g: Game, pos: PositionId): Mode {
  switch (id) {
    case 'spike':
    default:
      return new SpikeDrill(g, pos);
  }
}
