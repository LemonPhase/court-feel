import { AUDIO } from '../config';

/**
 * Called words (AudioEngine.shout): pitch contour f0 (start, peak, end Hz), formant
 * centres (Hz) of the vowel it starts on and the one it ends on, voiced length and a
 * breathy "h" lead-in (s).
 */
const SHOUTS = {
  high: { f0: [215, 250, 170], from: [780, 1180, 2550], to: [320, 2250, 2950], dur: 0.34, breath: 0.06, gain: 0.4 },
  go: { f0: [200, 215, 165], from: [500, 900, 2450], to: [360, 760, 2350], dur: 0.2, breath: 0, gain: 0.24 },
  help: { f0: [210, 235, 175], from: [580, 1750, 2500], to: [400, 1000, 2400], dur: 0.28, breath: 0.05, gain: 0.34 },
} as const;
/** formant sharpness and level (F1 carries the vowel's weight, F2/F3 make it intelligible) */
const FORMANT_Q = [5, 8, 11];
const FORMANT_GAIN = [2.2, 1.6, 0.9];

/**
 * Everything you hear is synthesised with the Web Audio API (no samples):
 * contacts, floor, net, antenna, sneaker squeaks, footsteps, whistle and a
 * crowd bed with cheers. A generated impulse response gives the arena reverb.
 * `rate` < 1 pitches everything down (slow-motion replay).
 */
export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  /** rendering into an OfflineAudioContext (tests): skip the running check */
  private offline = false;
  private master!: GainNode;
  private sfx!: GainNode;
  private crowdBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  /** low booms go through a gentle saturator: harmonics make them read on small speakers */
  private boomBus!: GainNode;
  /** early reflections (slap-back) for the big hits */
  private echoSend!: GainNode;
  private noise!: AudioBuffer;
  private pink!: AudioBuffer;
  private crowdBed: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private volume = AUDIO.master;
  private lastSqueak = 0;
  private lastStep = 0;
  muted = false;

  /** audio could not be set up: play silently instead of retrying on every key press */
  private unavailable = false;
  /** suspended because the tab was hidden (resumed when it is visible again) */
  private hiddenSuspended = false;

  /** must be called from a user gesture */
  unlock(): void {
    if (this.unavailable) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && 'resume' in this.ctx && !this.hiddenSuspended)
        (this.ctx as AudioContext).resume().catch(() => {});
      return;
    }
    let ctx: AudioContext | null = null;
    try {
      const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        this.unavailable = true;
        return;
      }
      ctx = new Ctx();
      this.attach(ctx);
    } catch {
      this.ctx = null;
      this.unavailable = true;
      ctx?.close().catch(() => {});
    }
  }

  /** a hidden tab stops the audio thread (the crowd bed loops forever); it resumes when the tab is visible again */
  setHidden(hidden: boolean): void {
    const ctx = this.ctx;
    if (!ctx || this.offline || !('suspend' in ctx)) return;
    const live = ctx as AudioContext;
    if (hidden && live.state === 'running') {
      this.hiddenSuspended = true;
      live.suspend().catch(() => {});
    } else if (!hidden && this.hiddenSuspended) {
      this.hiddenSuspended = false;
      live.resume().catch(() => {});
    }
  }

  /** build the graph on a context (live, or offline for measurements) */
  attach(ctx: BaseAudioContext, offline = false): void {
    {
      this.offline = offline;
      this.ctx = ctx;
      // Mix: contact sounds (+ their reverb) -> peak limiter -> master; the crowd joins after the
      // limiter so a loud hit never ducks the arena bed (no pumping), then a soft clip catches strays.
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const soft = ctx.createWaveShaper();
      const curve = new Float32Array(2048);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.abs(x) < 0.7 ? x : Math.sign(x) * (0.7 + 0.3 * Math.tanh((Math.abs(x) - 0.7) / 0.3));
      }
      soft.curve = curve;
      soft.oversample = '2x';
      this.master.connect(soft).connect(ctx.destination);
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.12;
      limiter.connect(this.master);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = AUDIO.sfx * 0.8;
      this.sfx.connect(limiter);
      this.crowdBus = ctx.createGain();
      this.crowdBus.gain.value = AUDIO.crowd;
      this.crowdBus.connect(this.master);
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(2.0, 3.0);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.3;
      this.reverbSend.connect(this.reverb).connect(limiter);
      // Low end of the big hits: a smooth tanh saturator (the curve spans the bus's whole input range,
      // so nothing hard-clips) adds harmonics that laptop speakers can play; a lowpass after it keeps
      // the harmonics warm instead of buzzy.
      this.boomBus = ctx.createGain();
      this.boomBus.gain.value = 0.85;
      const sat = ctx.createWaveShaper();
      const sc = new Float32Array(2048);
      for (let i = 0; i < sc.length; i++) {
        const x = (i / (sc.length - 1)) * 2 - 1;
        sc[i] = Math.tanh(x * 3.4) / Math.tanh(3.4);
      }
      sat.curve = sc;
      sat.oversample = '4x';
      const warm = ctx.createBiquadFilter();
      warm.type = 'lowpass';
      warm.frequency.value = 1100;
      warm.Q.value = 0.5;
      const boomOut = ctx.createGain();
      boomOut.gain.value = 0.7;
      this.boomBus.connect(sat).connect(warm).connect(boomOut).connect(this.sfx);
      // Arena slap-back: a few darkening early reflections off the stands and the far wall, spread
      // left/right. Only hard hits send into it.
      this.echoSend = ctx.createGain();
      for (const [delay, cutoff, gain, pan] of [
        [0.083, 2600, 0.46, -0.55],
        [0.151, 1700, 0.32, 0.6],
        [0.236, 1000, 0.2, -0.2],
      ]) {
        const d = ctx.createDelay(0.5);
        d.delayTime.value = delay;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cutoff;
        lp.Q.value = 0.4;
        const g = ctx.createGain();
        g.gain.value = gain;
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        this.echoSend.connect(d).connect(lp).connect(g).connect(p).connect(this.sfx);
      }
      this.noise = this.makeNoise(2, false);
      this.pink = this.makeNoise(4, true);
      this.startCrowd();
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  private makeNoise(sec: number, pink: boolean): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (!pink) {
        d[i] = w;
        continue;
      }
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  private makeImpulse(sec: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * sec);
    const pre = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i < pre) {
          d[i] = 0;
          continue;
        }
        const t = (i - pre) / (len - pre);
        // one-pole lowpass that closes as the tail decays: big-room air, no metallic ticks
        const k = 0.55 - 0.4 * t;
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.pow(1 - t, decay) * 0.6;
      }
    }
    return buf;
  }

  // ------------------------------------------------------------ primitives
  /** `echo` > 0 also feeds the arena slap-back */
  private noiseBurst(
    t: number,
    dur: number,
    f: number,
    q: number,
    gain: number,
    type: BiquadFilterType = 'bandpass',
    rev = 0.3,
    dest?: AudioNode,
    echo = 0,
    attack = 0.002,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g);
    this.route(g, dest, rev, echo);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(
    t: number,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
    type: OscillatorType = 'sine',
    rev = 0.2,
    attack = 0.002,
    dest?: AudioNode,
    echo = 0,
  ): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.route(g, dest, rev, echo);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** noise through a band that glides from f0 to f1 (a ball ripping away, a whoosh) */
  private sweep(t: number, dur: number, f0: number, f1: number, q: number, gain: number, rev = 0.2, attack = 0.01): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g);
    this.route(g, undefined, rev, 0);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private route(g: GainNode, dest: AudioNode | undefined, rev: number, echo: number): void {
    const ctx = this.ctx!;
    g.connect(dest ?? this.sfx);
    if (rev > 0) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.reverbSend);
    }
    if (echo > 0) {
      const s = ctx.createGain();
      s.gain.value = echo;
      g.connect(s).connect(this.echoSend);
    }
  }

  private get ok(): boolean {
    return !!this.ctx && (this.offline || this.ctx.state === 'running');
  }

  // ------------------------------------------------------------ sounds
  /**
   * Spike / serve contact. `power` 0..1 follows the ball speed and everything
   * scales with it continuously: a soft swing is a hand slap and a thump; a
   * hard one adds a sharp leather crack, a mid "pop" that small speakers can
   * play, a deep pitch-dropping boom, the ball ripping away and an arena
   * slap-back. Layers are staggered by a few ms so their peaks do not stack.
   * `near` 0..1 is how close it is to the camera.
   */
  spike(power: number, perfect: boolean, rate = 1, near = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    const p = Math.max(0, Math.min(1, power));
    const v = 0.5 + 0.5 * Math.max(0, Math.min(1, near));
    const boom = p <= 0.25 ? 0 : Math.pow((p - 0.25) / 0.75, 1.25);
    // transient: the leather snapping under the hand, very short and bright
    this.noiseBurst(
      t,
      (0.005 + 0.008 * p) / rate,
      3600 * rate,
      0.7,
      (0.14 + 0.56 * p * p) * v,
      'highpass',
      0.12 + 0.25 * p,
      undefined,
      0.5 * boom,
      0.0008,
    );
    // hand on the ball: brighter and fuller the harder it is
    this.noiseBurst(
      t,
      (0.045 + 0.04 * p) / rate,
      (1700 + 900 * p) * rate,
      0.85,
      (0.5 + 0.42 * p) * v,
      'bandpass',
      0.22 + 0.7 * p,
      undefined,
      0.7 * boom,
    );
    // leather "pop": a fast-dropping mid punch, the part of the boom laptop speakers can play
    this.tone(
      t + 0.002,
      (340 - 70 * p) * rate,
      (150 - 30 * p) * rate,
      (0.045 + 0.08 * p) / rate,
      (0.22 + 0.6 * p) * v,
      'triangle',
      0.2 + 0.35 * p,
      0.0015,
      this.boomBus,
    );
    // ball body thump, dropping lower with power
    this.tone(t, (220 - 50 * p) * rate, 72 * rate, (0.09 + 0.07 * p) / rate, (0.45 + 0.2 * p) * v, 'sine', 0.18 + 0.25 * p);
    if (boom > 0) {
      // the boom: a deep pitch drop that hangs in the room (a few ms late so it does not stack on the crack)
      this.tone(
        t + 0.006,
        120 * rate,
        33 * rate,
        (0.26 + 0.5 * boom) / rate,
        0.95 * boom * v,
        'sine',
        0.4 + 1.0 * boom,
        0.004,
        this.boomBus,
      );
      // its upper body
      this.tone(
        t + 0.003,
        230 * rate,
        72 * rate,
        (0.16 + 0.22 * boom) / rate,
        0.42 * boom * v,
        'triangle',
        0.3 + 0.2 * boom,
        0.003,
        this.boomBus,
      );
      // the "whump": a band of low-mid air around the hit that gives it weight
      this.noiseBurst(
        t + 0.003,
        (0.08 + 0.14 * boom) / rate,
        240 * rate,
        0.9,
        0.55 * boom * v,
        'bandpass',
        1.1 * boom,
        undefined,
        0.4 * boom,
        0.004,
      );
      // air pushed out of the ball
      this.noiseBurst(t + 0.004, (0.07 + 0.12 * boom) / rate, 380 * rate, 0.7, 0.22 * boom * v, 'lowpass', 0.5 * boom);
      // the arena answers: a dark slap of the hit off the stands
      this.noiseBurst(t, (0.03 + 0.04 * boom) / rate, 1200 * rate, 0.6, 0.7 * boom * v, 'bandpass', 0, this.echoSend);
    }
    // a really fast ball rips away: a short falling whoosh after the contact
    if (p > 0.5) {
      const r = (p - 0.5) / 0.5;
      this.sweep(t + 0.012, (0.2 + 0.1 * r) / rate, 3400 * rate, 800 * rate, 1.4, 0.12 * r * v, 0.25, 0.012);
    }
    if (perfect) this.tone(t + 0.005, 1400 * rate, 1200 * rate, 0.25 / rate, 0.04, 'triangle', 0.6);
  }

  /** contact power 0..1 from the outgoing ball speed (m/s): a float serve ~0.3, a full spike 1 */
  static powerFromSpeed(speed: number): number {
    return Math.max(0, Math.min(1, (speed - 12) / (30 - 12)));
  }

  /** wind-up reached full power: a small bright tick */
  chargeFull(): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 1250, 1650, 0.07, 0.045, 'triangle', 0.15, 0.004);
  }

  /** arm swing whoosh on release, louder with power; a big swing also swells upward into the contact */
  swish(power: number): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.09, 900 + power * 700, 1.4, 0.05 + power * 0.07, 'bandpass', 0.1);
    if (power > 0.6) this.sweep(t, 0.085, 450, 1900, 1.2, (0.075 * (power - 0.6)) / 0.4, 0.1, 0.06);
  }

  tip(rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.04 / rate, 1500 * rate, 1.2, 0.35, 'bandpass', 0.25);
  }

  pass(power: number, rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.07 / rate, 700 * rate, 1.0, 0.5 * (0.6 + power * 0.4), 'bandpass', 0.3);
    this.tone(t, 150 * rate, 90 * rate, 0.09 / rate, 0.45 * (0.5 + power * 0.5), 'sine', 0.2);
  }

  set(rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.03, 1300 * rate, 1.4, 0.32, 'bandpass', 0.2);
    this.noiseBurst(t + 0.012, 0.03, 1100 * rate, 1.4, 0.25, 'bandpass', 0.2);
  }

  block(stuff: boolean, rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 0.07 / rate, 1700 * rate, 0.8, 0.6, 'bandpass', 0.4);
    this.tone(t, 160 * rate, 60 * rate, 0.16 / rate, 0.55, 'sine', 0.3);
    if (stuff) this.tone(t, 70 * rate, 35 * rate, 0.45 / rate, 0.6, 'sine', 0.6);
  }

  /**
   * Ball on the floor. `impact` (m/s into the floor) drives an ordinary bounce;
   * `slam` 0..1 is how hard an attack came down (from the spike speed) and
   * adds, continuously, the leather slap on hardwood, the floor's knock, a low
   * thud and a room boom with slap-back off the stands.
   */
  floor(impact: number, slam = 0, rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, impact / 18);
    const s = Math.max(0, Math.min(1, slam));
    if (s <= 0) {
      this.noiseBurst(t, (0.06 + k * 0.05) / rate, 500 * rate, 0.7, 0.25 + k * 0.6, 'lowpass', 0.45);
      this.tone(t, (110 + k * 40) * rate, 55 * rate, (0.08 + k * 0.1) / rate, 0.2 + k * 0.6, 'sine', 0.4);
      return;
    }
    // leather slapping the hardwood: the bright smack that carries across a gym
    this.noiseBurst(
      t,
      (0.028 + 0.04 * s) / rate,
      (1350 + 650 * s) * rate,
      0.9,
      0.32 + 0.62 * s,
      'bandpass',
      0.35 + 0.85 * s,
      undefined,
      0.8 * s,
    );
    this.noiseBurst(t, (0.004 + 0.007 * s) / rate, 3300 * rate, 0.7, 0.1 + 0.48 * s * s, 'highpass', 0.2, undefined, 0.3 * s, 0.0008);
    // the floor's knock: two short panel modes
    this.tone(t + 0.001, 250 * rate, 185 * rate, (0.05 + 0.09 * s) / rate, 0.2 + 0.45 * s, 'sine', 0.3, 0.0012, this.boomBus);
    this.tone(t + 0.001, 410 * rate, 340 * rate, (0.035 + 0.035 * s) / rate, 0.08 + 0.14 * s, 'sine', 0.25, 0.0012);
    // low thud of the ball's body
    this.tone(
      t + 0.003,
      (130 + 30 * s) * rate,
      50 * rate,
      (0.1 + 0.18 * s) / rate,
      0.38 + 0.55 * s,
      'sine',
      0.4 + 0.35 * s,
      0.003,
      this.boomBus,
    );
    // the whump of air under the ball
    this.noiseBurst(t + 0.002, (0.06 + 0.14 * s) / rate, 190 * rate, 0.9, 0.2 + 0.4 * s, 'bandpass', 1.1 * s, undefined, 0.4 * s, 0.003);
    if (s > 0.3) {
      // a room boom that hangs in the arena
      const b = Math.pow((s - 0.3) / 0.7, 1.2);
      this.tone(t + 0.009, 68 * rate, 28 * rate, (0.45 + 0.6 * b) / rate, 0.9 * b, 'sine', 0.8 + 0.8 * b, 0.006, this.boomBus);
      this.noiseBurst(t + 0.005, (0.22 + 0.35 * b) / rate, 210 * rate, 0.5, 0.38 * b, 'lowpass', 0.9 + 0.9 * b, undefined, 0.5 * b);
    }
  }

  net(impact: number): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, impact / 15);
    this.noiseBurst(t, 0.18 + k * 0.1, 3200, 0.6, 0.12 + k * 0.3, 'bandpass', 0.3);
    this.noiseBurst(t + 0.02, 0.2, 900, 0.8, 0.08 + k * 0.15, 'bandpass', 0.3);
  }

  antenna(): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 2400, 2300, 0.25, 0.12, 'triangle', 0.4);
    this.tone(t, 3700, 3600, 0.15, 0.06, 'sine', 0.3);
  }

  squeak(intensity: number): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    if (t - this.lastSqueak < 0.12) return;
    this.lastSqueak = t;
    const f = 2200 + Math.random() * 900;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * (1.15 + Math.random() * 0.2), t + 0.06);
    o.frequency.linearRampToValueAtTime(f * 0.95, t + 0.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 1.1;
    bp.Q.value = 8;
    const g = ctx.createGain();
    const v = 0.05 + intensity * 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(bp).connect(g).connect(this.sfx);
    const s = ctx.createGain();
    s.gain.value = 0.35;
    g.connect(s).connect(this.reverbSend);
    o.start(t);
    o.stop(t + 0.15);
  }

  step(speed: number, near: boolean): void {
    if (!this.ok || !near) return;
    const t = this.ctx!.currentTime;
    if (t - this.lastStep < 0.09) return;
    this.lastStep = t;
    this.noiseBurst(t, 0.035, 260 + speed * 30, 0.8, 0.05 + Math.min(0.08, speed * 0.015), 'lowpass', 0.2);
  }

  land(impact: number): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, impact / 4.5);
    this.noiseBurst(t, 0.06, 220, 0.7, 0.15 + k * 0.25, 'lowpass', 0.3);
    this.tone(t, 90, 50, 0.1, 0.15 + k * 0.25, 'sine', 0.2);
  }

  whistle(): void {
    if (!this.ok) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const f of [2950, 3080]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 26;
      const lg = ctx.createGain();
      lg.gain.value = 70;
      lfo.connect(lg).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      g.gain.setValueAtTime(0.09, t + 0.42);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(this.sfx);
      const s = ctx.createGain();
      s.gain.value = 0.5;
      g.connect(s).connect(this.reverbSend);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.55);
      lfo.stop(t + 0.55);
    }
  }

  /**
   * A shout across the gym: the setter calling the pass. A buzzy voice source through
   * three formant filters that glide from one vowel to the next, with a breathy onset.
   * 'high' is the warning (a loud "high!", the vowel sliding from "ah" to "ee"), 'go'
   * a short confirmation ("go!"), 'help' the setter giving the second ball away.
   * `near` 0..1 is how close the caller is to the camera.
   */
  shout(word: 'high' | 'go' | 'help', near = 0.7): void {
    if (!this.ok) return;
    const ctx = this.ctx!;
    const W = SHOUTS[word];
    const t = ctx.currentTime + 0.005;
    const v = W.gain * (0.55 + 0.45 * Math.max(0, Math.min(1, near)));
    const on = t + W.breath;
    const end = on + W.dur;
    // the voice: a sawtooth with a shout's pitch contour (up into the vowel, falling off it)
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(W.f0[0], on);
    src.frequency.linearRampToValueAtTime(W.f0[1], on + W.dur * 0.3);
    src.frequency.linearRampToValueAtTime(W.f0[2], end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, on);
    env.gain.exponentialRampToValueAtTime(1, on + 0.03);
    env.gain.setValueAtTime(1, on + W.dur * 0.65);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(env);
    const out = ctx.createGain();
    out.gain.value = v;
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = FORMANT_Q[i];
      bp.frequency.setValueAtTime(W.from[i], on);
      bp.frequency.setValueAtTime(W.from[i], on + W.dur * 0.25);
      bp.frequency.exponentialRampToValueAtTime(W.to[i], on + W.dur * 0.8);
      const g = ctx.createGain();
      g.gain.value = FORMANT_GAIN[i];
      env.connect(bp).connect(g).connect(out);
    }
    // a voice from across the court: plenty of room on it
    this.route(out, undefined, 0.55, 0);
    src.start(on);
    src.stop(end + 0.05);
    // the "h": breath through the first vowel's mouth shape, just before the voice
    if (W.breath > 0) this.noiseBurst(t, W.breath + 0.05, W.from[1], 1.4, 0.35 * v, 'bandpass', 0.4, undefined, 0, 0.02);
  }

  /** a soft chime when you nail a Perfect */
  perfectChime(): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    this.tone(t + 0.02, 1318, 1318, 0.5, 0.05, 'sine', 0.6, 0.01);
    this.tone(t + 0.07, 1976, 1976, 0.55, 0.04, 'sine', 0.6, 0.01);
  }

  // ------------------------------------------------------------ crowd
  private startCrowd(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 650;
    filter.Q.value = 0.8;
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 1500;
    warm.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    // slow murmur modulation
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lg = ctx.createGain();
    lg.gain.value = 0.04;
    lfo.connect(lg).connect(gain.gain);
    src.connect(filter).connect(warm).connect(gain).connect(this.crowdBus);
    src.start();
    lfo.start();
    this.crowdBed = { gain, filter };
  }

  /** crowd bed level follows the tension of the moment (0..1) */
  private lastTension = -1;
  setCrowdTension(x: number): void {
    if (!this.ok || !this.crowdBed) return;
    // only schedule when it actually moves (not one automation event per frame)
    if (Math.abs(x - this.lastTension) < 0.05) return;
    this.lastTension = x;
    const t = this.ctx!.currentTime;
    this.crowdBed.gain.gain.cancelScheduledValues(t);
    this.crowdBed.gain.gain.setTargetAtTime(0.13 + x * 0.12, t, 0.4);
    this.crowdBed.filter.frequency.cancelScheduledValues(t);
    this.crowdBed.filter.frequency.setTargetAtTime(600 + x * 250, t, 0.4);
  }

  /** crowd reaction: cheer (swell of voices) or groan */
  crowd(amount: number, cheer: boolean): void {
    if (!this.ok || amount <= 0.05) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 1.0 + amount * 1.4;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    src.playbackRate.value = cheer ? 1.1 : 0.8;
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = cheer ? 900 : 450;
    f1.Q.value = 0.9;
    // vowel-ish formant wobble makes it read as voices
    const lfo = ctx.createOscillator();
    lfo.frequency.value = cheer ? 5.5 : 3;
    const lg = ctx.createGain();
    lg.gain.value = cheer ? 300 : 120;
    lfo.connect(lg).connect(f1.frequency);
    const g = ctx.createGain();
    const peak = Math.min(0.6, 0.18 + amount * 0.38);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.18);
    g.gain.exponentialRampToValueAtTime(peak * 0.6, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f1).connect(g).connect(this.crowdBus);
    const s = ctx.createGain();
    s.gain.value = 0.4;
    g.connect(s).connect(this.reverbSend);
    src.start(t, Math.random() * 3);
    lfo.start(t);
    src.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
    if (cheer && amount > 0.7) {
      // claps
      for (let i = 0; i < 14; i++)
        this.noiseBurst(
          t + 0.1 + Math.random() * dur * 0.7,
          0.02,
          1800 + Math.random() * 1200,
          1.5,
          0.05 + Math.random() * 0.05,
          'bandpass',
          0.5,
          this.crowdBus,
        );
    }
  }
}
