// src/audio/Sfx.js
//
// One-shot sound effects for "Practical Range", fully synthesized with the
// Web Audio API (no asset files). Every method:
//   * no-ops when the AudioEngine is not ready (before unlock / while locked),
//   * routes its output through audioEngine.master,
//   * builds short-lived nodes that disconnect themselves when they finish, so
//     the methods are cheap enough to fire many times per second (rapid fire).
//
// A single reusable white-noise buffer backs all the noise-based effects to
// avoid re-allocating buffers on every shot.

export class Sfx {
  /** @param {import('./AudioEngine.js').AudioEngine} audioEngine */
  constructor(audioEngine) {
    this.engine = audioEngine;
    /** @type {AudioBuffer|null} cached 1s white-noise buffer */
    this._noiseBuffer = null;
  }

  // ---------------------------------------------------------------------------
  // Small node helpers
  // ---------------------------------------------------------------------------

  /** @returns {AudioContext} the live context (only call when ready). */
  get _ctx() {
    return this.engine.ctx;
  }

  /** @returns {GainNode} the shared master bus (only call when ready). */
  get _out() {
    return this.engine.master;
  }

  /** Lazily build (and cache) a 1-second mono white-noise buffer. */
  _noise() {
    const ctx = this._ctx;
    if (this._noiseBuffer && this._noiseBuffer.sampleRate === ctx.sampleRate) {
      return this._noiseBuffer;
    }
    const len = Math.floor(ctx.sampleRate); // 1 second
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;
    return buf;
  }

  /**
   * Create a noise source node reading from the cached buffer at a random
   * offset (so repeated hits sound slightly different).
   * @returns {AudioBufferSourceNode}
   */
  _noiseSource() {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    // Randomized playback rate + loop gives variety without extra buffers.
    src.loop = true;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    return src;
  }

  /** Create an oscillator. @returns {OscillatorNode} */
  _osc(type, freq) {
    const o = this._ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /** Create a gain node with an initial value. @returns {GainNode} */
  _gain(v = 0) {
    const g = this._ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /**
   * Create a biquad filter.
   * @returns {BiquadFilterNode}
   */
  _filter(type, freq, q = 1) {
    const f = this._ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /**
   * Schedule a percussive gain envelope: fast attack to `peak`, exponential
   * decay to ~0 by `now + dur`. Returns the stop time so callers can end nodes.
   * @param {GainNode} g
   * @param {number} now
   * @param {number} peak
   * @param {number} dur seconds
   * @param {number} attack seconds
   * @returns {number} stop time
   */
  _env(g, now, peak, dur, attack = 0.002) {
    const p = g.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(0.0001, now);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0001), now + attack);
    // exponentialRamp can't reach 0; ramp toward a tiny floor then hard-stop.
    p.exponentialRampToValueAtTime(0.0001, now + dur);
    return now + dur;
  }

  /**
   * Wire a graph, start its sources at `now`, and tear everything down at
   * `stop` so no nodes leak. Accepts any number of source nodes.
   * @param {number} now
   * @param {number} stop
   * @param {Array<AudioScheduledSourceNode>} sources
   * @param {Array<AudioNode>} allNodes nodes to disconnect on cleanup
   */
  _fireAndForget(now, stop, sources, allNodes) {
    for (const s of sources) {
      s.start(now);
      s.stop(stop + 0.02);
    }
    // Disconnect on the last source's onended to release the graph.
    const last = sources[sources.length - 1];
    last.onended = () => {
      for (const n of allNodes) {
        try { n.disconnect(); } catch (_) { /* already gone */ }
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Weapon / impact effects
  // ---------------------------------------------------------------------------

  /**
   * Sharp filtered-noise crack layered over a short low body thump. Fast decay.
   * The workhorse effect; kept lean for full-auto-ish rates of fire.
   */
  gunshot() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // --- Crack: bandpass-swept white noise, very short. ---
    const noise = this._noiseSource();
    const hp = this._filter('highpass', 1200, 0.7);
    const bp = this._filter('bandpass', 2600, 0.8);
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + 0.08);
    const nGain = this._gain();
    noise.connect(hp).connect(bp).connect(nGain).connect(this._out);
    const nStop = this._env(nGain, now, 0.9, 0.09);

    // --- Body: fast pitch-dropping sine thump for weight. ---
    const body = this._osc('sine', 160);
    body.frequency.setValueAtTime(180, now);
    body.frequency.exponentialRampToValueAtTime(60, now + 0.06);
    const bGain = this._gain();
    body.connect(bGain).connect(this._out);
    const bStop = this._env(bGain, now, 0.6, 0.11);

    const stop = Math.max(nStop, bStop);
    this._fireAndForget(now, stop, [noise, body], [hp, bp, nGain, bGain]);
  }

  /** Enemy fire: deeper/duller than the player's shot so it reads distinct. */
  enemyShot() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const noise = this._noiseSource();
    const lp = this._filter('lowpass', 1800, 0.7); // duller top end
    const bp = this._filter('bandpass', 1400, 0.7);
    bp.frequency.setValueAtTime(1800, now);
    bp.frequency.exponentialRampToValueAtTime(700, now + 0.1);
    const nGain = this._gain();
    noise.connect(lp).connect(bp).connect(nGain).connect(this._out);
    const nStop = this._env(nGain, now, 0.8, 0.12);

    const body = this._osc('sine', 120);
    body.frequency.setValueAtTime(130, now);
    body.frequency.exponentialRampToValueAtTime(45, now + 0.08);
    const bGain = this._gain();
    body.connect(bGain).connect(this._out);
    const bStop = this._env(bGain, now, 0.7, 0.14);

    const stop = Math.max(nStop, bStop);
    this._fireAndForget(now, stop, [noise, body], [lp, bp, nGain, bGain]);
  }

  /** Hollow mechanical click for an empty chamber (dry fire). */
  dryFire() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const noise = this._noiseSource();
    const bp = this._filter('bandpass', 2200, 4); // narrow -> "click" tone
    const g = this._gain();
    noise.connect(bp).connect(g).connect(this._out);
    const stop = this._env(g, now, 0.35, 0.03);
    this._fireAndForget(now, stop, [noise], [bp, g]);
  }

  /** Mag-out click, then a mag-in / slide clack ~250ms later. */
  reload() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // Two short clacks at different frequencies/times.
    const click = (t, freq, q, peak, dur) => {
      const noise = this._noiseSource();
      const bp = this._filter('bandpass', freq, q);
      const g = this._gain();
      noise.connect(bp).connect(g).connect(this._out);
      const stop = this._env(g, t, peak, dur);
      noise.start(t);
      noise.stop(stop + 0.02);
      noise.onended = () => {
        try { bp.disconnect(); } catch (_) {}
        try { g.disconnect(); } catch (_) {}
      };
    };

    click(now, 1800, 3, 0.4, 0.04);          // mag out
    click(now + 0.25, 1300, 2.5, 0.55, 0.06); // mag in / slide clack
  }

  /** Soft cardboard "thwack" — short mid-band filtered noise. */
  paperHit() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const noise = this._noiseSource();
    const bp = this._filter('bandpass', 900, 1.2);
    const lp = this._filter('lowpass', 2500, 0.7);
    const g = this._gain();
    noise.connect(bp).connect(lp).connect(g).connect(this._out);
    const stop = this._env(g, now, 0.45, 0.06);
    this._fireAndForget(now, stop, [noise], [bp, lp, g]);
  }

  /** Bright metallic DING — a few detuned partials ringing out. */
  steelHit() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // Inharmonic partials give a metallic (bell-like) timbre.
    const partials = [
      { f: 1400, g: 0.5, d: 0.55 },
      { f: 2090, g: 0.35, d: 0.45 },
      { f: 3170, g: 0.22, d: 0.35 },
    ];
    const nodes = [];
    const sources = [];
    for (const p of partials) {
      // Slight random detune per hit for liveliness.
      const o = this._osc('sine', p.f * (0.995 + Math.random() * 0.01));
      const g = this._gain();
      o.connect(g).connect(this._out);
      // Bright attack, long-ish exponential ring.
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(p.g, now + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, now + p.d);
      sources.push(o);
      nodes.push(g);
    }
    const stop = now + 0.6;
    this._fireAndForget(now, stop, sources, nodes);
  }

  /** Heavier clang plus a metallic rattle for a falling steel popper. */
  steelFall() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // Lower, heavier clang (bell partials shifted down).
    const partials = [
      { f: 520, g: 0.55, d: 0.8 },
      { f: 780, g: 0.4, d: 0.6 },
      { f: 1230, g: 0.28, d: 0.5 },
    ];
    const nodes = [];
    const sources = [];
    for (const p of partials) {
      const o = this._osc('sine', p.f * (0.99 + Math.random() * 0.02));
      const g = this._gain();
      o.connect(g).connect(this._out);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(p.g, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + p.d);
      sources.push(o);
      nodes.push(g);
    }

    // Rattle: a couple of short delayed noise bursts (steel bouncing).
    for (let i = 0; i < 3; i++) {
      const t = now + 0.12 + i * 0.09 + Math.random() * 0.03;
      const noise = this._noiseSource();
      const bp = this._filter('bandpass', 2000 + Math.random() * 1500, 5);
      const g = this._gain();
      noise.connect(bp).connect(g).connect(this._out);
      const st = this._env(g, t, 0.18, 0.05);
      noise.start(t);
      noise.stop(st + 0.02);
      noise.onended = () => {
        try { bp.disconnect(); } catch (_) {}
        try { g.disconnect(); } catch (_) {}
      };
    }

    const stop = now + 0.9;
    this._fireAndForget(now, stop, sources, nodes);
  }

  // ---------------------------------------------------------------------------
  // Player / enemy state feedback
  // ---------------------------------------------------------------------------

  /** Low painful thud when the player takes damage. */
  playerHurt() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const o = this._osc('sine', 110);
    o.frequency.setValueAtTime(140, now);
    o.frequency.exponentialRampToValueAtTime(55, now + 0.25);
    const dist = this._filter('lowpass', 500, 1);
    const g = this._gain();
    o.connect(dist).connect(g).connect(this._out);
    const stop = this._env(g, now, 0.8, 0.35, 0.005);
    this._fireAndForget(now, stop, [o], [dist, g]);
  }

  /** Short descending three-note defeat sting when an enemy goes down. */
  enemyDown() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const notes = [
      { f: 440, t: 0.0 },
      { f: 349.23, t: 0.09 },
      { f: 220, t: 0.18 },
    ];
    const nodes = [];
    const sources = [];
    for (const n of notes) {
      const o = this._osc('sawtooth', n.f);
      const lp = this._filter('lowpass', 1600, 0.7);
      const g = this._gain();
      o.connect(lp).connect(g).connect(this._out);
      const t = now + n.t;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      sources.push(o);
      nodes.push(lp, g);
      o.start(t);
      o.stop(t + 0.16);
    }
    // Cleanup after the last note.
    sources[sources.length - 1].onended = () => {
      for (const n of nodes) { try { n.disconnect(); } catch (_) {} }
    };
  }

  // ---------------------------------------------------------------------------
  // Timer / stage tones
  // ---------------------------------------------------------------------------

  /** Loud ~400ms ~2.4kHz sine — the classic USPSA start beep. */
  startBeep() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const o = this._osc('sine', 2400);
    const g = this._gain();
    o.connect(g).connect(this._out);
    // Flat-topped envelope: quick on, sustain, quick off (no click).
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.9, now + 0.008);
    g.gain.setValueAtTime(0.9, now + 0.38);
    g.gain.linearRampToValueAtTime(0.0001, now + 0.4);
    this._fireAndForget(now, now + 0.4, [o], [g]);
  }

  /** Short, softer ~1kHz tick for a countdown prep beep. */
  countBeep() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const o = this._osc('sine', 1000);
    const g = this._gain();
    o.connect(g).connect(this._out);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.35, now + 0.006);
    g.gain.setValueAtTime(0.35, now + 0.08);
    g.gain.linearRampToValueAtTime(0.0001, now + 0.1);
    this._fireAndForget(now, now + 0.1, [o], [g]);
  }

  /** Upbeat ascending 3-note arpeggio for stage completion. */
  stageComplete() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // Major-ish triad going up: C5, E5, G5.
    const notes = [523.25, 659.25, 783.99];
    const nodes = [];
    const sources = [];
    notes.forEach((f, i) => {
      const o = this._osc('triangle', f);
      const g = this._gain();
      o.connect(g).connect(this._out);
      const t = now + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.start(t);
      o.stop(t + 0.27);
      sources.push(o);
      nodes.push(g);
    });
    sources[sources.length - 1].onended = () => {
      for (const n of nodes) { try { n.disconnect(); } catch (_) {} }
    };
  }

  /** Somber descending 2-note sting for stage failure. */
  stageFail() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    // A4 down to D#4 — a flat, deflated fall.
    const notes = [
      { f: 440, t: 0.0, d: 0.3 },
      { f: 311.13, t: 0.22, d: 0.5 },
    ];
    const nodes = [];
    const sources = [];
    for (const n of notes) {
      const o = this._osc('sawtooth', n.f);
      const lp = this._filter('lowpass', 1200, 0.7);
      const g = this._gain();
      o.connect(lp).connect(g).connect(this._out);
      const t = now + n.t;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.d);
      o.start(t);
      o.stop(t + n.d + 0.02);
      sources.push(o);
      nodes.push(lp, g);
    }
    sources[sources.length - 1].onended = () => {
      for (const n of nodes) { try { n.disconnect(); } catch (_) {} }
    };
  }

  /** Subtle short UI blip for menu interactions. */
  uiClick() {
    if (!this.engine.ready) return;
    const ctx = this._ctx, now = ctx.currentTime;

    const o = this._osc('square', 660);
    const g = this._gain();
    o.connect(g).connect(this._out);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    this._fireAndForget(now, now + 0.06, [o], [g]);
  }
}
