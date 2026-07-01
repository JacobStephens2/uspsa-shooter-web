// src/audio/AudioEngine.js
//
// Central Web Audio host for "Practical Range".
//
// The AudioContext cannot be created (or, on many browsers, resumed) until a
// user gesture has occurred. AudioEngine encapsulates that lifecycle: every
// method is safe to call before unlock() and simply no-ops until the context
// exists. Sfx and Music both connect their output to `master`.
//
// Signal graph once unlocked:
//
//     [sfx/music sources] --> master (GainNode) --> ctx.destination
//
// The master gain also implements mute (by forcing gain to 0 while remembering
// the user's chosen volume) and a remembered master volume that survives across
// lock/unlock cycles.

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;
    /** @type {GainNode|null} */
    this._master = null;

    // Remembered user preferences. These are applied to the graph now (if it
    // exists) and re-applied every time the graph is (re)built in unlock().
    this._volume = 1.0;   // 0..1, the user's chosen master volume
    this._muted = false;  // when true the master gain is forced to 0

    // Guards against overlapping unlock() calls (unlock is async).
    this._unlocking = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Lazily create the AudioContext + master GainNode and resume the context.
   * Must be invoked from within a user-gesture handler (click/keydown/touch).
   * Idempotent: repeated calls just ensure the context is running.
   * Never throws — audio is a non-critical enhancement.
   * @returns {Promise<void>}
   */
  async unlock() {
    // Collapse concurrent unlock() calls into a single in-flight promise.
    if (this._unlocking) return this._unlocking;

    this._unlocking = (async () => {
      try {
        if (!this._ctx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return; // Web Audio unsupported; stay silent.

          this._ctx = new Ctx();

          // Build the master bus.
          this._master = this._ctx.createGain();
          this._master.connect(this._ctx.destination);
          this._applyGain(); // apply remembered volume / mute state
        }

        // A freshly created context (or one auto-suspended by the browser)
        // must be resumed. This is the part that genuinely needs the gesture.
        if (this._ctx.state === 'suspended') {
          await this._ctx.resume();
        }
      } catch (err) {
        // Swallow: never let audio setup break the game. Log once, quietly.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[AudioEngine] unlock failed:', err);
        }
      } finally {
        this._unlocking = null;
      }
    })();

    return this._unlocking;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** @returns {boolean} true once the context exists and is actively running. */
  get ready() {
    return !!this._ctx && this._ctx.state === 'running' && !!this._master;
  }

  /** @returns {AudioContext|null} */
  get ctx() {
    return this._ctx;
  }

  /** @returns {GainNode|null} the shared master bus everything connects to. */
  get master() {
    return this._master;
  }

  // ---------------------------------------------------------------------------
  // Volume / mute
  // ---------------------------------------------------------------------------

  /**
   * Set the master volume. Remembered so it also applies after a later unlock().
   * @param {number} v 0..1
   */
  setMasterVolume(v) {
    this._volume = this._clamp01(v);
    this._applyGain();
  }

  /** @returns {number} 0..1 */
  getMasterVolume() {
    return this._volume;
  }

  /**
   * Mute or unmute without losing the chosen volume.
   * @param {boolean} b
   */
  setMuted(b) {
    this._muted = !!b;
    this._applyGain();
  }

  /** @returns {boolean} */
  get muted() {
    return this._muted;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Push the remembered volume/mute state onto the live master gain (if any). */
  _applyGain() {
    if (!this._master || !this._ctx) return;
    const target = this._muted ? 0 : this._volume;
    const g = this._master.gain;
    const now = this._ctx.currentTime;
    // A short ramp avoids clicks when volume or mute changes mid-playback.
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + 0.02);
    } catch (_) {
      // Fallback for engines lacking full AudioParam scheduling.
      g.value = target;
    }
  }

  /** @param {number} v @returns {number} clamped to [0,1], NaN -> 0. */
  _clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}
