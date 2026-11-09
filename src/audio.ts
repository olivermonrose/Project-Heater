import { AircraftState } from './sim/aircraft';

// Lightweight synthesized engine and wind sound. No audio files needed.
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private abGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private rwrOsc!: OscillatorNode;
  private rwrGain!: GainNode;
  private beepUntil = 0;
  muted = false;

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const mkNoise = () => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start();
      return src;
    };
    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    this.master = master;
    this.noise = noise;
    this.rwrOsc = ctx.createOscillator();
    this.rwrOsc.type = 'square';
    this.rwrGain = ctx.createGain();
    this.rwrGain.gain.value = 0;
    const rwrFilter = ctx.createBiquadFilter();
    rwrFilter.type = 'lowpass';
    rwrFilter.frequency.value = 2500;
    this.rwrOsc.connect(rwrFilter).connect(this.rwrGain).connect(master);
    this.rwrOsc.start();

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineGain = ctx.createGain();
    mkNoise().connect(this.engineFilter).connect(this.engineGain).connect(master);

    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whineGain = ctx.createGain();
    this.whine.connect(this.whineGain).connect(master);
    this.whine.start();

    const abFilter = ctx.createBiquadFilter();
    abFilter.type = 'lowpass';
    abFilter.frequency.value = 180;
    this.abGain = ctx.createGain();
    this.abGain.gain.value = 0;
    mkNoise().connect(abFilter).connect(this.abGain).connect(master);

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    mkNoise().connect(this.windFilter).connect(this.windGain).connect(master);
  }

  suspend() {
    this.ctx?.suspend();
  }

  update(s: AircraftState) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = s.engineRunning && !this.muted && !s.destroyed;
    const rpm = s.rpm;
    this.engineGain.gain.setTargetAtTime(on ? 0.15 + rpm * 0.35 : 0, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(200 + rpm * 900, t, 0.1);
    this.whine.frequency.setTargetAtTime(500 + rpm * 1700, t, 0.1);
    this.whineGain.gain.setTargetAtTime(on ? 0.012 + rpm * 0.012 : 0, t, 0.1);
    this.abGain.gain.setTargetAtTime(on ? s.afterburner * 0.9 : 0, t, 0.15);
    const v = s.vel.length();
    this.windFilter.frequency.setTargetAtTime(300 + v * 6, t, 0.2);
    this.windGain.gain.setTargetAtTime(this.muted || s.destroyed ? 0 : Math.min(0.5, v / 500), t, 0.2);
  }

  /**
   * Radar warning tones. Launch / missile warning: fast warble. Lock: pulsing
   * tone. A new radar looking at you: a short double beep.
   */
  warning(state: 'none' | 'search' | 'track' | 'launch', newContact: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (newContact) this.beepUntil = t + 0.32;
    let gain = 0;
    let freq = 1000;
    if (state === 'launch') {
      freq = Math.floor(t * 9) % 2 === 0 ? 1450 : 950;
      gain = 0.05;
    } else if (state === 'track') {
      freq = 1150;
      gain = (t * 4) % 1 < 0.55 ? 0.04 : 0;
    } else if (t < this.beepUntil) {
      freq = 800;
      gain = (this.beepUntil - t) % 0.16 > 0.07 ? 0.04 : 0;
    }
    if (this.muted) gain = 0;
    this.rwrOsc.frequency.setTargetAtTime(freq, t, 0.004);
    this.rwrGain.gain.setTargetAtTime(gain, t, 0.006);
  }

  /** Short burst of filtered noise: hits, explosions, dispenser pops. */
  thump(volume: number, freq: number, seconds: number) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + seconds + 0.05);
  }
}
