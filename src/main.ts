import './ui/styles.css';
import { loadSettings } from './core/settings';
import { Game } from './game/game';

const app = document.getElementById('app')!;
const settings = loadSettings();
const game = new Game(app, settings);
(window as any).__court = game;
game.start();
app.addEventListener('click', () => game.input.requestLock());
