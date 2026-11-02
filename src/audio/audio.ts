import { AUDIO } from '../config';

/**
 * Everything you hear is synthesised with the Web Audio API (no samples):
 * contacts, floor, net, antenna, sneaker squeaks, footsteps, whistle and a
 * crowd bed with cheers. A generated impulse response gives the arena reverb.
 * `rate` < 1 pitches everything down (slow-motion replay).
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private crowdBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private pink!: AudioBuffer;
  private crowdBed: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private volume = AUDIO.master;
  private lastSqueak = 0;
  private lastStep = 0;
  muted = false;

  /** must be called from a user gesture */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp).connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = AUDIO.sfx;
      this.sfx.connect(this.master);
      this.crowdBus = ctx.createGain();
      this.crowdBus.gain.value = AUDIO.crowd;
      this.crowdBus.connect(this.master);
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(2.2, 2.8);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.32;
      this.reverbSend.connect(this.reverb).connect(this.master);
      this.noise = this.makeNoise(2, false);
      this.pink = this.makeNoise(4, true);
      this.startCrowd();
    } catch {
      this.ctx = null;
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
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
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
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // early reflections then a diffuse tail
        const er = i < ctx.sampleRate * 0.06 && Math.random() < 0.004 ? 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + er) * 0.5;
      }
    }
    return buf;
  }

  // ------------------------------------------------------------ primitives
  private noiseBurst(t: number, dur: number, f: number, q: number, gain: number, type: BiquadFilterType = 'bandpass', rev = 0.3, dest?: AudioNode): void {
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
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g);
    g.connect(dest ?? this.sfx);
    if (rev > 0) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.reverbSend);
    }
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(t: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType = 'sine', rev = 0.2, attack = 0.002): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    if (rev > 0) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.reverbSend);
    }
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private get ok(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // ------------------------------------------------------------ sounds
  /** spike / serve: thwack. power 0..1, perfect adds sub boom + crack */
  spike(power: number, perfect: boolean, rate = 1, pan = 0): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    void pan;
    this.noiseBurst(t, 0.06 / rate, 2400 * rate, 0.9, 0.9 * (0.5 + power * 0.5), 'bandpass', 0.35);
    this.noiseBurst(t, 0.03 / rate, 5200 * rate, 0.7, 0.4 * power, 'highpass', 0.1);
    this.tone(t, 180 * rate, 70 * rate, 0.11 / rate, 0.75 * (0.4 + power * 0.6), 'sine', 0.25);
    if (perfect) {
      this.tone(t, 90 * rate, 38 * rate, 0.4 / rate, 0.9, 'sine', 0.5);
      this.noiseBurst(t, 0.018 / rate, 7000 * rate, 0.6, 0.6, 'highpass', 0.2);
      this.tone(t + 0.005, 1400 * rate, 1200 * rate, 0.25 / rate, 0.06, 'triangle', 0.6);
    }
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
    this.noiseBurst(t, 0.07 / rate, 1700 * rate, 0.8, 0.9, 'bandpass', 0.4);
    this.tone(t, 160 * rate, 60 * rate, 0.16 / rate, 0.8, 'sine', 0.3);
    if (stuff) this.tone(t, 70 * rate, 35 * rate, 0.45 / rate, 0.9, 'sine', 0.6);
  }

  floor(impact: number, heavy: boolean, rate = 1): void {
    if (!this.ok) return;
    const t = this.ctx!.currentTime;
    const k = Math.min(1, impact / 18);
    this.noiseBurst(t, (0.06 + k * 0.05) / rate, 500 * rate, 0.7, 0.25 + k * 0.6, 'lowpass', 0.45);
    this.tone(t, (110 + k * 40) * rate, 55 * rate, (0.08 + k * 0.1) / rate, 0.2 + k * 0.6, 'sine', 0.4);
    if (heavy) {
      this.tone(t, 60 * rate, 28 * rate, 0.7 / rate, 1.0, 'sine', 0.8);
      this.noiseBurst(t, 0.35 / rate, 180 * rate, 0.5, 0.6, 'lowpass', 0.8);
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
    filter.frequency.value = 900;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    // slow murmur modulation
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lg = ctx.createGain();
    lg.gain.value = 0.04;
    lfo.connect(lg).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.crowdBus);
    src.start();
    lfo.start();
    this.crowdBed = { gain, filter };
  }

  /** crowd bed level follows the tension of the moment (0..1) */
  setCrowdTension(x: number): void {
    if (!this.ok || !this.crowdBed) return;
    const t = this.ctx!.currentTime;
    this.crowdBed.gain.gain.setTargetAtTime(0.14 + x * 0.16, t, 0.4);
    this.crowdBed.filter.frequency.setTargetAtTime(800 + x * 500, t, 0.4);
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
    f1.frequency.value = cheer ? 1100 : 500;
    f1.Q.value = 0.9;
    // vowel-ish formant wobble makes it read as voices
    const lfo = ctx.createOscillator();
    lfo.frequency.value = cheer ? 5.5 : 3;
    const lg = ctx.createGain();
    lg.gain.value = cheer ? 300 : 120;
    lfo.connect(lg).connect(f1.frequency);
    const g = ctx.createGain();
    const peak = Math.min(0.9, 0.25 + amount * 0.55);
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
      for (let i = 0; i < 14; i++) this.noiseBurst(t + 0.1 + Math.random() * dur * 0.7, 0.02, 1800 + Math.random() * 1200, 1.5, 0.05 + Math.random() * 0.05, 'bandpass', 0.5, this.crowdBus);
    }
  }
}
