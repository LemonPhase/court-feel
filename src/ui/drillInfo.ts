import type { PositionId } from '../config';
import type { ModeId } from '../game/modes/mode';

/** one line of a key list: the key (or touch control) and what it does */
export interface KeyHint {
  k: string;
  a: string;
  /** only a hitter has it (the set calls): not shown to a setter or a libero */
  hitters?: true;
}

/** the positions that call their own set (the ones SET_PLAYS has plays for) */
export const HITTERS: readonly PositionId[] = ['OH', 'MB', 'OPP'];

/** what the menu says about a mode before you start it, and again on pause */
export interface DrillInfo {
  /** the skill it trains, on the row's tag */
  tag: string;
  /** one line for the list */
  short: string;
  /** what happens, for the panel */
  about: string;
  /** what the score is made of ("Scored on" for drills, "Ends" for a game) */
  scored: string;
  /** only the keys this mode needs: the full list is under Learn */
  keys: KeyHint[];
  /** the same, for the touch controls */
  touch: KeyHint[];
}

const STICK_RUN: KeyHint = { k: 'Left thumb', a: 'Push the stick out to the ring to run the approach' };
const STICK_MOVE: KeyHint = { k: 'Left thumb', a: 'Move' };

/**
 * These say the same things as the in-game hints (each mode's hint()) and the README's
 * controls: keep them in step.
 */
export const DRILL_INFO: Record<ModeId, DrillInfo> = {
  spike: {
    tag: 'Attack',
    short: 'The setter sets you, rep after rep.',
    about: 'A coach tosses to the setter and the setter sets your lane. A spot on the floor shows where your feet should be at contact.',
    scored: 'the timing grade, power in km/h, the kill and the target zone',
    keys: [
      { k: 'Shift + W', a: 'Approach' },
      { k: 'Space', a: 'Plant and jump. Hold to load.' },
      { k: 'Left mouse', a: 'Hold to wind up, release to swing. A tap is a tip.' },
      { k: '1  2  3', a: 'Call your set', hitters: true },
      { k: 'B', a: 'Opposing block: off, single, double' },
    ],
    touch: [
      STICK_RUN,
      { k: 'JUMP', a: 'Hold to load, release to take off' },
      { k: 'HIT', a: 'Hold to wind up, release to swing. A tap is a tip.' },
      { k: 'SET CALL', a: 'Top left: call your set', hitters: true },
      { k: 'VS BLOCK', a: 'Top left: opposing block off, single, double' },
    ],
  },
  block: {
    tag: 'Net',
    short: 'Read the set, move, time the jump.',
    about: 'Their setter sets one of three hitters. Every rep starts at the net in front of their middle, who runs a quick on every ball.',
    scored: 'stuffs, soft blocks and touches',
    keys: [
      { k: 'A  D', a: 'Shuffle along the net' },
      { k: 'Right mouse', a: 'Hands up. Hold it in the air to press over.' },
      { k: 'Space', a: 'Block jump' },
    ],
    touch: [
      { k: 'Left thumb', a: 'Shuffle along the net' },
      { k: 'BLOCK', a: 'Hold: hands up and jump' },
    ],
  },
  receive: {
    tag: 'First contact',
    short: 'Pass serves and dig attacks to the target.',
    about: 'Float serves and attacks come at you. Pass to the green setter target; your setter and hitter finish the good ones.',
    scored: 'every pass, rated 0 to 3',
    keys: [
      { k: 'W A S D', a: 'Get behind the ball' },
      { k: 'E', a: 'Pass or dig. Press early and hold.' },
    ],
    touch: [
      { k: 'Left thumb', a: 'Get behind the ball' },
      { k: 'PASS', a: 'Hold. Press early.' },
    ],
  },
  setter: {
    tag: 'Second contact',
    short: 'Run the offence and watch them finish.',
    about: 'Passes come in. Look at a hitter (outside, quick or back set) and set as the ball drops. Your hitters attack a live blocker.',
    scored: 'the set, and how your hitter finishes it',
    keys: [
      { k: 'W A S D', a: 'Get under the ball' },
      { k: 'Mouse', a: 'Look at the hitter you want' },
      { k: 'Right mouse', a: 'Set, just before it lands on your hands' },
    ],
    touch: [
      { k: 'Left thumb', a: 'Get under the ball' },
      { k: 'Right thumb', a: 'Drag to look at the hitter you want' },
      { k: 'BLOCK', a: 'Hold: it sets when the ball drops onto you' },
    ],
  },
  free: {
    tag: 'Open gym',
    short: 'A ball machine feeds you. Practise anything.',
    about:
      'No score. The ball machine feeds a set, a free ball, a float serve or a hard attack. Feed 5 is serve practice: toss and hit your own from behind the end line.',
    scored: 'nothing. This one is for the feel.',
    keys: [
      { k: '1 to 5', a: 'Feed type' },
      { k: 'F', a: 'Feed a ball' },
      { k: 'T', a: 'Auto feed' },
      { k: 'Q', a: 'Serve toss' },
    ],
    touch: [
      STICK_MOVE,
      { k: 'Top left', a: 'Feed types, FEED a ball, AUTO feed' },
      { k: 'TOSS', a: 'Serve toss, in serve practice' },
      { k: 'HIT  PASS  BLOCK', a: 'As in the drills' },
    ],
  },
  rally: {
    tag: 'Six a side',
    short: 'Open rallies. Play as long as you like.',
    about:
      'Six against six, you in your position. The AI receives, sets (often to you), attacks, blocks and digs. "Your ball!" and a green landing marker tell you when it is yours.',
    scored: 'when you stop. The score runs; there is no set to win yet.',
    keys: [
      { k: 'E', a: 'Pass or dig when it is your ball' },
      { k: 'Shift + W', a: 'Approach when the set is yours' },
      { k: 'Space', a: 'Jump: to hit, or to block at the net' },
      { k: 'Left mouse', a: 'Hold to wind up, release to swing' },
      { k: 'Right mouse', a: 'Block at the net, set off it' },
      { k: '1  2  3', a: 'Call your set', hitters: true },
    ],
    touch: [
      STICK_RUN,
      { k: 'PASS', a: 'Hold when it is your ball' },
      { k: 'JUMP  HIT', a: 'As in the Spike Drill' },
      { k: 'BLOCK', a: 'Hold: hands up and jump, or set' },
    ],
  },
};

/** Train: one skill at a time, in the order of a rally's hardest part first */
export const TRAIN_MODES: readonly ModeId[] = ['spike', 'block', 'receive', 'setter', 'free'];
/** Play: the games */
export const PLAY_MODES: readonly ModeId[] = ['rally'];

/** game lengths that are not built yet: shown under Play so the place for them is visible */
export const COMING_FORMATS: readonly { title: string; short: string }[] = [
  { title: 'One set', short: 'A single set, played to the end.' },
  { title: 'Best of 3', short: 'First to two sets.' },
  { title: 'Best of 5', short: 'First to three sets. The full match.' },
];

/** your setter's calls in a rally (the bubble over their head) */
export const SETTER_CALLS: readonly { word: string; out: boolean; means: string }[] = [
  { word: 'GO!', out: false, means: "Or 1!, FAST!... (your call's name). In system: start your approach." },
  { word: 'HIGH!', out: true, means: 'Out of system. Wait for the high ball.' },
  { word: 'HELP!', out: true, means: "The setter can't get there. No set this time." },
];

export interface KeyGroup {
  title: string;
  rows: KeyHint[];
}

/** every control, under Learn */
export const ALL_CONTROLS: { kb: KeyGroup[]; touch: KeyGroup[] } = {
  kb: [
    {
      title: 'Move',
      rows: [
        { k: 'W A S D', a: 'Move. Forward is fastest, backpedal slowest.' },
        { k: 'Shift', a: 'Approach / sprint' },
        { k: 'Mouse', a: 'Look. You aim where you look.' },
      ],
    },
    {
      title: 'Attack and serve',
      rows: [
        { k: 'Space', a: 'Plant and jump. Hold to load.' },
        { k: 'Left mouse', a: 'Hold to wind up, release to spike. Longer is harder; a tap is a tip.' },
        { k: 'Q', a: 'Serve toss' },
      ],
    },
    {
      title: 'Defend and set',
      rows: [
        { k: 'E', a: 'Pass / dig' },
        { k: 'Right mouse', a: 'Block at the net, set off it' },
      ],
    },
    {
      title: 'Game',
      rows: [
        { k: 'V', a: 'First / third person' },
        { k: 'R', a: 'Replay the last good touch' },
        { k: 'N', a: 'Reset the rep' },
        { k: 'Esc', a: 'Pause' },
        { k: 'F3', a: 'Debug overlay' },
      ],
    },
    {
      title: 'In a drill',
      rows: [
        { k: '1  2  3', a: 'Call your set (Spike Drill, Mini Rally; hitters)' },
        { k: 'B', a: 'Opposing block: off, single, double (Spike Drill)' },
        { k: '1 to 5', a: 'Feed type (Free Play)' },
        { k: 'F   T', a: 'Feed a ball, auto feed (Free Play)' },
      ],
    },
  ],
  touch: [
    {
      title: 'Move',
      rows: [
        { k: 'Left thumb', a: 'Joystick. Push it out to the ring to run the approach.' },
        { k: 'Right thumb', a: 'Drag anywhere to aim' },
      ],
    },
    {
      title: 'Attack and serve',
      rows: [
        { k: 'JUMP', a: 'Hold to load, release to take off' },
        { k: 'HIT', a: 'Hold to wind up (longer is harder), release to swing. A tap is a tip. In the air the whole right half is HIT.' },
      ],
    },
    {
      title: 'Defend and set',
      rows: [
        { k: 'PASS', a: 'Hold' },
        { k: 'BLOCK', a: 'Hold: hands up and jump. It sets when the ball drops onto you.' },
      ],
    },
    {
      title: 'Game',
      rows: [
        { k: 'Top right', a: 'Pause, camera, reset the rep, and REPLAY when there is one' },
        { k: 'TOSS', a: 'Serve toss (Free Play)' },
      ],
    },
    {
      title: 'In a drill',
      rows: [
        { k: 'SET CALL', a: 'Top left: call your set (Spike Drill, Mini Rally; hitters)' },
        { k: 'VS BLOCK', a: 'Top left: opposing block (Spike Drill)' },
        { k: 'FEED  AUTO', a: 'Top left: feed types, feed a ball, auto feed (Free Play)' },
      ],
    },
  ],
};
