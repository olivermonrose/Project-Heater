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
}
