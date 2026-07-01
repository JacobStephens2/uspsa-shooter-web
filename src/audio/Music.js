// src/audio/Music.js
//
// Procedural, looping background music for "Practical Range" — synthesized with
// the Web Audio API (no asset files).
//
// Two moods:
//   * playMenu()          — calm, moody western/range ambience: a low drone with
//                           sparse, reverb-ish guitar-like plucks.
//   * playStage(intensity)— a rhythmic bed whose energy scales with `intensity`
//                           (0 = steady/focused, 1 = driving percussion + urgency).
//
// Scheduling uses the standard Web Audio "lookahead" pattern (Chris Wilson's
// "A Tale of Two Clocks"): a setInterval timer wakes every ~25ms and schedules
// any notes whose time falls within the next ~100ms window using the sample-
// accurate AudioContext clock. This keeps loops rock-solid without blocking the
// main thread and without depending on requestAnimationFrame.
//
// All output flows through a private music sub-mix gain, which connects to the
// engine's master bus:
//
//     [notes] --> musicGain --> audioEngine.master --> destination

export class Music {
  /** @param {import('./AudioEngine.js').AudioEngine} audioEngine */
  constructor(audioEngine) {
    this.engine = audioEngine;

    // Scheduler configuration.
    this._lookahead = 0.1;      // seconds of audio scheduled ahead
    this._interval = 25;        // ms between scheduler ticks
    this._timer = null;         // setInterval handle (null when stopped)

    this._nextNoteTime = 0;     // ctx time for the next beat to schedule
    this._beat = 0;             // running beat counter (drives patterns)
    this._tempo = 100;          // BPM (set per mode)
    this._mode = null;          // 'menu' | 'stage' | null
    this._intensity = 0;        // 0..1, stage only

    this._volume = 0.6;         // remembered music sub-mix volume (0..1)
    /** @type {GainNode|null} private music bus */
    this._bus = null;

    // Track live source nodes so stop() can hard-cancel a lingering tail.
    /** @type {Set<AudioScheduledSourceNode>} */
    this._voices = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Start the calm menu ambience loop. Stops any current music first. */
  playMenu() {
    if (!this.engine.ready) return;
    this._start('menu', 84, 0);
  }

  /**
   * Start the rhythmic stage loop.
   * @param {number} intensity 0..1 — higher adds driving percussion & urgency.
   */
  playStage(intensity = 0.5) {
    if (!this.engine.ready) return;
    this._intensity = this._clamp01(intensity);
    // Tempo rises with intensity for a sense of urgency.
    const tempo = 96 + Math.round(this._intensity * 44); // 96..140 BPM
    this._start('stage', tempo, this._intensity);
  }

  /** Fade out and stop the current loop, clearing all timers. */
  stop() {
    // Kill the scheduler first so no new notes are queued.
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._mode = null;

    if (!this._bus || !this.engine.ctx) {
      // Nothing playing / no graph: just drop voice references.
      this._voices.clear();
      return;
    }

    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const fade = 0.6;

    // Fade the bus down smoothly.
    try {
      const g = this._bus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + fade);
    } catch (_) { /* ignore */ }

    // Snapshot then schedule teardown of the bus + any tails after the fade.
    const bus = this._bus;
    const voices = this._voices;
    this._bus = null;
    this._voices = new Set();

    window.setTimeout(() => {
      voices.forEach((v) => {
        try { v.stop(); } catch (_) {}
        try { v.disconnect(); } catch (_) {}
      });
      voices.clear();
      try { bus.disconnect(); } catch (_) {}
    }, Math.ceil(fade * 1000) + 60);
  }

  /**
   * Set the music sub-mix volume (independent of, and under, master volume).
   * Remembered so it applies to future loops too.
   * @param {number} v 0..1
   */
  setVolume(v) {
    this._volume = this._clamp01(v);
    if (this._bus && this.engine.ctx) {
      const now = this.engine.ctx.currentTime;
      const g = this._bus.gain;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(this._volume, now + 0.05);
      } catch (_) {
        g.value = this._volume;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduler core
  // ---------------------------------------------------------------------------

  /**
   * (Re)start a loop in the given mode. Stops the current loop, rebuilds the
   * music bus, and kicks off the lookahead scheduler.
   * @param {'menu'|'stage'} mode
   * @param {number} tempo BPM
   * @param {number} intensity 0..1
   */
  _start(mode, tempo, intensity) {
    // Stop current loop (and its timers) before starting the new one.
    this.stop();

    const ctx = this.engine.ctx;

    // Build a fresh bus so the previous fade-out tail can die independently.
    this._bus = ctx.createGain();
    this._bus.gain.value = 0.0001;
    this._bus.connect(this.engine.master);
    // Fade the new bus in to the remembered volume.
    const now = ctx.currentTime;
    this._bus.gain.setValueAtTime(0.0001, now);
    this._bus.gain.linearRampToValueAtTime(this._volume, now + 0.4);

    this._mode = mode;
    this._tempo = tempo;
    this._intensity = intensity;
    this._beat = 0;
    // Start slightly in the future so the first tick has room to schedule.
    this._nextNoteTime = now + 0.08;

    this._timer = window.setInterval(() => this._scheduler(), this._interval);
    // Immediate first pass so playback begins promptly.
    this._scheduler();
  }

  /** Scheduler tick: queue every beat that falls inside the lookahead window. */
  _scheduler() {
    // Defensive: if the engine went away, stop cleanly.
    if (!this.engine.ready || !this._bus) {
      this.stop();
      return;
    }
    const ctx = this.engine.ctx;
    while (this._nextNoteTime < ctx.currentTime + this._lookahead) {
      this._scheduleBeat(this._beat, this._nextNoteTime);
      this._advance();
    }
  }

  /** Advance the beat counter and next-note time by one sixteenth. */
  _advance() {
    // We schedule on a 16th-note grid for rhythmic detail.
    const secondsPerSixteenth = 60.0 / this._tempo / 4.0;
    this._nextNoteTime += secondsPerSixteenth;
    this._beat++;
  }

  /**
   * Dispatch the correct pattern for the current mode.
   * @param {number} beat sixteenth-note index (monotonic)
   * @param {number} time ctx time to sound at
   */
  _scheduleBeat(beat, time) {
    if (this._mode === 'menu') this._menuPattern(beat, time);
    else if (this._mode === 'stage') this._stagePattern(beat, time);
  }

  // ---------------------------------------------------------------------------
  // Patterns
  // ---------------------------------------------------------------------------

  /**
   * Calm western/range ambience: a sustained low drone (refreshed periodically)
   * plus sparse, echoing guitar-like plucks on a pentatonic scale.
   */
  _menuPattern(beat, time) {
    const bar = 16;          // sixteenths per "bar" here
    const inBar = beat % bar;

    // --- Drone: retrigger a long, soft pad at the top of every 2 bars. ---
    if (beat % (bar * 2) === 0) {
      this._drone(time, 55.0, 4.0);       // low A drone
      this._drone(time, 82.41, 4.0, 0.4); // a fifth above (E), quieter
    }

    // --- Sparse plucks on an A minor pentatonic scale. ---
    // Pentatonic (A C D E G) across two octaves for lonesome-western color.
    const scale = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    // Only pluck on a few select subdivisions, with a little randomness so the
    // loop doesn't feel mechanical.
    const pluckSlots = [0, 6, 10, 14];
    if (pluckSlots.includes(inBar) && Math.random() < 0.75) {
      const note = scale[Math.floor(Math.random() * scale.length)];
      this._pluck(time, note, 0.28);
    }
  }

  /**
   * Rhythmic stage bed. A steady bass pulse + hats always run; higher intensity
   * layers in a kick-driven backbeat, an offbeat stab, and busier hats.
   */
  _stagePattern(beat, time) {
    const bar = 16;
    const inBar = beat % bar;
    const I = this._intensity;

    // --- Bass pulse: root notes on the quarter-note grid, always present. ---
    if (inBar % 4 === 0) {
      // Simple 2-chord movement (i - VI) for tension.
      const roots = [55.0, 65.41]; // A1, C2
      const root = roots[(Math.floor(beat / bar) % 2)];
      this._bass(time, root, 0.34 + I * 0.15);
    }

    // --- Closed hats: eighths at low intensity, sixteenths when driving. ---
    const hatEvery = I > 0.5 ? 1 : 2;
    if (inBar % hatEvery === 0) {
      this._hat(time, 0.08 + I * 0.07);
    }

    // --- Kick backbeat: fades in with intensity. ---
    if (I > 0.2) {
      // Kick on beats 1 and 3 (grid slots 0 and 8), plus a driving 3-and.
      if (inBar === 0 || inBar === 8 || (I > 0.6 && inBar === 11)) {
        this._kick(time, 0.5 + I * 0.4);
      }
    }

    // --- Snare/clap on the backbeat (2 & 4) once things get intense. ---
    if (I > 0.35 && (inBar === 4 || inBar === 12)) {
      this._snare(time, 0.3 + I * 0.3);
    }

    // --- Urgent offbeat synth stab at high intensity. ---
    if (I > 0.55 && (inBar === 6 || inBar === 14)) {
      const stab = [220.0, 261.63][(Math.floor(beat / bar) % 2)];
      this._stab(time, stab, 0.18 + I * 0.12);
    }
  }

  // ---------------------------------------------------------------------------
  // Instruments (each builds short-lived nodes routed to the music bus)
  // ---------------------------------------------------------------------------

  /** Track a source for cleanup and auto-untrack when it ends. */
  _track(node) {
    this._voices.add(node);
    node.onended = () => {
      this._voices.delete(node);
      try { node.disconnect(); } catch (_) {}
    };
  }

  /** Long, soft sustained pad tone (the drone). */
  _drone(time, freq, dur, gain = 0.28) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    // Gentle detuned second oscillator for warmth.
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = freq * 1.005;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    lp.Q.value = 0.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(gain, time + 0.8);         // slow swell
    g.gain.linearRampToValueAtTime(0.0001, time + dur);        // slow fade

    o.connect(lp);
    o2.connect(lp);
    lp.connect(g).connect(this._bus);

    o.start(time); o2.start(time);
    o.stop(time + dur + 0.05); o2.stop(time + dur + 0.05);
    this._track(o2);
    // o2 is the tracked "last" voice; also stop o with it.
    o2.onended = () => {
      this._voices.delete(o2);
      try { o.disconnect(); } catch (_) {}
      try { o2.disconnect(); } catch (_) {}
      try { lp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Plucked, guitar-ish tone with a bright attack and quick-ish decay. */
  _pluck(time, freq, dur) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;

    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(3000, time);
    bp.frequency.exponentialRampToValueAtTime(700, time + dur); // pluck "twang"

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.3, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    o.connect(bp).connect(g).connect(this._bus);
    o.start(time);
    o.stop(time + dur + 0.05);
    this._track(o);
    o.onended = () => {
      this._voices.delete(o);
      try { o.disconnect(); } catch (_) {}
      try { bp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Punchy pitched bass note. */
  _bass(time, freq, gain) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.28);

    o.connect(lp).connect(g).connect(this._bus);
    o.start(time);
    o.stop(time + 0.32);
    this._track(o);
    o.onended = () => {
      this._voices.delete(o);
      try { o.disconnect(); } catch (_) {}
      try { lp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Deep kick drum: fast downward pitch sweep on a sine. */
  _kick(time, gain) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.12);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);

    o.connect(g).connect(this._bus);
    o.start(time);
    o.stop(time + 0.2);
    this._track(o);
    o.onended = () => {
      this._voices.delete(o);
      try { o.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Closed hi-hat: very short high-passed noise burst. */
  _hat(time, gain) {
    const ctx = this.engine.ctx;
    const src = this._noiseSource(ctx);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);

    src.connect(hp).connect(g).connect(this._bus);
    src.start(time);
    src.stop(time + 0.06);
    this._track(src);
    src.onended = () => {
      this._voices.delete(src);
      try { src.disconnect(); } catch (_) {}
      try { hp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Snare/clap: band-limited noise with a snappy envelope. */
  _snare(time, gain) {
    const ctx = this.engine.ctx;
    const src = this._noiseSource(ctx);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);

    src.connect(bp).connect(g).connect(this._bus);
    src.start(time);
    src.stop(time + 0.14);
    this._track(src);
    src.onended = () => {
      this._voices.delete(src);
      try { src.disconnect(); } catch (_) {}
      try { bp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  /** Bright synth stab for urgency at high intensity. */
  _stab(time, freq, gain) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.Q.value = 2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);

    o.connect(lp).connect(g).connect(this._bus);
    o.start(time);
    o.stop(time + 0.18);
    this._track(o);
    o.onended = () => {
      this._voices.delete(o);
      try { o.disconnect(); } catch (_) {}
      try { lp.disconnect(); } catch (_) {}
      try { g.disconnect(); } catch (_) {}
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a short white-noise buffer source (cached per context) for percussion.
   * @param {AudioContext} ctx
   * @returns {AudioBufferSourceNode}
   */
  _noiseSource(ctx) {
    if (!this._noiseBuffer || this._noiseBuffer.sampleRate !== ctx.sampleRate) {
      const len = Math.floor(ctx.sampleRate * 0.3); // 0.3s is plenty for hits
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuffer = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    return src;
  }

  /** @param {number} v @returns {number} clamped to [0,1], NaN -> 0. */
  _clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}
